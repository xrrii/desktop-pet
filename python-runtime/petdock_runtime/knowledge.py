from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import chromadb
from chromadb.config import Settings

from .embeddings import LocalHashEmbedding
from .knowledge_store import KnowledgeStore

"""知识库索引任务、Chroma 向量适配器和混合检索。"""

LOGGER = logging.getLogger("petdock.knowledge")
SUPPORTED_EXTENSIONS = {
    ".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini",
    ".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".kt", ".kts", ".xml",
    ".html", ".css", ".scss", ".sql", ".ps1", ".sh",
}
EXCLUDED_DIRECTORIES = {
    ".git", ".svn", ".hg", ".idea", ".vscode", ".venv", "venv", "node_modules",
    "dist", "build", "release", "coverage", "__pycache__", ".pytest_cache", ".gradle",
}
SENSITIVE_NAMES = re.compile(
    r"(^|[._-])(\.env|id_rsa|id_ed25519|credentials?|secrets?|tokens?|passwords?)([._-]|$)|\.(pem|pfx|p12|key)$",
    re.IGNORECASE,
)
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_FILES_PER_LIBRARY = 5_000
CHUNK_CHARACTERS = 2_800
CHUNK_OVERLAP = 280


@dataclass(frozen=True)
class RetrievalSource:
    """表示一条可注入模型并返回 UI 的知识库命中。"""

    id: str
    library_id: str
    library_name: str
    title: str
    relative_path: str
    content: str
    score: float

    def public(self) -> dict[str, Any]:
        """返回不含绝对路径的引用摘要。"""
        compact = re.sub(r"\s+", " ", self.content).strip()
        return {
            "id": self.id,
            "libraryId": self.library_id,
            "libraryName": self.library_name,
            "title": self.title,
            "relativePath": self.relative_path,
            "excerpt": compact[:360],
            "score": round(self.score, 6),
        }


