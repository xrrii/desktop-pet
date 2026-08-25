"""Managed Embedding 适配器；向官方数据面请求服务器本地模型。"""

from __future__ import annotations

import json
import base64
import binascii
import uuid
from typing import Any

import httpx

from ..managed.session import ManagedSessionStore
from .embeddings import EmbeddingDescriptor, EmbeddingProvider, _normalize, _validate_vectors


class ManagedEmbeddingError(RuntimeError):
    """Managed Embedding 稳定错误，不保留输入正文。"""

    def __init__(self, code: str) -> None:
        """保存稳定错误码。"""
        super().__init__(code)
        self.code = code


class ManagedEmbeddingProvider:
    """同步批量调用 Cloud Embedding 路由，供知识库索引线程使用。"""

    def __init__(
        self,
        base_url: str,
        client_version: str,
        device_id: str,
        session: ManagedSessionStore,
        descriptor_revision: str = "bge-base-zh-v1.5",
        dimensions: int = 768,
    ) -> None:
        """创建独立 HTTP 客户端，不接收 BYOK 凭据。"""
        self._url = f"{base_url.rstrip('/')}/ai/v1/embeddings"
        self._client_version = client_version
        self._device_id = device_id
        self._session = session
        self.descriptor = EmbeddingDescriptor(
            id="bge-base-zh-v1.5",
            revision=descriptor_revision,
            dimensions=dimensions,
            max_tokens=512,
            pooling="mean",
            normalize=True,
            query_prefix="为这个句子生成表示以用于检索：",
            document_prefix="",
            tokenizer_version=descriptor_revision,
            chunk_strategy_version="v2",
            candidate_min_similarity=0.45,
            final_min_similarity=0.62,
        )
        self._client = httpx.Client(timeout=httpx.Timeout(50.0, connect=10.0), follow_redirects=False)

    def health_check(self) -> None:
        """通过最小文本请求验证认证、能力和模型维度。"""
        self.embed_documents(["PetDock embedding health check"])

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """按输入顺序批量生成向量。"""
        return self._embed(texts)

    def embed_query(self, text: str) -> list[float]:
        """生成单条查询向量。"""
        return self._embed([text])[0]

    def count_tokens(self, text: str) -> int:
        """使用与 Cloud 一致的保守字符计数。"""
        return max(1, len(text))

    def close(self) -> None:
        """关闭 HTTP 客户端。"""
        self._client.close()

    def _embed(self, texts: list[str]) -> list[list[float]]:
        """执行一次不可自动重放的请求，避免重复扣费。"""
        lease = self._session.lease()
        if lease is None:
            raise ManagedEmbeddingError("managed_authentication_required")
        trace_id, request_id, attempt_id = (str(uuid.uuid4()) for _ in range(3))
        headers = {
            "Authorization": f"Bearer {lease.access_token}",
            "X-PetDock-Trace-Id": trace_id,
            "X-PetDock-Request-Id": request_id,
            "X-PetDock-Attempt-Id": attempt_id,
            "X-PetDock-Client-Version": self._client_version,
            # Runtime Session JWT 中的设备 Claim 才是控制面签发的有效设备标识。
            "X-PetDock-Device-Id": _device_id_from_token(lease.access_token, self._device_id),
            "Accept": "application/json",
        }
        payload = {
            "descriptorId": "embedding-standard",
            "input": texts,
        }
        try:
            response = self._client.post(self._url, headers=headers, json=payload)
        except httpx.TimeoutException as error:
            raise ManagedEmbeddingError("embedding_provider_timeout") from error
        except httpx.HTTPError as error:
            raise ManagedEmbeddingError("embedding_provider_unavailable") from error
        if response.status_code != 200:
            raise ManagedEmbeddingError(_response_error(response.content))
        try:
            body = response.json()
            if body.get("descriptorId") != "embedding-standard" or body.get("revision") != self.descriptor.revision:
                raise ValueError("Embedding Descriptor 不一致")
            vectors = [[float(value) for value in row] for row in body["vectors"]]
            _validate_vectors(vectors, self.descriptor.dimensions)
            if len(vectors) != len(texts):
                raise ValueError("Embedding 数量不一致")
            return [_normalize(vector) for vector in vectors]
        except (ValueError, TypeError, KeyError, IndexError, json.JSONDecodeError) as error:
            raise ManagedEmbeddingError("embedding_provider_invalid_response") from error


def _response_error(body: bytes) -> str:
    """将 Cloud ErrorEnvelope 映射为本地稳定错误。"""
    try:
        payload: Any = json.loads(body)
        code = payload.get("error", {}).get("code")
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
        code = None
    return {
        "authentication_required": "managed_authentication_required",
        "token_expired": "managed_authentication_required",
        "capability_not_entitled": "managed_capability_not_entitled",
        "quota_exhausted": "managed_quota_exhausted",
        "provider_timeout": "embedding_provider_timeout",
    }.get(code, "embedding_provider_unavailable")


def _device_id_from_token(token: str, fallback: str) -> str:
    """读取已由 Main 注入的 JWT 设备 Claim；解析失败时使用启动配置。"""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return fallback
        padding = "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + padding))
        value = claims.get("device_id") if isinstance(claims, dict) else None
        if isinstance(value, str):
            uuid.UUID(value)
            return value
    except (IndexError, ValueError, TypeError, binascii.Error, json.JSONDecodeError):
        pass
    return fallback
