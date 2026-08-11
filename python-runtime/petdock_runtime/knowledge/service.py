from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..documents.chunking import (
    CHUNK_STRATEGY_VERSION,
    split_document,
)
from ..documents.parser import DocumentParseError, DocumentParserRegistry
from ..providers.embeddings import EmbeddingProvider
from ..rag.planner import retrieval_query_terms, retrieval_terms
from ..rag.scoring import content_similarity, normalized_similarity
from ..rag.vector_store import ChromaVectorStore
from .store import KnowledgeStore

"""知识库索引、版本化 Chroma 向量和多信号混合检索。"""

LOGGER = logging.getLogger("petdock.knowledge")
SUPPORTED_EXTENSIONS = {
    ".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini",
    ".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".kt", ".kts", ".xml",
    ".html", ".css", ".scss", ".sql", ".ps1", ".sh",
    ".pdf", ".docx", ".xlsx", ".pptx",
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
VECTOR_CANDIDATES = 40
LEXICAL_CANDIDATES = 40
RRF_K = 60
FINAL_MIN_SCORE = 0.18
SINGLE_RESULT_LOW_CONFIDENCE = 0.30
SINGLE_RESULT_SCORE_RATIO = 0.55


@dataclass(frozen=True)
class RetrievalSource:
    """表示一条最终允许注入模型并返回 UI 的知识库命中。"""

    id: str
    library_id: str
    library_name: str
    title: str
    relative_path: str
    content: str
    score: float
    location: dict[str, object] = field(default_factory=dict)

    def public(self) -> dict[str, Any]:
        """返回不含绝对路径的引用摘要。"""
        compact = re.sub(r"\s+", " ", self.content).strip()
        result = {
            "id": self.id,
            "libraryId": self.library_id,
            "libraryName": self.library_name,
            "title": self.title,
            "relativePath": self.relative_path,
            "excerpt": compact[:360],
            "score": round(self.score, 6),
        }
        if self.location:
            result["location"] = dict(self.location)
        return result


@dataclass(frozen=True)
class RetrievalTrace:
    """记录不含正文和绝对路径的单轮检索诊断信息。"""

    query_hash: str
    pipeline_version: str
    embedding_profile_id: str
    index_signature: str
    vector_candidates: int
    lexical_candidates: int
    fused_candidates: int
    accepted_count: int
    degraded_to_hash: bool
    duration_ms: int
    rejection_counts: dict[str, int]

    def log_fields(self) -> dict[str, Any]:
        """转换为结构化日志字段。"""
        return {
            "queryHash": self.query_hash,
            "pipelineVersion": self.pipeline_version,
            "embeddingProfileId": self.embedding_profile_id,
            "indexSignature": self.index_signature,
            "vectorCandidates": self.vector_candidates,
            "lexicalCandidates": self.lexical_candidates,
            "fusedCandidates": self.fused_candidates,
            "acceptedCount": self.accepted_count,
            "degradedToHash": self.degraded_to_hash,
            "durationMs": self.duration_ms,
            "rejectionCounts": self.rejection_counts,
        }


@dataclass(frozen=True)
class RetrievalResult:
    """同时返回最终资料和可观测 Trace。"""

    sources: list[RetrievalSource]
    trace: RetrievalTrace


@dataclass
class _IndexControl:
    """保存跨线程可见的暂停信号。"""

    stop: threading.Event


@dataclass
class _Candidate:
    """保留融合和最终准入需要的全部候选信号。"""

    id: str
    rrf_score: float = 0.0
    vector_similarity: float | None = None
    vector_rank: int | None = None
    lexical_rank: int | None = None
    bm25_score: float | None = None
    final_score: float = 0.0
    rejection_reason: str | None = None
    channels: set[str] = field(default_factory=set)


class KnowledgeService:
    """管理知识库生命周期、后台增量索引和可拒绝的混合召回。"""

    def __init__(
        self,
        store: KnowledgeStore,
        vectors: ChromaVectorStore,
        fallback_vectors: ChromaVectorStore | None = None,
        parser_registry: DocumentParserRegistry | None = None,
    ) -> None:
        """绑定存储、向量索引和 Runtime 唯一 Parser Registry。"""
        self.store = store
        self.vectors = vectors
        self.fallback_vectors = fallback_vectors
        self.registry = parser_registry or DocumentParserRegistry(vision_enabled=False)
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

    async def start_all_indexes(self) -> int:
        """为模型切换启动全部已有知识库的后台重建。"""
        started = 0
        for library_id in self.store.ready_library_ids():
            if await self.start_index(library_id):
                started += 1
        return started

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
        if self.fallback_vectors:
            await asyncio.to_thread(self.fallback_vectors.delete_library, library_id)
        return await asyncio.to_thread(self.store.delete_library, library_id)

    async def search(self, query: str, library_ids: list[str], limit: int = 5) -> list[RetrievalSource]:
        """执行混合召回并只返回通过最终准入的来源。"""
        result = await self.search_with_trace(query, library_ids, limit)
        return result.sources

    async def search_with_trace(
        self,
        query: str,
        library_ids: list[str],
        limit: int = 5,
    ) -> RetrievalResult:
        """在线程中执行检索，并输出不含敏感正文的诊断 Trace。"""
        result = await asyncio.to_thread(self._search_sync, query, library_ids, limit)
        LOGGER.info("RAG 检索完成 %s", result.trace.log_fields())
        return result

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
        """在线程中扫描、结构化切分并同步活动和 Hash 影子索引。"""
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
                unchanged = (
                    state
                    and int(state["modified_ns"]) == stat.st_mtime_ns
                    and int(state["size_bytes"]) == stat.st_size
                    and state["chunk_strategy_version"] == CHUNK_STRATEGY_VERSION
                )
                current_signature = self.vectors.descriptor.signature
                if unchanged:
                    if (
                        state["embedding_state"] != "ready"
                        or state["embedding_signature"] != current_signature
                    ):
                        records = self.store.document_chunks(str(state["id"]))
                        written_signature = self._upsert_vectors(records)
                        self.store.mark_document_ready(str(state["id"]), written_signature)
                    self.store.set_progress(library_id, "indexing", processed, len(files))
                    continue

                try:
                    # 知识库图片索引默认关闭，即使附件侧视觉模型已主动探测成功。
                    parsed = self.registry.parse(path, name=path.name, vision_status="untested")
                except DocumentParseError as error:
                    LOGGER.warning(
                        "跳过无法解析的知识库文件 library=%s extension=%s code=%s",
                        library_id,
                        path.suffix.lower(),
                        error.problem.code,
                    )
                    self.store.set_progress(library_id, "indexing", processed, len(files))
                    continue
                if not parsed.ready:
                    LOGGER.warning(
                        "跳过未就绪知识库文件 library=%s extension=%s code=%s",
                        library_id,
                        path.suffix.lower(),
                        parsed.errors[0].code,
                    )
                    self.store.set_progress(library_id, "indexing", processed, len(files))
                    continue
                content = parsed.plain_text
                content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
                chunks: list[tuple[str, int, dict[str, object]]] = []
                for block in parsed.blocks:
                    chunks.extend(
                        (chunk, token_count, block.location.as_dict())
                        for chunk, token_count in split_document(
                            block.content,
                            self.vectors.embedding.count_tokens,
                        )
                    )
                old_ids, records, document_id = self.store.replace_document(
                    library_id,
                    relative_path,
                    stat.st_mtime_ns,
                    stat.st_size,
                    content_hash,
                    chunks,
                    CHUNK_STRATEGY_VERSION,
                    parsed.title,
                )
                self._delete_vector_ids(old_ids)
                written_signature = self._upsert_vectors(records)
                self.store.mark_document_ready(document_id, written_signature)
                self.store.set_progress(library_id, "indexing", processed, len(files))

            removed_ids = self.store.remove_missing_documents(library_id, existing_paths)
            self._delete_vector_ids(removed_ids)
            self.store.finish_index(library_id)
            LOGGER.info(
                "知识库索引完成 library=%s files=%s signature=%s",
                library_id,
                len(files),
                self.vectors.descriptor.signature,
            )
        except Exception as error:
            LOGGER.error("知识库索引失败 library=%s error=%s", library_id, error.__class__.__name__)
            try:
                self.store.set_progress(library_id, "error", error=error.__class__.__name__)
            except Exception:
                LOGGER.exception("知识库失败状态写入失败 library=%s", library_id)

    def _upsert_vectors(self, records: list[dict[str, Any]]) -> str:
        """独立写入活动和 Hash 影子索引，主索引失败时允许降级完成。"""
        primary_error: Exception | None = None
        try:
            self.vectors.upsert(records)
        except Exception as error:
            primary_error = error
            LOGGER.exception("活动向量索引写入失败，准备写入 Hash 影子索引")

        fallback_written = False
        if self.fallback_vectors:
            try:
                self.fallback_vectors.upsert(records)
                fallback_written = True
            except Exception:
                LOGGER.exception("Hash 影子向量索引写入失败")

        if primary_error is None:
            return self.vectors.descriptor.signature
        if fallback_written and self.fallback_vectors:
            return self.fallback_vectors.descriptor.signature
        raise primary_error

    def _delete_vector_ids(self, ids: list[str]) -> None:
        """从活动和影子向量空间删除失效 Chunk。"""
        self.vectors.delete_ids(ids)
        if self.fallback_vectors:
            self.fallback_vectors.delete_ids(ids)

    def _search_sync(self, query: str, library_ids: list[str], limit: int) -> RetrievalResult:
        """使用 Weighted RRF 合并候选，并执行多信号准入和去重。"""
        started_at = time.perf_counter()
        ready_ids: list[str] = []
        for library_id in library_ids[:20]:
            try:
                library = self.store.get_library(library_id)
                if library["status"] in {"ready", "indexing", "paused"} and library["chunkCount"] > 0:
                    ready_ids.append(library_id)
            except KeyError:
                continue
        if not ready_ids:
            return self._empty_result(query, started_at)

        degraded_to_hash = False
        try:
            vector_hits = self.vectors.search(query, ready_ids, VECTOR_CANDIDATES)
        except Exception:
            LOGGER.exception("活动向量检索失败，准备降级")
            vector_hits = []
        active_descriptor = self.vectors.descriptor
        if not vector_hits and self.fallback_vectors:
            try:
                vector_hits = self.fallback_vectors.search(query, ready_ids, VECTOR_CANDIDATES)
                if vector_hits:
                    active_descriptor = self.fallback_vectors.descriptor
                    degraded_to_hash = True
            except Exception:
                LOGGER.exception("Hash 影子向量检索失败")

        lexical_hits = self.store.lexical_search(query, ready_ids, LEXICAL_CANDIDATES)
        candidates: dict[str, _Candidate] = {}
        for rank, (chunk_id, similarity) in enumerate(vector_hits, start=1):
            candidate = candidates.setdefault(chunk_id, _Candidate(chunk_id))
            candidate.channels.add("vector")
            candidate.vector_rank = rank
            candidate.vector_similarity = similarity
            candidate.rrf_score += 1.0 / (RRF_K + rank)
        for rank, (chunk_id, bm25_score) in enumerate(lexical_hits, start=1):
            candidate = candidates.setdefault(chunk_id, _Candidate(chunk_id))
            candidate.channels.add("lexical")
            candidate.lexical_rank = rank
            candidate.bm25_score = bm25_score
            candidate.rrf_score += 1.0 / (RRF_K + rank)

        if not candidates:
            return self._empty_result(query, started_at, len(vector_hits), len(lexical_hits))

        ranked_for_fetch = sorted(candidates, key=lambda item: candidates[item].rrf_score, reverse=True)[:60]
        records = self.store.chunk_by_ids(ranked_for_fetch)
        terms = retrieval_query_terms(query)
        base_terms = retrieval_terms(query)
        required_term_hits = 1 if len(base_terms) <= 2 else 2
        exact_terms = [term for term in terms if re.search(r"[a-z0-9_.:/#-]", term)]
        rejection_counts: dict[str, int] = {}
        accepted: list[tuple[_Candidate, dict[str, Any]]] = []

        for chunk_id in ranked_for_fetch:
            record = records.get(chunk_id)
            if not record:
                continue
            candidate = candidates[chunk_id]
            search_text = " ".join(
                (str(record["title"]), str(record["relativePath"]), str(record["content"]))
            ).casefold()
            matched_terms = [term for term in terms if term.casefold() in search_text]
            term_coverage = len(matched_terms) / max(1, len(terms))
            metadata_hits = sum(
                1
                for term in terms
                if term.casefold() in f"{record['title']} {record['relativePath']}".casefold()
            )
            exact_hits = sum(1 for term in exact_terms if term.casefold() in search_text)
            has_query_anchor = len(matched_terms) >= required_term_hits or exact_hits >= 1
            vector_similarity = candidate.vector_similarity or 0.0
            vector_strength = normalized_similarity(
                vector_similarity,
                active_descriptor.candidate_min_similarity,
            )
            lexical_strength = (
                1.0 / (1.0 + (candidate.lexical_rank or 50) / 8.0)
                if candidate.lexical_rank is not None
                else 0.0
            )
            candidate.final_score = min(
                1.0,
                0.42 * vector_strength
                + 0.32 * term_coverage
                + 0.16 * lexical_strength
                + 0.05 * min(metadata_hits, 2)
                + 0.05 * min(exact_hits, 2)
                + (0.08 if len(candidate.channels) > 1 else 0.0),
            )

            # 余弦相似度只表示候选间的相对距离，不能单独证明跨领域相关性。
            # 在引入经过校准的 Reranker 前，所有向量 Provider 都必须满足查询锚点。
            vector_accepted = (
                candidate.vector_similarity is not None
                and candidate.vector_similarity >= active_descriptor.final_min_similarity
                and has_query_anchor
            )
            lexical_accepted = candidate.lexical_rank is not None and has_query_anchor
            combined_accepted = (
                len(candidate.channels) > 1
                and candidate.vector_similarity is not None
                and candidate.vector_similarity >= active_descriptor.candidate_min_similarity
                and has_query_anchor
            )
            if not (vector_accepted or lexical_accepted or combined_accepted):
                if not matched_terms:
                    candidate.rejection_reason = "零查询锚点"
                elif not has_query_anchor:
                    candidate.rejection_reason = "查询锚点不足"
                else:
                    candidate.rejection_reason = "相关性不足"
                rejection_counts[candidate.rejection_reason] = rejection_counts.get(candidate.rejection_reason, 0) + 1
                continue
            accepted.append((candidate, record))

        accepted.sort(key=lambda item: (item[0].final_score, item[0].rrf_score), reverse=True)
        accepted = [item for item in accepted if item[0].final_score >= FINAL_MIN_SCORE]
        desired_limit = _dynamic_limit(query, limit)
        if accepted and not _is_multi_document_query(query):
            top_score = accepted[0][0].final_score
            if top_score < SINGLE_RESULT_LOW_CONFIDENCE:
                desired_limit = min(desired_limit, 1)
            else:
                score_floor = max(FINAL_MIN_SCORE, top_score * SINGLE_RESULT_SCORE_RATIO)
                accepted = [item for item in accepted if item[0].final_score >= score_floor]
        selected = _deduplicate_candidates(accepted, desired_limit)
        sources = [
            RetrievalSource(
                id=candidate.id,
                library_id=str(record["libraryId"]),
                library_name=str(record["libraryName"]),
                title=str(record["title"]),
                relative_path=str(record["relativePath"]),
                content=str(record["content"]),
                score=candidate.final_score,
                location=dict(record.get("location") or {}),
            )
            for candidate, record in selected
        ]
        trace = RetrievalTrace(
            query_hash=_query_hash(query),
            pipeline_version="rag-v2",
            embedding_profile_id=active_descriptor.id,
            index_signature=active_descriptor.signature,
            vector_candidates=len(vector_hits),
            lexical_candidates=len(lexical_hits),
            fused_candidates=len(candidates),
            accepted_count=len(sources),
            degraded_to_hash=degraded_to_hash,
            duration_ms=round((time.perf_counter() - started_at) * 1000),
            rejection_counts=rejection_counts,
        )
        return RetrievalResult(sources, trace)

    def _empty_result(
        self,
        query: str,
        started_at: float,
        vector_candidates: int = 0,
        lexical_candidates: int = 0,
    ) -> RetrievalResult:
        """构造可观测的零召回结果。"""
        descriptor = self.vectors.descriptor
        return RetrievalResult(
            [],
            RetrievalTrace(
                query_hash=_query_hash(query),
                pipeline_version="rag-v2",
                embedding_profile_id=descriptor.id,
                index_signature=descriptor.signature,
                vector_candidates=vector_candidates,
                lexical_candidates=lexical_candidates,
                fused_candidates=0,
                accepted_count=0,
                degraded_to_hash=False,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
                rejection_counts={},
            ),
        )


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


def _dynamic_limit(query: str, requested_limit: int) -> int:
    """普通问题最多三条，多文档比较问题最多五条。"""
    multi_document = _is_multi_document_query(query)
    ceiling = 5 if multi_document else 3
    return max(0, min(requested_limit, ceiling, 5))


def _is_multi_document_query(query: str) -> bool:
    """识别需要保留多来源的比较、列举和分项问题。"""
    return bool(re.search(r"(?:比较|分别|列出|哪些|多份|多个|各自)", query))


def _deduplicate_candidates(
    candidates: list[tuple[_Candidate, dict[str, Any]]],
    limit: int,
) -> list[tuple[_Candidate, dict[str, Any]]]:
    """限制同文档占位并删除内容高度重复的最终候选。"""
    selected: list[tuple[_Candidate, dict[str, Any]]] = []
    document_counts: dict[str, int] = {}
    for candidate, record in candidates:
        document_id = str(record["documentId"])
        if document_counts.get(document_id, 0) >= 2:
            continue
        if any(content_similarity(str(record["content"]), str(item[1]["content"])) >= 0.86 for item in selected):
            continue
        selected.append((candidate, record))
        document_counts[document_id] = document_counts.get(document_id, 0) + 1
        if len(selected) >= limit:
            break
    return selected


def _query_hash(query: str) -> str:
    """为日志生成不可逆查询标识，不记录用户原文。"""
    return hashlib.sha256(query.encode("utf-8", errors="replace")).hexdigest()[:16]
