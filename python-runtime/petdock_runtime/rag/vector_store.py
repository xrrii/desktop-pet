from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import chromadb
from chromadb.config import Settings

from ..providers.embeddings import EmbeddingProvider, LocalHashEmbedding

"""按 Embedding Profile 隔离的公共 Chroma 向量存储。"""

DEFAULT_VECTOR_CANDIDATES = 40


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
        if path == ":memory:":
            self._client = chromadb.EphemeralClient(settings=Settings(anonymized_telemetry=False))
        else:
            Path(path).mkdir(parents=True, exist_ok=True)
            self._client = chromadb.PersistentClient(
                path=path,
                settings=Settings(anonymized_telemetry=False),
            )
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

    def upsert(self, records: list[dict[str, Any]]) -> None:
        """分批写入向量和最小检索元数据，原文仍由 SQLite 持有。"""
        for offset in range(0, len(records), 128):
            batch = records[offset : offset + 128]
            if not batch:
                continue
            self._collection.upsert(
                ids=[str(item["id"]) for item in batch],
                embeddings=self.embedding.embed_documents([str(item["content"]) for item in batch]),
                metadatas=[
                    {
                        "libraryId": str(item["libraryId"]),
                        "documentId": str(item["documentId"]),
                    }
                    for item in batch
                ],
            )

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
