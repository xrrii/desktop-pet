from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..documents.chunking import CHUNK_STRATEGY_VERSION, split_document
from ..providers.embeddings import EmbeddingProvider
from ..rag.planner import retrieval_query_terms, retrieval_terms
from ..rag.scoring import content_similarity, normalized_similarity
from ..rag.vector_store import ChromaVectorStore
from .context_helpers import enrich_location, record_blocks, short_hash
from .store import AttachmentRecord

"""会话附件独立临时索引及混合召回。"""

LOGGER = logging.getLogger("petdock.attachments.index_store")
MAX_RETRIEVAL_SOURCES = 24
VECTOR_CANDIDATES = 120
LEXICAL_CANDIDATES = 120
RRF_K = 60
PROFILE_DIRECTORY_PATTERN = re.compile(r"^[a-f0-9]{16}$")
MULTI_FILE_PATTERN = re.compile(
    r"(?:比较|对比|分别|各自|逐个|逐份|每份|全部|所有|多份|多个|这些文件|这些附件|交叉核对|异同)",
    re.IGNORECASE,
)
ANALYSIS_PATTERN = re.compile(
    r"(?:总结|概括|摘要|比较|对比|分别|提取|字段|核对|差异|异同|归纳|梳理)",
    re.IGNORECASE,
)


def _now() -> str:
    """返回统一 UTC 时间戳。"""
    return datetime.now(timezone.utc).isoformat()


@dataclass
class _Candidate:
    """保存附件 Chunk 的混合召回信号。"""

    id: str
    vector_rank: int | None = None
    vector_similarity: float | None = None
    lexical_rank: int | None = None
    rrf_score: float = 0.0
    final_score: float = 0.0


