from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

from .config import RuntimeConfig

"""本地、在线和 Hash Embedding Provider。"""

PoolingMode = Literal["cls", "mean"]


@dataclass(frozen=True)
class EmbeddingDescriptor:
    """描述一个可独立建立向量空间的 Embedding 配置。"""

    id: str
    revision: str
    dimensions: int
    max_tokens: int
    pooling: PoolingMode
    normalize: bool
    query_prefix: str
    document_prefix: str
    tokenizer_version: str
    chunk_strategy_version: str
    candidate_min_similarity: float
    final_min_similarity: float

    @property
    def signature(self) -> str:
        """根据会影响向量空间的配置生成短签名。"""
        payload = json.dumps(
            {
                "id": self.id,
                "revision": self.revision,
                "dimensions": self.dimensions,
                "maxTokens": self.max_tokens,
                "pooling": self.pooling,
                "normalize": self.normalize,
                "queryPrefix": self.query_prefix,
                "documentPrefix": self.document_prefix,
                "tokenizerVersion": self.tokenizer_version,
                "chunkStrategyVersion": self.chunk_strategy_version,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


class EmbeddingProvider(Protocol):
    """统一约束所有可写入 Chroma 的向量模型。"""

    descriptor: EmbeddingDescriptor

    def health_check(self) -> None:
        """验证模型可以产生维度正确的有限向量。"""
        ...

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """批量生成文档向量。"""
        ...

    def embed_query(self, text: str) -> list[float]:
        """生成查询向量。"""
        ...

    def count_tokens(self, text: str) -> int:
        """返回 Chunk 边界判断使用的 Token 数。"""
        ...


class LocalHashEmbedding:
    """把中英文词元映射为固定维度向量，提供零下载离线降级。"""

    name = "petdock-local-hash-v1"

    def __init__(self, dimensions: int = 384) -> None:
        """设置向量维度；维度过小会显著增加哈希碰撞。"""
        if dimensions < 64:
            raise ValueError("Embedding dimensions must be at least 64.")
        self.dimensions = dimensions
        self.descriptor = EmbeddingDescriptor(
            id=self.name,
            revision="1",
            dimensions=dimensions,
            max_tokens=512,
            pooling="mean",
            normalize=True,
            query_prefix="",
            document_prefix="",
            tokenizer_version="hash-v1",
            chunk_strategy_version="v2",
            candidate_min_similarity=0.16,
            final_min_similarity=0.24,
        )

    def health_check(self) -> None:
        """验证 Hash Provider 的维度和归一化结果。"""
        vector = self.embed_query("PetDock 健康检查")
        _validate_vectors([vector], self.dimensions)

    def embed(self, texts: list[str]) -> list[list[float]]:
        """兼容阶段 4 接口，按文档方式批量生成向量。"""
        return self.embed_documents(texts)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """批量生成归一化文档向量。"""
        return [self._embed_one(text) for text in texts]

    def embed_query(self, text: str) -> list[float]:
        """生成归一化查询向量。"""
        return self._embed_one(text)

    def count_tokens(self, text: str) -> int:
        """使用中英文混合的保守规则估算 Token 数。"""
        chinese = len(re.findall(r"[\u4e00-\u9fff]", text))
        words = len(re.findall(r"[a-zA-Z0-9_./:#-]+", text))
        punctuation = len(re.findall(r"[^\w\s\u4e00-\u9fff]", text))
        return max(1, chinese + words + math.ceil(punctuation / 2))

    def _embed_one(self, text: str) -> list[float]:
        """组合英文词、中文单字和中文二元组生成稳定向量。"""
        vector = [0.0] * self.dimensions
        for token in _hash_tokens(text):
            digest = hashlib.blake2b(token.encode("utf-8", errors="replace"), digest_size=8).digest()
            value = int.from_bytes(digest, "little", signed=False)
            index = value % self.dimensions
            sign = 1.0 if value & (1 << 63) else -1.0
            vector[index] += sign
        return _normalize(vector)


class OnnxLocalEmbeddingProvider:
    """使用白名单目录中的 Tokenizer 和 ONNX INT8 模型生成向量。"""

    def __init__(self, model_dir: str, descriptor: EmbeddingDescriptor) -> None:
        """加载固定模型文件，并延迟到健康检查验证推理输出。"""
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.descriptor = descriptor
        root = Path(model_dir).resolve(strict=True)
        self._tokenizer = Tokenizer.from_file(str(root / "tokenizer.json"))
        self._tokenizer.enable_truncation(max_length=descriptor.max_tokens)
        pad_token, pad_id = _resolve_padding(self._tokenizer)
        self._tokenizer.enable_padding(pad_id=pad_id, pad_token=pad_token)
        self._session = ort.InferenceSession(
            str(root / "model.onnx"),
            providers=["CPUExecutionProvider"],
        )
        self._input_names = tuple(item.name for item in self._session.get_inputs())

    def health_check(self) -> None:
        """执行最小推理，验证维度、有限值和归一化。"""
        _validate_vectors(self.embed_documents(["PetDock 本地向量模型健康检查"]), self.descriptor.dimensions)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """添加文档前缀并分批执行 ONNX 推理。"""
        return self._embed([self.descriptor.document_prefix + text for text in texts])

    def embed_query(self, text: str) -> list[float]:
        """添加查询前缀并执行 ONNX 推理。"""
        return self._embed([self.descriptor.query_prefix + text])[0]

    def count_tokens(self, text: str) -> int:
        """使用模型自身 Tokenizer 计算 Chunk 长度。"""
        return len(self._tokenizer.encode(text, add_special_tokens=True).ids)

    def _embed(self, texts: list[str]) -> list[list[float]]:
        """执行动态 Batch 推理，并按清单指定方式池化。"""
        import numpy as np

        if not texts:
            return []
        results: list[list[float]] = []
        for offset in range(0, len(texts), 32):
            encoded = self._tokenizer.encode_batch(texts[offset : offset + 32])
            arrays = {
                "input_ids": np.asarray([item.ids for item in encoded], dtype=np.int64),
                "attention_mask": np.asarray([item.attention_mask for item in encoded], dtype=np.int64),
                "token_type_ids": np.asarray([item.type_ids for item in encoded], dtype=np.int64),
            }
            inputs = {name: arrays[name] for name in self._input_names if name in arrays}
            hidden = self._session.run(None, inputs)[0]
            if self.descriptor.pooling == "cls":
                pooled = hidden[:, 0, :]
            else:
                mask = arrays["attention_mask"][..., None]
                pooled = (hidden * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1)
            if self.descriptor.normalize:
                norms = np.linalg.norm(pooled, axis=1, keepdims=True)
                pooled = pooled / np.maximum(norms, 1e-12)
            results.extend([[float(value) for value in row] for row in pooled])
        _validate_vectors(results, self.descriptor.dimensions)
        return results


class OpenAICompatibleEmbeddingProvider:
    """调用 OpenAI-compatible `/embeddings` 接口生成在线向量。"""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        dimensions: int,
    ) -> None:
        """保存在线端点，并生成独立向量空间描述。"""
        import httpx

        if not api_key or not base_url or not model or dimensions < 64:
            raise ValueError("在线 Embedding 配置不完整。")
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=30.0,
        )
        self._model = model
        self.descriptor = EmbeddingDescriptor(
            id=f"openai-compatible:{model}",
            revision="remote",
            dimensions=dimensions,
            max_tokens=512,
            pooling="mean",
            normalize=True,
            query_prefix="",
            document_prefix="",
            tokenizer_version="remote",
            chunk_strategy_version="v2",
            candidate_min_similarity=0.45,
            final_min_similarity=0.62,
        )

    def health_check(self) -> None:
        """发送最小查询验证在线端点和维度。"""
        _validate_vectors(self.embed_documents(["PetDock embedding health check"]), self.descriptor.dimensions)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """按输入顺序批量调用在线 Embedding 接口。"""
        if not texts:
            return []
        response = self._client.post(
            "embeddings",
            json={"model": self._model, "input": texts},
        )
        response.raise_for_status()
        payload = response.json()
        rows = sorted(payload.get("data", []), key=lambda item: int(item.get("index", 0)))
        vectors = [[float(value) for value in item["embedding"]] for item in rows]
        vectors = [_normalize(vector) for vector in vectors]
        _validate_vectors(vectors, self.descriptor.dimensions)
        if len(vectors) != len(texts):
            raise ValueError("在线 Embedding 返回数量与请求不一致。")
        return vectors

    def embed_query(self, text: str) -> list[float]:
        """生成单条在线查询向量。"""
        return self.embed_documents([text])[0]

    def count_tokens(self, text: str) -> int:
        """在线模型无本地 Tokenizer 时使用保守估算。"""
        return LocalHashEmbedding().count_tokens(text)


