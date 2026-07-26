from __future__ import annotations

import hashlib
import math
import re

"""知识库 embedding 实现。

当前默认实现完全在本地运行，避免用户仅添加知识库就把全文发送到云端。
接口保持独立，后续可以接入 OpenAI-compatible 或本地 ONNX embedding 模型。
"""


class LocalHashEmbedding:
    """把中英文词元映射为固定维度向量，提供零下载的离线检索基线。"""

    name = "petdock-local-hash-v1"

    def __init__(self, dimensions: int = 384) -> None:
        """设置向量维度；维度过小会显著增加哈希碰撞。"""
        if dimensions < 64:
            raise ValueError("Embedding dimensions must be at least 64.")
        self.dimensions = dimensions

    def embed(self, texts: list[str]) -> list[list[float]]:
        """批量生成归一化向量，供 Chroma 写入和查询。"""
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        """组合英文词、中文单字和中文二元组，兼顾精确词与局部语义。"""
        vector = [0.0] * self.dimensions
        for token in _tokens(text):
            digest = hashlib.blake2b(token.encode("utf-8", errors="replace"), digest_size=8).digest()
            value = int.from_bytes(digest, "little", signed=False)
            index = value % self.dimensions
            sign = 1.0 if value & (1 << 63) else -1.0
            vector[index] += sign
        norm = math.sqrt(sum(item * item for item in vector))
        if norm == 0:
            return vector
        return [item / norm for item in vector]


def _tokens(text: str) -> list[str]:
    """提取适用于中文资料与代码标识符的稳定词元。"""
    lowered = text.casefold()
    words = re.findall(r"[a-z0-9_./:#-]{2,}|[\u4e00-\u9fff]", lowered)
    chinese = "".join(re.findall(r"[\u4e00-\u9fff]", lowered))
    bigrams = [chinese[index : index + 2] for index in range(max(0, len(chinese) - 1))]
    return words + bigrams