class ChromaVectorStore:
    """封装 Chroma 持久化 API，使业务层不依赖具体向量库。"""

    def __init__(self, path: str, embedding: LocalHashEmbedding) -> None:
        """打开本地 Chroma，并使用余弦距离创建版本化 collection。"""
        self._embedding = embedding
        if path == ":memory:":
            self._client = chromadb.EphemeralClient(
                settings=Settings(anonymized_telemetry=False),
            )
        else:
            Path(path).mkdir(parents=True, exist_ok=True)
            self._client = chromadb.PersistentClient(
                path=path,
                settings=Settings(anonymized_telemetry=False),
            )
        self._collection = self._client.get_or_create_collection(
            name="petdock_knowledge_v1",
            metadata={
                "hnsw:space": "cosine",
                "embeddingModel": embedding.name,
                "dimensions": embedding.dimensions,
            },
        )

    def upsert(self, records: list[dict[str, Any]]) -> None:
        """分批写入向量和最小检索元数据，原文仍由 SQLite 持有。"""
        for offset in range(0, len(records), 128):
            batch = records[offset : offset + 128]
            if not batch:
                continue
            self._collection.upsert(
                ids=[str(item["id"]) for item in batch],
                embeddings=self._embedding.embed([str(item["content"]) for item in batch]),
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
        """按知识库 ID 删除全部可重建向量。"""
        self._collection.delete(where={"libraryId": library_id})

    def search(self, query: str, library_ids: list[str], limit: int = 12) -> list[tuple[str, float]]:
        """执行带知识库过滤的 ANN 查询，返回 chunk ID 和余弦距离。"""
        if not query.strip() or not library_ids or self._collection.count() == 0:
            return []
        where: dict[str, Any]
        if len(library_ids) == 1:
            where = {"libraryId": library_ids[0]}
        else:
            where = {"libraryId": {"$in": library_ids}}
        result = self._collection.query(
            query_embeddings=self._embedding.embed([query]),
            n_results=max(1, min(limit, 50)),
            where=where,
            include=["distances"],
        )
        ids = result.get("ids") or [[]]
        distances = result.get("distances") or [[]]
        return [
            (str(chunk_id), float(distance))
            for chunk_id, distance in zip(ids[0], distances[0], strict=False)
            if float(distance) < 0.92
        ]


@dataclass
class _IndexControl:
    """保存跨线程可见的暂停信号。"""

    stop: threading.Event


class KnowledgeService:
    """管理知识库生命周期、后台增量索引和混合召回。"""

    def __init__(self, store: KnowledgeStore, vectors: ChromaVectorStore) -> None:
        """绑定 SQLite 主存储与 Chroma 派生索引。"""
        self.store = store
        self.vectors = vectors
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._controls: dict[str, _IndexControl] = {}

    async def create_library(self, name: str, path: str) -> dict[str, Any]:
        """创建目录知识库，并立即启动首次索引。"""
        library = await asyncio.to_thread(self.store.create_library, name, path)
        await self.start_index(str(library["id"]))
        return self.store.get_library(str(library["id"]))

    async def start_index(self, library_id: str) -> bool:
        """启动或恢复一个索引任务；同一知识库同一时间只允许一个任务。"""
        current = self._tasks.get(library_id)
        if current and not current.done():
            return False
        self.store.get_library(library_id)
        control = _IndexControl(threading.Event())
        self._controls[library_id] = control
        self.store.set_progress(library_id, "indexing", error=None)
        task = asyncio.create_task(asyncio.to_thread(self._index_sync, library_id, control))
        self._tasks[library_id] = task
        task.add_done_callback(lambda completed, item_id=library_id: self._finish_task(item_id, completed))
        return True

    async def pause_index(self, library_id: str) -> bool:
        """请求暂停并等待当前文件处理结束，保证状态已落库后再返回。"""
        task = self._tasks.get(library_id)
        control = self._controls.get(library_id)
        if not task or task.done() or not control:
            self.store.get_library(library_id)
            return False
        control.stop.set()
        await asyncio.shield(task)
        return True

    async def delete_library(self, library_id: str) -> bool:
        """停止索引并删除 SQLite/Chroma 数据，但绝不触碰来源目录。"""
        task = self._tasks.get(library_id)
        control = self._controls.get(library_id)
        if task and not task.done() and control:
            control.stop.set()
            await asyncio.shield(task)
        await asyncio.to_thread(self.vectors.delete_library, library_id)
        return await asyncio.to_thread(self.store.delete_library, library_id)

    async def search(self, query: str, library_ids: list[str], limit: int = 5) -> list[RetrievalSource]:
        """在工作线程中执行向量与 FTS5 召回并用 RRF 融合。"""
        return await asyncio.to_thread(self._search_sync, query, library_ids, limit)

    async def close(self) -> None:
        """暂停全部后台任务并关闭 SQLite。"""
        pending: list[asyncio.Task[None]] = []
        for library_id, task in self._tasks.items():
            if task.done():
                continue
            control = self._controls.get(library_id)
            if control:
                control.stop.set()
            pending.append(task)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self.store.close()

    def _finish_task(self, library_id: str, task: asyncio.Task[None]) -> None:
        """清理已完成任务引用，并记录未被索引器处理的异常。"""
        if self._tasks.get(library_id) is task:
            self._tasks.pop(library_id, None)
            self._controls.pop(library_id, None)
        if task.cancelled():
            return
        error = task.exception()
        if error:
            LOGGER.exception("知识库索引任务异常", exc_info=error)

    def _index_sync(self, library_id: str, control: _IndexControl) -> None:
        """在线程中扫描、增量切分并同步 Chroma，避免阻塞 FastAPI 事件循环。"""
        try:
            root = self.store.source_path(library_id).resolve(strict=True)
            files = _scan_files(root, control.stop)
            if control.stop.is_set():
                self.store.set_progress(library_id, "paused")
                return
            self.store.set_progress(library_id, "indexing", 0, len(files))
            existing_paths: set[str] = set()
            for processed, path in enumerate(files, start=1):
                if control.stop.is_set():
                    self.store.set_progress(library_id, "paused", processed - 1, len(files))
                    return
                relative_path = path.relative_to(root).as_posix()
                existing_paths.add(relative_path)
                stat = path.stat()
                state = self.store.document_state(library_id, relative_path)
                if (
                    state
                    and int(state["modified_ns"]) == stat.st_mtime_ns
                    and int(state["size_bytes"]) == stat.st_size
                ):
                    if state["embedding_state"] != "ready":
                        records = self.store.document_chunks(str(state["id"]))
                        self.vectors.upsert(records)
                        self.store.mark_document_ready(str(state["id"]))
                    self.store.set_progress(library_id, "indexing", processed, len(files))
                    continue

                try:
                    content = path.read_text(encoding="utf-8-sig")
                except UnicodeDecodeError:
                    LOGGER.warning("跳过非 UTF-8 文件 library=%s path=%s", library_id, relative_path)
                    self.store.set_progress(library_id, "indexing", processed, len(files))
                    continue
                content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
                chunks = _split_document(content)
                old_ids, records, document_id = self.store.replace_document(
                    library_id,
                    relative_path,
                    stat.st_mtime_ns,
                    stat.st_size,
                    content_hash,
                    chunks,
                )
                self.vectors.delete_ids(old_ids)
                self.vectors.upsert(records)
                self.store.mark_document_ready(document_id)
                self.store.set_progress(library_id, "indexing", processed, len(files))

            removed_ids = self.store.remove_missing_documents(library_id, existing_paths)
            self.vectors.delete_ids(removed_ids)
            self.store.finish_index(library_id)
            LOGGER.info("知识库索引完成 library=%s files=%s", library_id, len(files))
        except Exception as error:
            LOGGER.exception("知识库索引失败 library=%s", library_id)
            try:
                self.store.set_progress(library_id, "error", error=str(error) or error.__class__.__name__)
            except Exception:
                LOGGER.exception("知识库失败状态写入失败 library=%s", library_id)

    def _search_sync(self, query: str, library_ids: list[str], limit: int) -> list[RetrievalSource]:
        """使用 RRF 合并向量与关键词候选，并从 SQLite 回取可信原文。"""
        ready_ids: list[str] = []
        for library_id in library_ids[:20]:
            try:
                if self.store.get_library(library_id)["status"] == "ready":
                    ready_ids.append(library_id)
            except KeyError:
                # 设置与删除操作可能短暂交错；失效 ID 不应让整轮聊天失败。
                continue
        if not ready_ids:
            return []
        vector_hits = self.vectors.search(query, ready_ids, 16)
        lexical_hits = self.store.lexical_search(query, ready_ids, 16)
        scores: dict[str, float] = {}
        for rank, (chunk_id, distance) in enumerate(vector_hits, start=1):
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (60 + rank) + (1.0 - distance) * 0.01
        for rank, chunk_id in enumerate(lexical_hits, start=1):
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (60 + rank)
        ranked_ids = sorted(scores, key=scores.get, reverse=True)[: max(1, min(limit, 10))]
        records = self.store.chunk_by_ids(ranked_ids)
        return [
            RetrievalSource(
                id=chunk_id,
                library_id=str(records[chunk_id]["libraryId"]),
                library_name=str(records[chunk_id]["libraryName"]),
                title=str(records[chunk_id]["title"]),
                relative_path=str(records[chunk_id]["relativePath"]),
                content=str(records[chunk_id]["content"]),
                score=scores[chunk_id],
            )
            for chunk_id in ranked_ids
            if chunk_id in records
        ]


def _scan_files(root: Path, stop: threading.Event) -> list[Path]:
    """只扫描授权根目录内的文本文件，并排除构建目录、链接和敏感文件。"""
    files: list[Path] = []
    for current_root, directories, names in os.walk(root, followlinks=False):
        if stop.is_set():
            break
        current = Path(current_root)
        directories[:] = [
            name
            for name in directories
            if name.casefold() not in EXCLUDED_DIRECTORIES
            and not name.startswith(".")
            and not (current / name).is_symlink()
        ]
        for name in names:
            if len(files) >= MAX_FILES_PER_LIBRARY:
                return sorted(files)
            path = current / name
            if path.is_symlink() or path.suffix.casefold() not in SUPPORTED_EXTENSIONS:
                continue
            if SENSITIVE_NAMES.search(name) or name.startswith("."):
                continue
            try:
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(root) or resolved.stat().st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            files.append(resolved)
    return sorted(files)


def _split_document(content: str) -> list[str]:
    """按段落聚合固定上限分块，并保留少量重叠上下文。"""
    normalized = content.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", normalized) if part.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if len(paragraph) > CHUNK_CHARACTERS:
            if current:
                chunks.append(current)
                current = ""
            start = 0
            while start < len(paragraph):
                chunks.append(paragraph[start : start + CHUNK_CHARACTERS])
                start += CHUNK_CHARACTERS - CHUNK_OVERLAP
            continue
        candidate = f"{current}\n\n{paragraph}" if current else paragraph
        if len(candidate) <= CHUNK_CHARACTERS:
            current = candidate
            continue
        chunks.append(current)
        overlap = current[-CHUNK_OVERLAP:] if len(current) > CHUNK_OVERLAP else current
        current = f"{overlap}\n\n{paragraph}".strip()
    if current:
        chunks.append(current)
    return chunks