def descriptor_from_dict(value: dict[str, object]) -> EmbeddingDescriptor:
    """把 Main 传入的白名单推理配置转换为强类型描述。"""
    return EmbeddingDescriptor(
        id=str(value["id"]),
        revision=str(value["revision"]),
        dimensions=int(value["dimensions"]),
        max_tokens=int(value.get("maxTokens", 512)),
        pooling=str(value["pooling"]),  # type: ignore[arg-type]
        normalize=bool(value.get("normalize", True)),
        query_prefix=str(value.get("queryPrefix", "")),
        document_prefix=str(value.get("documentPrefix", "")),
        tokenizer_version=str(value.get("tokenizerVersion", value["revision"])),
        chunk_strategy_version=str(value.get("chunkStrategyVersion", "v2")),
        candidate_min_similarity=float(value.get("candidateMinSimilarity", 0.45)),
        final_min_similarity=float(value.get("finalMinSimilarity", 0.62)),
    )


def create_embedding_provider(config: RuntimeConfig) -> EmbeddingProvider:
    """根据已校验的 Runtime 配置创建活动 Embedding Provider。"""
    if config.embedding_provider == "hash":
        provider: EmbeddingProvider = LocalHashEmbedding()
    elif config.embedding_provider == "local":
        if not config.embedding_model_dir or not config.embedding_descriptor_json:
            raise ValueError("本地 Embedding 配置不完整。")
        descriptor_value = json.loads(config.embedding_descriptor_json)
        if not isinstance(descriptor_value, dict):
            raise ValueError("本地 Embedding descriptor 必须是 JSON 对象。")
        provider = OnnxLocalEmbeddingProvider(
            config.embedding_model_dir,
            descriptor_from_dict(descriptor_value),
        )
    else:
        if not all(
            (
                config.embedding_api_key,
                config.embedding_base_url,
                config.embedding_model,
                config.embedding_dimensions,
            )
        ):
            raise ValueError("在线 Embedding 配置不完整。")
        provider = OpenAICompatibleEmbeddingProvider(
            api_key=str(config.embedding_api_key),
            base_url=str(config.embedding_base_url),
            model=str(config.embedding_model),
            dimensions=int(config.embedding_dimensions),
        )
    provider.health_check()
    return provider


