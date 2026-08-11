from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from ..rag.planner import retrieval_query_terms, retrieval_terms

"""知识库 SQLite 主存储。

SQLite 保存授权目录、文档原文分块和索引任务状态；Chroma 仅保存可重建的向量索引。
"""

LOGGER = logging.getLogger("petdock.knowledge_store")


def _now() -> str:
    """返回统一的 UTC ISO 时间。"""
    return datetime.now(timezone.utc).isoformat()


class KnowledgeStore:
    """管理知识库业务元数据、文档分块和 FTS5 关键词索引。"""

    def __init__(self, path: str) -> None:
        """打开独立知识库数据库，并初始化可重复执行的 schema。"""
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self.path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._migrate()
        # Runtime 异常退出时无法保留线程；重启后必须如实展示为暂停状态。
        with self._connection:
            self._connection.execute(
                "UPDATE knowledge_libraries SET status='paused', updated_at=? WHERE status='indexing'",
                (_now(),),
            )

    def close(self) -> None:
        """关闭 SQLite 连接。"""
        with self._lock:
            self._connection.close()

    def _migrate(self) -> None:
        """创建知识库、文档、分块和全文检索表。"""
        with self._lock, self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS knowledge_libraries (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    source_path TEXT NOT NULL UNIQUE,
                    display_path TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending','indexing','paused','ready','error')),
                    document_count INTEGER NOT NULL DEFAULT 0,
                    chunk_count INTEGER NOT NULL DEFAULT 0,
                    processed_files INTEGER NOT NULL DEFAULT 0,
                    total_files INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_indexed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    library_id TEXT NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
                    relative_path TEXT NOT NULL,
                    title TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    modified_ns INTEGER NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    embedding_state TEXT NOT NULL CHECK (embedding_state IN ('pending','ready')),
                    embedding_signature TEXT,
                    chunk_strategy_version TEXT NOT NULL DEFAULT 'v1',
                    indexed_at TEXT NOT NULL,
                    UNIQUE(library_id, relative_path)
                );
                CREATE INDEX IF NOT EXISTS documents_library_idx ON documents(library_id, relative_path);
                CREATE TABLE IF NOT EXISTS document_chunks (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                    library_id TEXT NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
                    chunk_index INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    location_json TEXT NOT NULL DEFAULT '{}',
                    UNIQUE(document_id, chunk_index)
                );
                CREATE INDEX IF NOT EXISTS chunks_library_idx ON document_chunks(library_id, document_id);
                CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
                    chunk_id UNINDEXED,
                    library_id UNINDEXED,
                    title,
                    relative_path,
                    content,
                    search_tokens,
                    tokenize='unicode61'
                );
                INSERT INTO schema_meta(key, value) VALUES ('schema_version', '2')
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value;
                """
            )
            self._ensure_document_columns()
            self._ensure_chunk_columns()
            self._ensure_fts_v2()

    def _ensure_document_columns(self) -> None:
        """为已有阶段 4 数据库补充向量签名和 Chunk 策略版本。"""
        columns = {
            str(row["name"])
            for row in self._connection.execute("PRAGMA table_info(documents)").fetchall()
        }
        if "embedding_signature" not in columns:
            self._connection.execute("ALTER TABLE documents ADD COLUMN embedding_signature TEXT")
        if "chunk_strategy_version" not in columns:
            self._connection.execute(
                "ALTER TABLE documents ADD COLUMN chunk_strategy_version TEXT NOT NULL DEFAULT 'v1'"
            )

    def _ensure_chunk_columns(self) -> None:
        """为旧知识库 Chunk 增加可选结构位置，旧记录保持可检索。"""
        columns = {
            str(row["name"])
            for row in self._connection.execute("PRAGMA table_info(document_chunks)").fetchall()
        }
        if "location_json" not in columns:
            self._connection.execute(
                "ALTER TABLE document_chunks ADD COLUMN location_json TEXT NOT NULL DEFAULT '{}'"
            )

    def _ensure_fts_v2(self) -> None:
        """升级阶段 4 的正文 FTS 表，并从 SQLite 原文安全重建。"""
        columns = [
            str(row["name"])
            for row in self._connection.execute("PRAGMA table_info(document_chunks_fts)").fetchall()
        ]
        expected = ["chunk_id", "library_id", "title", "relative_path", "content", "search_tokens"]
        if columns == expected:
            return
        self._connection.execute("DROP TABLE IF EXISTS document_chunks_fts")
        self._connection.execute(
            """
            CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
                chunk_id UNINDEXED,
                library_id UNINDEXED,
                title,
                relative_path,
                content,
                search_tokens,
                tokenize='unicode61'
            )
            """
        )
        rows = self._connection.execute(
            """
            SELECT c.id, c.library_id, c.content, d.title, d.relative_path
            FROM document_chunks c JOIN documents d ON d.id=c.document_id
            """
        ).fetchall()
        self._connection.executemany(
            """
            INSERT INTO document_chunks_fts(
                chunk_id, library_id, title, relative_path, content, search_tokens
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    row["id"],
                    row["library_id"],
                    row["title"],
                    row["relative_path"],
                    row["content"],
                    " ".join(retrieval_terms(str(row["content"]), max_terms=256)),
                )
                for row in rows
            ],
        )

    def create_library(self, name: str, source_path: str) -> dict[str, Any]:
        """保存用户明确授权的目录，并返回管理界面摘要。"""
        root = Path(source_path).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("知识库来源必须是存在的目录。")
        cleaned_name = name.strip()[:80] or root.name
        library_id = uuid4().hex
        now = _now()
        with self._lock, self._connection:
            try:
                self._connection.execute(
                    """
                    INSERT INTO knowledge_libraries(
                        id, name, source_path, display_path, status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
                    """,
                    (library_id, cleaned_name, str(root), _display_path(root), now, now),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("该目录已经添加到知识库。") from error
        return self.get_library(library_id)

    def get_library(self, library_id: str) -> dict[str, Any]:
        """读取单个知识库的公开摘要。"""
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM knowledge_libraries WHERE id=?", (library_id,)
            ).fetchone()
        if not row:
            raise KeyError(library_id)
        return _library_row(row)

    def source_path(self, library_id: str) -> Path:
        """仅在 Runtime 内部返回真实授权路径。"""
        with self._lock:
            row = self._connection.execute(
                "SELECT source_path FROM knowledge_libraries WHERE id=?", (library_id,)
            ).fetchone()
        if not row:
            raise KeyError(library_id)
        return Path(row["source_path"])

    def snapshot(self) -> dict[str, list[dict[str, Any]]]:
        """返回全部知识库状态，不向 Renderer 暴露真实绝对路径。"""
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM knowledge_libraries ORDER BY updated_at DESC"
            ).fetchall()
        return {"libraries": [_library_row(row) for row in rows]}

    def set_progress(
        self,
        library_id: str,
        status: str,
        processed_files: int | None = None,
        total_files: int | None = None,
        error: str | None = None,
    ) -> None:
        """更新后台索引进度，避免长事务阻塞聊天读取。"""
        updates = ["status=?", "updated_at=?", "error=?"]
        values: list[Any] = [status, _now(), error[:2000] if error else None]
        if processed_files is not None:
            updates.append("processed_files=?")
            values.append(processed_files)
        if total_files is not None:
            updates.append("total_files=?")
            values.append(total_files)
        values.append(library_id)
        with self._lock, self._connection:
            self._connection.execute(
                f"UPDATE knowledge_libraries SET {', '.join(updates)} WHERE id=?", values
            )

    def document_state(self, library_id: str, relative_path: str) -> dict[str, Any] | None:
        """读取增量索引判断所需的文件状态。"""
        with self._lock:
            row = self._connection.execute(
                """
                SELECT id, content_hash, modified_ns, size_bytes, embedding_state,
                       embedding_signature, chunk_strategy_version
                FROM documents WHERE library_id=? AND relative_path=?
                """,
                (library_id, relative_path),
            ).fetchone()
        return dict(row) if row else None

    def replace_document(
        self,
        library_id: str,
        relative_path: str,
        modified_ns: int,
        size_bytes: int,
        content_hash: str,
        chunks: list[tuple[str, int] | tuple[str, int, dict[str, object]]],
        chunk_strategy_version: str,
        title: str | None = None,
    ) -> tuple[list[str], list[dict[str, Any]], str]:
        """原子替换文档分块，并把 embedding 状态标记为待写入 Chroma。"""
        document_id = _stable_id(library_id, relative_path)
        now = _now()
        with self._lock, self._connection:
            old_rows = self._connection.execute(
                "SELECT id FROM document_chunks WHERE document_id=?", (document_id,)
            ).fetchall()
            old_ids = [str(row["id"]) for row in old_rows]
            if old_ids:
                placeholders = ",".join("?" for _ in old_ids)
                self._connection.execute(
                    f"DELETE FROM document_chunks_fts WHERE chunk_id IN ({placeholders})", old_ids
                )
            self._connection.execute("DELETE FROM document_chunks WHERE document_id=?", (document_id,))
            self._connection.execute(
                """
                INSERT INTO documents(
                    id, library_id, relative_path, title, content_hash, modified_ns,
                    size_bytes, embedding_state, embedding_signature,
                    chunk_strategy_version, indexed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    content_hash=excluded.content_hash,
                    modified_ns=excluded.modified_ns,
                    size_bytes=excluded.size_bytes,
                    embedding_state='pending',
                    embedding_signature=NULL,
                    chunk_strategy_version=excluded.chunk_strategy_version,
                    indexed_at=excluded.indexed_at
                """,
                (
                    document_id,
                    library_id,
                    relative_path,
                    (title or Path(relative_path).stem)[:200],
                    content_hash,
                    modified_ns,
                    size_bytes,
                    chunk_strategy_version,
                    now,
                ),
            )
            records: list[dict[str, Any]] = []
            for index, chunk in enumerate(chunks):
                content, token_count = chunk[0], chunk[1]
                location = chunk[2] if len(chunk) > 2 else {}
                chunk_id = _stable_id(document_id, str(index), content_hash)
                self._connection.execute(
                    """
                    INSERT INTO document_chunks(
                        id, document_id, library_id, chunk_index, content, token_count, location_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (chunk_id, document_id, library_id, index, content, token_count, json.dumps(location, ensure_ascii=False)),
                )
                chunk_title = (title or Path(relative_path).stem)[:200]
                self._connection.execute(
                    """
                    INSERT INTO document_chunks_fts(
                        chunk_id, library_id, title, relative_path, content, search_tokens
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        chunk_id,
                        library_id,
                        chunk_title,
                        relative_path,
                        content,
                        " ".join(retrieval_terms(content, max_terms=256)),
                    ),
                )
                records.append(
                    {
                        "id": chunk_id,
                        "libraryId": library_id,
                        "documentId": document_id,
                        "relativePath": relative_path,
                        "title": chunk_title,
                        "content": content,
                        "location": location,
                    }
                )
        return old_ids, records, document_id

    def document_chunks(self, document_id: str) -> list[dict[str, Any]]:
        """读取需要重新写入向量库的现有分块。"""
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT c.id, c.library_id, c.document_id, c.content, c.location_json,
                       d.relative_path, d.title
                FROM document_chunks c JOIN documents d ON d.id=c.document_id
                WHERE c.document_id=? ORDER BY c.chunk_index
                """,
                (document_id,),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "libraryId": row["library_id"],
                "documentId": row["document_id"],
                "relativePath": row["relative_path"],
                "title": row["title"],
                "content": row["content"],
                "location": _load_json_object(row["location_json"]),
            }
            for row in rows
        ]

    def mark_document_ready(self, document_id: str, embedding_signature: str) -> None:
        """仅在当前签名 Chroma 写入成功后标记向量状态完成。"""
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE documents SET embedding_state='ready', embedding_signature=? WHERE id=?
                """,
                (embedding_signature, document_id),
            )

    def remove_missing_documents(self, library_id: str, existing_paths: set[str]) -> list[str]:
        """删除来源目录中已不存在的文档，并返回需要从 Chroma 删除的 chunk ID。"""
        with self._lock, self._connection:
            rows = self._connection.execute(
                "SELECT id, relative_path FROM documents WHERE library_id=?", (library_id,)
            ).fetchall()
            missing_ids = [str(row["id"]) for row in rows if row["relative_path"] not in existing_paths]
            if not missing_ids:
                return []
            placeholders = ",".join("?" for _ in missing_ids)
            chunk_rows = self._connection.execute(
                f"SELECT id FROM document_chunks WHERE document_id IN ({placeholders})", missing_ids
            ).fetchall()
            chunk_ids = [str(row["id"]) for row in chunk_rows]
            if chunk_ids:
                chunk_placeholders = ",".join("?" for _ in chunk_ids)
                self._connection.execute(
                    f"DELETE FROM document_chunks_fts WHERE chunk_id IN ({chunk_placeholders})", chunk_ids
                )
            self._connection.execute(
                f"DELETE FROM documents WHERE id IN ({placeholders})", missing_ids
            )
        return chunk_ids

    def finish_index(self, library_id: str) -> None:
        """重新统计文档和分块数量并标记索引完成。"""
        now = _now()
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE knowledge_libraries SET
                    status='ready', error=NULL, processed_files=total_files,
                    document_count=(SELECT COUNT(*) FROM documents WHERE library_id=?),
                    chunk_count=(SELECT COUNT(*) FROM document_chunks WHERE library_id=?),
                    updated_at=?, last_indexed_at=?
                WHERE id=?
                """,
                (library_id, library_id, now, now, library_id),
            )

    def delete_library(self, library_id: str) -> bool:
        """删除知识库业务数据和 FTS 行，原始文件不会被修改。"""
        with self._lock, self._connection:
            self._connection.execute(
                "DELETE FROM document_chunks_fts WHERE library_id=?", (library_id,)
            )
            cursor = self._connection.execute(
                "DELETE FROM knowledge_libraries WHERE id=?", (library_id,)
            )
        return cursor.rowcount > 0

    def chunk_by_ids(self, chunk_ids: list[str]) -> dict[str, dict[str, Any]]:
        """根据向量命中 ID 获取可信的本地原文和来源信息。"""
        if not chunk_ids:
            return {}
        placeholders = ",".join("?" for _ in chunk_ids)
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT c.id, c.library_id, c.document_id, c.chunk_index, c.token_count,
                       c.content, c.location_json, d.relative_path, d.title, l.name AS library_name
                FROM document_chunks c
                JOIN documents d ON d.id=c.document_id
                JOIN knowledge_libraries l ON l.id=c.library_id
                WHERE c.id IN ({placeholders})
                """,
                chunk_ids,
            ).fetchall()
        return {
            str(row["id"]): {
                "id": row["id"],
                "libraryId": row["library_id"],
                "documentId": row["document_id"],
                "chunkIndex": row["chunk_index"],
                "tokenCount": row["token_count"],
                "libraryName": row["library_name"],
                "title": row["title"],
                "relativePath": row["relative_path"],
                "content": row["content"],
                "location": _load_json_object(row["location_json"]),
            }
            for row in rows
        }

    def lexical_search(
        self,
        query: str,
        library_ids: list[str],
        limit: int = 40,
    ) -> list[tuple[str, float]]:
        """使用带中文二元组、标题和路径权重的 FTS5 返回关键词候选。"""
        terms = retrieval_query_terms(query, max_terms=20)
        if not terms or not library_ids:
            return []
        cleaned_terms = [term.replace('"', "") for term in terms]
        match = " OR ".join(
            f'(title:"{term}" OR relative_path:"{term}" OR content:"{term}" OR search_tokens:"{term}")'
            for term in cleaned_terms
        )
        placeholders = ",".join("?" for _ in library_ids)
        try:
            with self._lock:
                rows = self._connection.execute(
                    f"""
                    SELECT chunk_id,
                           bm25(document_chunks_fts, 0.0, 0.0, 4.0, 3.0, 1.0, 1.5) AS score
                    FROM document_chunks_fts
                    WHERE document_chunks_fts MATCH ? AND library_id IN ({placeholders})
                    ORDER BY score LIMIT ?
                    """,
                    [match, *library_ids, max(1, min(limit, 50))],
                ).fetchall()
        except sqlite3.OperationalError:
            LOGGER.exception("FTS5 关键词检索失败 libraries=%s", len(library_ids))
            return []
        return [(str(row["chunk_id"]), float(row["score"])) for row in rows]

    def ready_library_ids(self) -> list[str]:
        """返回可以参与索引刷新或检索的知识库 ID。"""
        with self._lock:
            rows = self._connection.execute(
                "SELECT id FROM knowledge_libraries WHERE status IN ('ready','paused','error')"
            ).fetchall()
        return [str(row["id"]) for row in rows]


def _load_json_object(value: object) -> dict[str, object]:
    """读取 Chunk 结构位置，兼容旧库默认空对象。"""
    try:
        parsed = json.loads(str(value))
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def _stable_id(*parts: str) -> str:
    """为文档与分块生成跨重建稳定的不可逆 ID。"""
    return hashlib.sha256("\0".join(parts).encode("utf-8", errors="replace")).hexdigest()[:40]


def _display_path(path: Path) -> str:
    """仅显示目录末端，避免绝对用户路径进入 Renderer。"""
    parts = path.parts
    return f"...\\{parts[-2]}\\{parts[-1]}" if len(parts) > 1 else f"...\\{path.name}"


def _library_row(row: sqlite3.Row) -> dict[str, Any]:
    """把数据库字段转换成共享协议使用的驼峰结构。"""
    return {
        "id": row["id"],
        "name": row["name"],
        "displayPath": row["display_path"],
        "status": row["status"],
        "documentCount": row["document_count"],
        "chunkCount": row["chunk_count"],
        "processedFiles": row["processed_files"],
        "totalFiles": row["total_files"],
        "error": row["error"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "lastIndexedAt": row["last_indexed_at"],
    }