class AttachmentIndexStore:
    """管理独立于长期知识库的会话附件 SQLite/FTS5/Chroma 索引。"""

    def __init__(self, root: str, embedding: EmbeddingProvider) -> None:
        """按活动 Embedding 签名创建临时索引目录和独立 collection。"""
        self.embedding = embedding
        self._lock = threading.RLock()
        if root == ":memory:":
            self.root: Path | None = None
            db_path = ":memory:"
            chroma_path = ":memory:"
        else:
            base = Path(root).resolve()
            base.mkdir(parents=True, exist_ok=True)
            self._cleanup_stale_profiles(base, embedding.descriptor.signature)
            profile_root = base / embedding.descriptor.signature
            profile_root.mkdir(parents=True, exist_ok=True)
            self.root = profile_root
            db_path = str(profile_root / "index.db")
            chroma_path = str(profile_root / "chroma")
        self.vectors = ChromaVectorStore(
            chroma_path,
            embedding,
            collection_name=f"petdock_attachment_{embedding.descriptor.signature}",
        )
        self._connection = sqlite3.connect(db_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._migrate()

    def close(self) -> None:
        """关闭临时索引 SQLite 连接。"""
        with self._lock:
            self._connection.close()

    def _cleanup_stale_profiles(self, base: Path, active_signature: str) -> None:
        """启动时删除旧 Embedding Profile 的派生索引，附件原文件不受影响。"""
        for candidate in base.iterdir():
            if (
                candidate.name == active_signature
                or not candidate.is_dir()
                or candidate.is_symlink()
                or not PROFILE_DIRECTORY_PATTERN.fullmatch(candidate.name)
            ):
                continue
            try:
                shutil.rmtree(candidate)
                LOGGER.info("已清理旧附件索引 profile=%s", candidate.name)
            except OSError:
                LOGGER.exception("清理旧附件索引失败 profile=%s", candidate.name)

    def _migrate(self) -> None:
        """幂等创建会话文档、Chunk 和 FTS5 表。"""
        with self._lock, self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS attachment_documents (
                    attachment_id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    title TEXT NOT NULL,
                    parser_id TEXT,
                    content_fingerprint TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    embedding_signature TEXT NOT NULL,
                    chunk_strategy_version TEXT NOT NULL,
                    vector_ready INTEGER NOT NULL DEFAULT 0,
                    indexed_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS attachment_documents_conversation_idx
                    ON attachment_documents(conversation_id, attachment_id);
                CREATE TABLE IF NOT EXISTS attachment_chunks (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    attachment_id TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    location_json TEXT NOT NULL DEFAULT '{}',
                    UNIQUE(attachment_id, chunk_index)
                );
                CREATE INDEX IF NOT EXISTS attachment_chunks_conversation_idx
                    ON attachment_chunks(conversation_id, attachment_id);
                CREATE VIRTUAL TABLE IF NOT EXISTS attachment_chunks_fts USING fts5(
                    chunk_id UNINDEXED,
                    conversation_id UNINDEXED,
                    attachment_id UNINDEXED,
                    name,
                    title,
                    content,
                    search_tokens,
                    tokenize='unicode61 remove_diacritics 2'
                );
                """
            )

    def sync_conversation(
        self,
        conversation_id: str,
        records: list[AttachmentRecord],
    ) -> None:
        """增量同步当前会话附件，并在向量失败时保留可用的 FTS5 索引。"""
        with self._lock:
            expected_ids = {record.id for record in records}
            existing_rows = self._connection.execute(
                "SELECT attachment_id FROM attachment_documents WHERE conversation_id=?",
                (conversation_id,),
            ).fetchall()
            for row in existing_rows:
                attachment_id = str(row["attachment_id"])
                if attachment_id not in expected_ids:
                    self._delete_attachment_locked(attachment_id)

            for record in records:
                fingerprint = _record_fingerprint(record)
                state = self._connection.execute(
                    """
                    SELECT content_fingerprint, embedding_signature, chunk_strategy_version,
                           vector_ready
                    FROM attachment_documents WHERE attachment_id=?
                    """,
                    (record.id,),
                ).fetchone()
                unchanged = bool(
                    state
                    and state["content_fingerprint"] == fingerprint
                    and state["embedding_signature"] == self.embedding.descriptor.signature
                    and state["chunk_strategy_version"] == CHUNK_STRATEGY_VERSION
                )
                if unchanged and int(state["vector_ready"]) == 1:
                    continue
                if unchanged:
                    vector_records = self._vector_records(record.id)
                else:
                    vector_records = self._replace_document(conversation_id, record, fingerprint)
                try:
                    self.vectors.upsert(vector_records)
                except Exception:
                    LOGGER.exception(
                        "附件向量写入失败，保留关键词索引 conversation=%s attachment=%s profile=%s",
                        short_hash(conversation_id),
                        record.id[:8],
                        self.embedding.descriptor.id,
                    )
                    continue
                with self._connection:
                    self._connection.execute(
                        "UPDATE attachment_documents SET vector_ready=1 WHERE attachment_id=?",
                        (record.id,),
                    )

    def _replace_document(
        self,
        conversation_id: str,
        record: AttachmentRecord,
        fingerprint: str,
    ) -> list[dict[str, Any]]:
        """原子替换附件分块，返回待写入独立 Chroma collection 的记录。"""
        old_ids = self._chunk_ids(record.id)
        if old_ids:
            self.vectors.delete_ids(old_ids)
        chunks = _record_chunks(record, self.embedding)
        vector_records: list[dict[str, Any]] = []
        with self._connection:
            if old_ids:
                placeholders = ",".join("?" for _ in old_ids)
                self._connection.execute(
                    f"DELETE FROM attachment_chunks_fts WHERE chunk_id IN ({placeholders})",
                    old_ids,
                )
            self._connection.execute(
                "DELETE FROM attachment_chunks WHERE attachment_id=?",
                (record.id,),
            )
            self._connection.execute(
                """
                INSERT INTO attachment_documents(
                    attachment_id, conversation_id, name, title, parser_id,
                    content_fingerprint, token_count, embedding_signature,
                    chunk_strategy_version, vector_ready, indexed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(attachment_id) DO UPDATE SET
                    conversation_id=excluded.conversation_id,
                    name=excluded.name,
                    title=excluded.title,
                    parser_id=excluded.parser_id,
                    content_fingerprint=excluded.content_fingerprint,
                    token_count=excluded.token_count,
                    embedding_signature=excluded.embedding_signature,
                    chunk_strategy_version=excluded.chunk_strategy_version,
                    vector_ready=0,
                    indexed_at=excluded.indexed_at
                """,
                (
                    record.id,
                    conversation_id,
                    record.name,
                    record.title or record.name,
                    record.parser_id,
                    fingerprint,
                    self.embedding.count_tokens(record.text_content),
                    self.embedding.descriptor.signature,
                    CHUNK_STRATEGY_VERSION,
                    _now(),
                ),
            )
            for index, (content, token_count, location) in enumerate(chunks):
                chunk_id = _stable_id(record.id, str(index), fingerprint)
                self._connection.execute(
                    """
                    INSERT INTO attachment_chunks(
                        id, conversation_id, attachment_id, chunk_index,
                        content, token_count, location_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        chunk_id,
                        conversation_id,
                        record.id,
                        index,
                        content,
                        token_count,
                        json.dumps(location, ensure_ascii=False),
                    ),
                )
                self._connection.execute(
                    """
                    INSERT INTO attachment_chunks_fts(
                        chunk_id, conversation_id, attachment_id, name,
                        title, content, search_tokens
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        chunk_id,
                        conversation_id,
                        record.id,
                        record.name,
                        record.title or record.name,
                        content,
                        " ".join(retrieval_terms(content, max_terms=256)),
                    ),
                )
                vector_records.append(
                    {
                        "id": chunk_id,
                        "libraryId": record.id,
                        "documentId": record.id,
                        "content": content,
                    }
                )
        return vector_records

    def _vector_records(self, attachment_id: str) -> list[dict[str, Any]]:
        """读取已有 SQLite Chunk，供失败后的向量写入重试。"""
        rows = self._connection.execute(
            "SELECT id, attachment_id, content FROM attachment_chunks WHERE attachment_id=? ORDER BY chunk_index",
            (attachment_id,),
        ).fetchall()
        return [
            {
                "id": str(row["id"]),
                "libraryId": str(row["attachment_id"]),
                "documentId": str(row["attachment_id"]),
                "content": str(row["content"]),
            }
            for row in rows
        ]

    def search(
        self,
        conversation_id: str,
        records: list[AttachmentRecord],
        query: str,
    ) -> list[dict[str, Any]]:
        """执行会话内混合检索，并为多文件问题尽量保留逐文件证据。"""
        with self._lock:
            return self._search_locked(conversation_id, records, query)

    def _search_locked(
        self,
        conversation_id: str,
        records: list[AttachmentRecord],
        query: str,
    ) -> list[dict[str, Any]]:
        """在持有实例锁时执行混合检索，避免共享 SQLite 连接并发读写。"""
        attachment_ids = [record.id for record in records]
        if not attachment_ids:
            return []
        query_text = query.strip() or "总结这些附件的主要内容"
        query_embedding: list[float] | None = None
        vector_hits: list[tuple[str, float]] = []
        try:
            query_embedding = self.embedding.embed_query(query_text)
            vector_hits = self.vectors.search_embedding(
                query_embedding,
                attachment_ids,
                max(VECTOR_CANDIDATES, len(attachment_ids) * 12),
            )
        except Exception:
            LOGGER.exception(
                "附件向量检索失败，降级为关键词检索 conversation=%s",
                short_hash(conversation_id),
            )
        lexical_hits = self._lexical_search(conversation_id, query_text, LEXICAL_CANDIDATES)
        candidates = self._rank_candidates(query_text, vector_hits, lexical_hits)
        records_by_id = self.chunks_by_ids(list(candidates))

        multi_file = bool(MULTI_FILE_PATTERN.search(query_text))
        analysis_intent = bool(ANALYSIS_PATTERN.search(query_text))
        accepted = self._accepted_candidates(
            query_text,
            candidates,
            records_by_id,
            allow_semantic_only=analysis_intent,
        )

        if multi_file and query_embedding:
            covered = {str(item[1]["attachmentId"]) for item in accepted}
            for attachment_id in attachment_ids:
                if attachment_id in covered:
                    continue
                try:
                    supplemental_hits = self.vectors.search_embedding(
                        query_embedding,
                        [attachment_id],
                        3,
                    )
                except Exception:
                    LOGGER.exception(
                        "附件逐文件补充检索失败 attachment=%s",
                        attachment_id[:8],
                    )
                    continue
                supplemental_candidates = self._rank_candidates(query_text, supplemental_hits, [])
                supplemental_records = self.chunks_by_ids(list(supplemental_candidates))
                supplemental = self._accepted_candidates(
                    query_text,
                    supplemental_candidates,
                    supplemental_records,
                    allow_semantic_only=True,
                )
                if supplemental:
                    accepted.append(supplemental[0])

        accepted.sort(key=lambda item: item[0].final_score, reverse=True)
        return _select_candidates(accepted, attachment_ids, multi_file)

    def _rank_candidates(
        self,
        query: str,
        vector_hits: list[tuple[str, float]],
        lexical_hits: list[tuple[str, float]],
    ) -> dict[str, _Candidate]:
        """融合向量与 FTS5 排名，并计算稳定的最终分数。"""
        candidates: dict[str, _Candidate] = {}
        for rank, (chunk_id, similarity) in enumerate(vector_hits, start=1):
            candidate = candidates.setdefault(chunk_id, _Candidate(chunk_id))
            candidate.vector_rank = rank
            candidate.vector_similarity = similarity
            candidate.rrf_score += 1.0 / (RRF_K + rank)
        for rank, (chunk_id, _score) in enumerate(lexical_hits, start=1):
            candidate = candidates.setdefault(chunk_id, _Candidate(chunk_id))
            candidate.lexical_rank = rank
            candidate.rrf_score += 1.0 / (RRF_K + rank)
        return candidates

    def _accepted_candidates(
        self,
        query: str,
        candidates: dict[str, _Candidate],
        chunk_records: dict[str, dict[str, Any]],
        *,
        allow_semantic_only: bool,
    ) -> list[tuple[_Candidate, dict[str, Any]]]:
        """只准入有查询锚点或明确分析意图下语义相关的片段。"""
        terms = retrieval_query_terms(query, max_terms=20)
        base_terms = retrieval_terms(query, max_terms=20)
        required_hits = 1 if len(base_terms) <= 2 else 2
        accepted: list[tuple[_Candidate, dict[str, Any]]] = []
        descriptor = self.embedding.descriptor
        for candidate in candidates.values():
            record = chunk_records.get(candidate.id)
            if not record:
                continue
            search_text = f"{record['name']} {record['title']} {record['content']}".casefold()
            matched = [term for term in terms if term.casefold() in search_text]
            coverage = len(matched) / max(1, len(terms))
            has_anchor = len(matched) >= required_hits
            similarity = candidate.vector_similarity or 0.0
            semantic_strength = normalized_similarity(
                similarity,
                descriptor.candidate_min_similarity,
            )
            lexical_strength = (
                1.0 / (1.0 + (candidate.lexical_rank or 50) / 8.0)
                if candidate.lexical_rank is not None
                else 0.0
            )
            candidate.final_score = min(
                1.0,
                0.52 * semantic_strength
                + 0.30 * coverage
                + 0.14 * lexical_strength
                + (0.04 if candidate.vector_rank and candidate.lexical_rank else 0.0),
            )
            lexical_accepted = candidate.lexical_rank is not None and has_anchor
            vector_accepted = (
                candidate.vector_similarity is not None
                and similarity >= descriptor.final_min_similarity
                and (has_anchor or allow_semantic_only)
            )
            combined_accepted = (
                candidate.vector_rank is not None
                and candidate.lexical_rank is not None
                and similarity >= descriptor.candidate_min_similarity
                and (has_anchor or allow_semantic_only)
            )
            if lexical_accepted or vector_accepted or combined_accepted:
                accepted.append((candidate, record))
        return accepted

    def _lexical_search(
        self,
        conversation_id: str,
        query: str,
        limit: int,
    ) -> list[tuple[str, float]]:
        """在独立 FTS5 表内按会话检索关键词候选。"""
        terms = retrieval_query_terms(query, max_terms=20)
        if not terms:
            return []
        cleaned = [term.replace('"', "") for term in terms]
        match = " OR ".join(
            f'(name:"{term}" OR title:"{term}" OR content:"{term}" OR search_tokens:"{term}")'
            for term in cleaned
        )
        try:
            rows = self._connection.execute(
                """
                SELECT chunk_id, bm25(attachment_chunks_fts, 0.0, 0.0, 0.0, 3.0, 2.0, 1.0, 1.5) AS score
                FROM attachment_chunks_fts
                WHERE attachment_chunks_fts MATCH ? AND conversation_id=?
                ORDER BY score LIMIT ?
                """,
                (match, conversation_id, max(1, min(limit, 200))),
            ).fetchall()
        except sqlite3.OperationalError:
            LOGGER.exception(
                "附件 FTS5 检索失败 conversation=%s",
                short_hash(conversation_id),
            )
            return []
        return [(str(row["chunk_id"]), float(row["score"])) for row in rows]

    def chunks_by_ids(self, chunk_ids: list[str]) -> dict[str, dict[str, Any]]:
        """按 Chunk ID 读取脱敏文件名、正文和结构位置。"""
        if not chunk_ids:
            return {}
        placeholders = ",".join("?" for _ in chunk_ids)
        rows = self._connection.execute(
            f"""
            SELECT c.id, c.attachment_id, c.chunk_index, c.content, c.token_count,
                   c.location_json, d.name, d.title
            FROM attachment_chunks c
            JOIN attachment_documents d ON d.attachment_id=c.attachment_id
            WHERE c.id IN ({placeholders})
            """,
            chunk_ids,
        ).fetchall()
        return {
            str(row["id"]): {
                "id": str(row["id"]),
                "attachmentId": str(row["attachment_id"]),
                "chunkIndex": int(row["chunk_index"]),
                "content": str(row["content"]),
                "tokenCount": int(row["token_count"]),
                "name": str(row["name"]),
                "title": str(row["title"]),
                "location": _json_object(row["location_json"]),
            }
            for row in rows
        }

    def reconcile(self, active_conversation_ids: set[str]) -> None:
        """启动时清理已经没有附件会话对应的临时索引。"""
        with self._lock:
            rows = self._connection.execute(
                "SELECT DISTINCT conversation_id FROM attachment_documents"
            ).fetchall()
            for row in rows:
                conversation_id = str(row["conversation_id"])
                if conversation_id not in active_conversation_ids:
                    self._delete_conversation_locked(conversation_id)

    def delete_conversation(self, conversation_id: str) -> bool:
        """删除指定会话的 SQLite、FTS5 和向量派生数据。"""
        with self._lock:
            try:
                self._delete_conversation_locked(conversation_id)
                return True
            except Exception:
                LOGGER.exception(
                    "删除会话附件索引失败 conversation=%s",
                    short_hash(conversation_id),
                )
                return False

    def clear(self) -> bool:
        """清空全部会话临时索引，不触碰附件受控副本。"""
        with self._lock:
            try:
                rows = self._connection.execute(
                    "SELECT DISTINCT conversation_id FROM attachment_documents"
                ).fetchall()
                for row in rows:
                    self._delete_conversation_locked(str(row["conversation_id"]))
                return True
            except Exception:
                LOGGER.exception("清空会话附件索引失败")
                return False

    def _delete_conversation_locked(self, conversation_id: str) -> None:
        """在持有实例锁时删除一个会话的全部派生索引。"""
        rows = self._connection.execute(
            "SELECT attachment_id FROM attachment_documents WHERE conversation_id=?",
            (conversation_id,),
        ).fetchall()
        for row in rows:
            self._delete_attachment_locked(str(row["attachment_id"]))

    def _delete_attachment_locked(self, attachment_id: str) -> None:
        """删除一个附件的所有派生数据，向量删除成功后再提交 SQLite。"""
        chunk_ids = self._chunk_ids(attachment_id)
        if chunk_ids:
            self.vectors.delete_ids(chunk_ids)
        with self._connection:
            if chunk_ids:
                placeholders = ",".join("?" for _ in chunk_ids)
                self._connection.execute(
                    f"DELETE FROM attachment_chunks_fts WHERE chunk_id IN ({placeholders})",
                    chunk_ids,
                )
            self._connection.execute(
                "DELETE FROM attachment_chunks WHERE attachment_id=?",
                (attachment_id,),
            )
            self._connection.execute(
                "DELETE FROM attachment_documents WHERE attachment_id=?",
                (attachment_id,),
            )

    def _chunk_ids(self, attachment_id: str) -> list[str]:
        """返回附件现有 Chunk ID。"""
        rows = self._connection.execute(
            "SELECT id FROM attachment_chunks WHERE attachment_id=?",
            (attachment_id,),
        ).fetchall()
        return [str(row["id"]) for row in rows]


def _record_chunks(
    record: AttachmentRecord,
    embedding: EmbeddingProvider,
) -> list[tuple[str, int, dict[str, object]]]:
    """将附件结构块切成临时索引 Chunk，并补充块号与文本行号。"""
    chunks: list[tuple[str, int, dict[str, object]]] = []
    global_index = 0
    for block_index, block in enumerate(record_blocks(record), start=1):
        content = str(block["content"])
        cursor = 0
        for chunk, token_count in split_document(content, embedding.count_tokens):
            global_index += 1
            location = enrich_location(dict(block["location"]), global_index)
            if str(location.get("kind")) == "text":
                found = content.find(chunk, cursor)
                if found < 0:
                    found = content.find(chunk)
                if found >= 0:
                    location["lineStart"] = content.count("\n", 0, found) + 1
                    location["lineEnd"] = content.count("\n", 0, found + len(chunk)) + 1
                    cursor = max(found + len(chunk) - 96, found + 1)
            location["sourceBlock"] = block_index
            chunks.append((chunk, token_count, location))
    return chunks


def _select_candidates(
    accepted: list[tuple[_Candidate, dict[str, Any]]],
    attachment_ids: list[str],
    multi_file: bool,
) -> list[dict[str, Any]]:
    """限制重复 Chunk；多文件问题优先为每个附件保留一条证据。"""
    selected: list[tuple[_Candidate, dict[str, Any]]] = []
    selected_ids: set[str] = set()
    per_attachment: dict[str, int] = {}
    if multi_file:
        for attachment_id in attachment_ids:
            item = next(
                (
                    candidate
                    for candidate in accepted
                    if str(candidate[1]["attachmentId"]) == attachment_id
                    and candidate[0].id not in selected_ids
                ),
                None,
            )
            if item:
                selected.append(item)
                selected_ids.add(item[0].id)
                per_attachment[attachment_id] = 1
    for item in accepted:
        attachment_id = str(item[1]["attachmentId"])
        if item[0].id in selected_ids or per_attachment.get(attachment_id, 0) >= 2:
            continue
        if any(content_similarity(str(item[1]["content"]), str(current[1]["content"])) >= 0.9 for current in selected):
            continue
        selected.append(item)
        selected_ids.add(item[0].id)
        per_attachment[attachment_id] = per_attachment.get(attachment_id, 0) + 1
        if len(selected) >= MAX_RETRIEVAL_SOURCES:
            break
    return [{**record, "score": candidate.final_score} for candidate, record in selected]


def _record_fingerprint(record: AttachmentRecord) -> str:
    """为解析正文、结构位置和 Parser 版本生成稳定指纹。"""
    payload = "\0".join(
        (
            record.parser_id or "",
            record.text_content,
            record.blocks_json,
            record.warnings_json,
        )
    )
    return hashlib.sha256(payload.encode("utf-8", errors="replace")).hexdigest()


def _json_object(value: object) -> dict[str, object]:
    """安全读取结构位置 JSON。"""
    try:
        parsed = json.loads(str(value))
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def _stable_id(*parts: str) -> str:
    """为临时索引 Chunk 生成不暴露正文的稳定 ID。"""
    return hashlib.sha256("\0".join(parts).encode("utf-8", errors="replace")).hexdigest()[:40]