def _hash_tokens(text: str) -> list[str]:
    """提取适用于中文资料与代码标识符的稳定 Hash 词元。"""
    lowered = text.casefold()
    words = re.findall(r"[a-z0-9_./:#-]{2,}|[\u4e00-\u9fff]", lowered)
    chinese = "".join(re.findall(r"[\u4e00-\u9fff]", lowered))
    bigrams = [chinese[index : index + 2] for index in range(max(0, len(chinese) - 1))]
    return words + bigrams


def _normalize(vector: list[float]) -> list[float]:
    """对普通列表执行 L2 归一化。"""
    norm = math.sqrt(sum(item * item for item in vector))
    if norm == 0:
        return vector
    return [item / norm for item in vector]


def _validate_vectors(vectors: list[list[float]], dimensions: int) -> None:
    """拒绝数量、维度或数值异常的模型输出。"""
    if not vectors:
        raise ValueError("Embedding 模型没有返回向量。")
    for vector in vectors:
        if len(vector) != dimensions or any(not math.isfinite(value) for value in vector):
            raise ValueError("Embedding 模型返回了无效向量。")


def _resolve_padding(tokenizer) -> tuple[str, int]:
    """从 Tokenizer 词表解析常见 Padding Token。"""
    for token in ("[PAD]", "<pad>"):
        token_id = tokenizer.token_to_id(token)
        if token_id is not None:
            return token, int(token_id)
    raise ValueError("本地向量模型 Tokenizer 缺少 Padding Token。")
