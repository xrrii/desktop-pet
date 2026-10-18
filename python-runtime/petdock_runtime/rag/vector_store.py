from __future__ import annotations

import hashlib
import logging
import math
from pathlib import Path
from typing import Any, Callable

import chromadb
from chromadb.config import Settings

from ..providers.embeddings import (
    EmbeddingProvider,
    LocalHashEmbedding,
    check_embedding_pause,
    embedding_batch_ranges,
)

"""按 Embedding Profile 隔离的公共 Chroma 向量存储。"""

DEFAULT_VECTOR_CANDIDATES = 40
LOGGER = logging.getLogger(__name__)


def _create_embedded_client(path: str) -> Any:
    """只创建本地嵌入式 Chroma 客户端，禁止引入 HTTP Server 或远程客户端。"""
    settings = Settings(anonymized_telemetry=False)
    if path == ":memory:":
        LOGGER.info("初始化本地 Chroma 向量存储 mode=memory")
        return chromadb.EphemeralClient(settings=settings)

    Path(path).mkdir(parents=True, exist_ok=True)
    LOGGER.info("初始化本地 Chroma 向量存储 mode=persistent")
    return chromadb.PersistentClient(path=path, settings=settings)


class ChromaVectorStore:
    """封装按 Embedding 签名隔离的 Chroma 持久化 API。"""

    def __init__(
        self,
        path: str,
        embedding: EmbeddingProvider,
        collection_name: str | None = None,
    ) -> None:
        """打开本地 Chroma，并创建对应向量空间的 collection。"""
        self.embedding = embedding
        self.descriptor = embedding.descriptor
        self._client = _create_embedded_client(path)
        legacy_hash = self.descriptor.id == LocalHashEmbedding.name
        resolved_name = collection_name or (
            "petdock_knowledge_v1"
            if legacy_hash
            else f"petdock_knowledge_{self.descriptor.signature}"
        )
        self._collection = self._client.get_or_create_collection(
            name=resolved_name,
            metadata={
                "hnsw:space": "cosine",
                "embeddingModel": self.descriptor.id,
                "embeddingRevision": self.descriptor.revision,
                "dimensions": self.descriptor.dimensions,
                "indexSignature": self.descriptor.signature,
            },
        )

    @property
    def count(self) -> int:
        """返回当前向量空间中的 Chunk 数。"""
        return int(self._collection.count())

    def upsert(
        self, records: list[dict[str, Any]], *, reuse_existing: bool = False,
        should_stop: Callable[[], bool] | None = None,
    ) -> None:
        """逐推理批次持久化；补建可复用当前空间内正文摘要与归属都一致的向量。"""
        reused = 0
        for offset in range(0, len(records), 128):
            check_embedding_pause(should_stop)
            page = records[offset : offset + 128]
            if reuse_existing:
                page = self._missing_records(page)
                reused += min(128, len(records) - offset) - len(page)
            texts = [str(item["content"]) for item in page]
            for start, end in embedding_batch_ranges(self.embedding, texts):
                check_embedding_pause(should_stop)
                batch = page[start:end]
                controlled_embed = getattr(self.embedding, "embed_documents_cancellable", None)
                embeddings = (
                    controlled_embed(texts[start:end], should_stop)
                    if should_stop is not None and callable(controlled_embed)
                    else self.embedding.embed_documents(texts[start:end])
                )
                # 一个网络批次成功就立刻落入 Chroma；后续超时不会丢弃此前的完整结果。
                self._collection.upsert(
                    ids=[str(item["id"]) for item in batch],
                    embeddings=embeddings,
                    metadatas=[self._record_metadata(item) for item in batch],
                )
                # 已发出的批次完整返回后先落库，再响应暂停，避免用户继续时重复计量。
                check_embedding_pause(should_stop)
        if reused:
            LOGGER.info("向量补建复用已持久化片段 reusedChunks=%s totalChunks=%s", reused, len(records))

    def _missing_records(self, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """只读取当前 collection 的最小元数据，旧版无内容摘要的记录保守重算。"""
        existing = self._collection.get(ids=[str(item["id"]) for item in records], include=["metadatas"])
        metadata = dict(zip(existing["ids"], existing["metadatas"], strict=True))
        return [item for item in records if metadata.get(str(item["id"])) != self._record_metadata(item)]

    @staticmethod
    def _record_metadata(item: dict[str, Any]) -> dict[str, str]:
        """保存归属与内容摘要用于补建校验，不向元数据或日志复制正文。"""
        return {
            "libraryId": str(item["libraryId"]),
            "documentId": str(item["documentId"]),
            "contentHash": hashlib.sha256(str(item["content"]).encode("utf-8")).hexdigest(),
        }

    def delete_ids(self, ids: list[str]) -> None:
        """删除已失效分块；空列表不会调用 Chroma。"""
        for offset in range(0, len(ids), 500):
            batch = ids[offset : offset + 500]
            if batch:
                self._collection.delete(ids=batch)

    def delete_library(self, library_id: str) -> None:
        """按业务资料集 ID 删除当前向量空间的全部派生向量。"""
        self._collection.delete(where={"libraryId": library_id})

    def search(
        self,
        query: str,
        library_ids: list[str],
        limit: int = DEFAULT_VECTOR_CANDIDATES,
    ) -> list[tuple[str, float]]:
        """执行 ANN 查询，返回 Chunk ID 和余弦相似度。"""
        if not query.strip() or not library_ids or self.count == 0:
            return []
        return self.search_embedding(self.embedding.embed_query(query), library_ids, limit)

    def search_embedding(
        self,
        query_embedding: list[float],
        library_ids: list[str],
        limit: int = DEFAULT_VECTOR_CANDIDATES,
    ) -> list[tuple[str, float]]:
        """使用已生成的查询向量执行 ANN，供多资料集检索复用同一次推理。"""
        if not query_embedding or not library_ids or self.count == 0:
            return []
        where: dict[str, Any]
        if len(library_ids) == 1:
            where = {"libraryId": library_ids[0]}
        else:
            where = {"libraryId": {"$in": library_ids}}
        result = self._collection.query(
            query_embeddings=[query_embedding],
            n_results=max(1, min(limit, 200, self.count)),
            where=where,
            include=["distances"],
        )
        ids = result.get("ids") or [[]]
        distances = result.get("distances") or [[]]
        hits: list[tuple[str, float]] = []
        for chunk_id, distance in zip(ids[0], distances[0], strict=False):
            similarity = 1.0 - float(distance)
            if math.isfinite(similarity) and similarity >= self.descriptor.candidate_min_similarity:
                hits.append((str(chunk_id), similarity))
        return hits
