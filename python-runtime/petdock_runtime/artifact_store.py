from __future__ import annotations

import logging
import re
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

"""应用内 Artifact 的校验、受控写入、预览和生命周期管理。"""

MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
ORPHAN_GRACE_SECONDS = 60 * 60
LOGGER = logging.getLogger("petdock.artifacts")

FORMAT_MIME = {
    "txt": "text/plain",
    "md": "text/markdown",
    "json": "application/json",
    "jsonl": "application/x-ndjson",
    "yaml": "application/yaml",
    "csv": "text/csv",
    "tsv": "text/tab-separated-values",
    "xml": "application/xml",
    "html": "text/html",
    "css": "text/css",
    "js": "text/javascript",
    "ts": "text/typescript",
    "py": "text/x-python",
    "java": "text/x-java-source",
    "kt": "text/x-kotlin",
    "go": "text/x-go",
    "rs": "text/x-rust",
    "sql": "application/sql",
    "toml": "application/toml",
    "ini": "text/plain",
}
TABLE_FORMATS = {"csv", "tsv"}
WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


def _now() -> str:
    """返回统一 UTC 时间戳。"""
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class ArtifactRecord:
    """保存 Artifact 的脱敏元数据和受控相对路径。"""

    id: str
    conversation_id: str
    message_id: str
    task_id: str
    name: str
    format: str
    detected_mime: str
    size_bytes: int
    preview_kind: str
    status: str
    error: str | None
    relative_path: str | None
    saved_at: str | None

    def summary(self) -> dict[str, object]:
        """返回 Renderer 可见的 Artifact 摘要，不包含路径和正文。"""
        return {
            "id": self.id,
            "conversationId": self.conversation_id,
            "messageId": self.message_id,
            "name": self.name,
            "detectedMime": self.detected_mime,
            "sizeBytes": self.size_bytes,
            "previewKind": self.preview_kind,
            "status": self.status,
            "error": self.error,
            "saved": self.saved_at is not None,
        }


class ArtifactStore:
    """管理应用受控 Artifact 根目录和 assistant.db 中的索引。"""

    def __init__(self, db_path: str, root: str) -> None:
        """打开 Artifact 表，并清理异常退出遗留的孤立目录。"""
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(db_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._migrate()
        self.cleanup_orphans()

    def close(self) -> None:
        """关闭 Artifact 存储持有的 SQLite 连接。"""
        self._connection.close()

    def _migrate(self) -> None:
        """幂等创建 Artifact 表及会话、消息和任务索引。"""
        with self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS artifacts (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    format TEXT NOT NULL,
                    detected_mime TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    preview_kind TEXT NOT NULL CHECK (preview_kind IN ('text','table','none')),
                    status TEXT NOT NULL CHECK (status IN ('ready','error')),
                    error TEXT,
                    relative_storage_path TEXT,
                    created_at TEXT NOT NULL,
                    saved_at TEXT
                );
                CREATE INDEX IF NOT EXISTS artifacts_conversation_idx
                    ON artifacts(conversation_id, created_at);
                CREATE INDEX IF NOT EXISTS artifacts_message_idx
                    ON artifacts(message_id, created_at);
                CREATE INDEX IF NOT EXISTS artifacts_task_idx
                    ON artifacts(task_id, created_at);
                """
            )

    def create(
        self,
        conversation_id: str,
        message_id: str,
        task_id: str,
        suggested_name: object,
        requested_format: object,
        content: object,
    ) -> ArtifactRecord:
        """校验模型参数并原子写入 UTF-8 Artifact；失败也登记可见错误状态。"""
        artifact_id = uuid4().hex
        requested_format_name = str(requested_format).strip().lower().lstrip(".")
        format_is_safe = re.fullmatch(r"[a-z0-9]{1,10}", requested_format_name) is not None
        format_name = requested_format_name if format_is_safe else "invalid"
        name = self._safe_name(
            str(suggested_name),
            requested_format_name if format_is_safe else "txt",
        )
        try:
            if format_name not in FORMAT_MIME:
                raise ValueError("artifact_format_unsupported")
            if not isinstance(content, str):
                raise ValueError("artifact_content_invalid")
            encoded = content.encode("utf-8")
            if len(encoded) > MAX_ARTIFACT_BYTES:
                raise ValueError("artifact_too_large")
            directory = self.root / artifact_id
            directory.mkdir(parents=False, exist_ok=False)
            target = directory / name
            temporary = directory / ".writing.tmp"
            temporary.write_bytes(encoded)
            temporary.replace(target)
            record = ArtifactRecord(
                artifact_id,
                conversation_id,
                message_id,
                task_id,
                name,
                format_name,
                FORMAT_MIME[format_name],
                len(encoded),
                "table" if format_name in TABLE_FORMATS else "text",
                "ready",
                None,
                str(target.relative_to(self.root)),
                None,
            )
        except (OSError, UnicodeError, ValueError) as error:
            code = str(error) if isinstance(error, ValueError) else "artifact_write_failed"
            if code not in {
                "artifact_format_unsupported",
                "artifact_content_invalid",
                "artifact_too_large",
            }:
                code = "artifact_write_failed"
            self._delete_directory(artifact_id)
            record = ArtifactRecord(
                artifact_id,
                conversation_id,
                message_id,
                task_id,
                name,
                format_name,
                FORMAT_MIME.get(format_name, "text/plain"),
                0,
                "none",
                "error",
                code,
                None,
                None,
            )
            LOGGER.warning("Artifact 生成失败 id=%s format=%s code=%s", artifact_id, format_name, code)
        self._insert(record)
        if record.status == "ready":
            LOGGER.info("Artifact 已生成 id=%s format=%s bytes=%s", record.id, record.format, record.size_bytes)
        return record

    def _insert(self, record: ArtifactRecord) -> None:
        """把 Artifact 元数据写入 SQLite，不写正文和外部路径。"""
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO artifacts(
                    id, conversation_id, message_id, task_id, display_name, format,
                    detected_mime, size_bytes, preview_kind, status, error,
                    relative_storage_path, created_at, saved_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.conversation_id,
                    record.message_id,
                    record.task_id,
                    record.name,
                    record.format,
                    record.detected_mime,
                    record.size_bytes,
                    record.preview_kind,
                    record.status,
                    record.error,
                    record.relative_path,
                    _now(),
                    record.saved_at,
                ),
            )

    def get(self, artifact_id: str, conversation_id: str) -> ArtifactRecord:
        """按 ID 和会话归属读取 Artifact，避免跨会话枚举。"""
        row = self._connection.execute(
            "SELECT * FROM artifacts WHERE id=? AND conversation_id=?",
            (artifact_id, conversation_id),
        ).fetchone()
        if not row:
            raise ValueError("artifact_not_found")
        return self._record(row)

    def task_artifacts(self, task_id: str) -> list[ArtifactRecord]:
        """读取当前任务生成的 Artifact，供消息历史关联使用。"""
        rows = self._connection.execute(
            "SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at, id",
            (task_id,),
        ).fetchall()
        return [self._record(row) for row in rows]

    def preview(
        self,
        artifact_id: str,
        conversation_id: str,
        offset: int,
        limit: int,
    ) -> dict[str, object]:
        """返回经过归属校验的分页纯文本预览。"""
        record = self.get(artifact_id, conversation_id)
        content = self._read_text(record) if record.status == "ready" else ""
        total_characters = len(content)
        safe_offset = min(offset, total_characters)
        end = min(total_characters, safe_offset + limit)
        return {
            **record.summary(),
            "content": content[safe_offset:end],
            "offset": safe_offset,
            "nextOffset": end if end < total_characters else None,
            "totalCharacters": total_characters,
            "truncated": end < total_characters,
        }

    def read_bytes(self, artifact_id: str, conversation_id: str) -> tuple[ArtifactRecord, bytes]:
        """读取 Main 保存所需的完整内容，调用方只能使用 Artifact ID。"""
        record = self.get(artifact_id, conversation_id)
        if record.status != "ready":
            raise ValueError(record.error or "artifact_not_ready")
        path = self._resolve_record_path(record)
        data = path.read_bytes()
        if len(data) != record.size_bytes or len(data) > MAX_ARTIFACT_BYTES:
            raise ValueError("artifact_content_changed")
        return record, data

    def mark_saved(self, artifact_id: str, conversation_id: str) -> ArtifactRecord:
        """记录用户已通过 Main 原生对话框另存，不记录目标路径。"""
        record = self.get(artifact_id, conversation_id)
        if record.status != "ready":
            raise ValueError(record.error or "artifact_not_ready")
        with self._connection:
            self._connection.execute(
                "UPDATE artifacts SET saved_at=? WHERE id=? AND conversation_id=?",
                (_now(), artifact_id, conversation_id),
            )
        return self.get(artifact_id, conversation_id)

    def delete(self, artifact_id: str, conversation_id: str) -> bool:
        """删除指定会话内的应用内 Artifact；外部另存副本不受影响。"""
        try:
            self.get(artifact_id, conversation_id)
        except ValueError:
            return False
        if not self._delete_directory(artifact_id):
            return False
        with self._connection:
            self._connection.execute(
                "DELETE FROM artifacts WHERE id=? AND conversation_id=?",
                (artifact_id, conversation_id),
            )
        LOGGER.info("Artifact 已删除 id=%s", artifact_id)
        return True

    def delete_conversation(self, conversation_id: str) -> bool:
        """删除会话关联的全部应用内 Artifact。"""
        rows = self._connection.execute(
            "SELECT id FROM artifacts WHERE conversation_id=?",
            (conversation_id,),
        ).fetchall()
        results = [self.delete(str(row["id"]), conversation_id) for row in rows]
        return all(results)

    def clear_conversations(self) -> bool:
        """清空全部会话 Artifact，供会话数据清理复用。"""
        rows = self._connection.execute(
            "SELECT id, conversation_id FROM artifacts"
        ).fetchall()
        results = [
            self.delete(str(row["id"]), str(row["conversation_id"]))
            for row in rows
        ]
        return all(results)

    def cleanup_orphans(self) -> None:
        """清理未登记且超过宽限期的随机 Artifact 目录。"""
        known = {str(row["id"]) for row in self._connection.execute("SELECT id FROM artifacts")}
        cutoff = datetime.now().timestamp() - ORPHAN_GRACE_SECONDS
        for candidate in self.root.iterdir():
            try:
                if (
                    candidate.is_dir()
                    and re.fullmatch(r"[a-f0-9]{32}", candidate.name)
                    and candidate.name not in known
                    and candidate.stat().st_mtime < cutoff
                ):
                    shutil.rmtree(candidate)
            except OSError:
                LOGGER.warning("Artifact 孤立目录清理失败 id=%s", candidate.name)

    def _safe_name(self, suggested: str, format_name: str) -> str:
        """清理路径分隔符、控制字符、尾随点空格和 Windows 保留名。"""
        cleaned = re.sub(r"[<>:\"|?*\\/\x00-\x1f\x7f]+", "_", suggested.strip())
        cleaned = cleaned.rstrip(" .")[:220] or "artifact"
        safe_format = format_name if re.fullmatch(r"[a-z0-9]{1,10}", format_name) else "txt"
        suffix = f".{safe_format}"
        stem = Path(cleaned).stem if Path(cleaned).suffix else cleaned
        stem = stem.rstrip(" .")[: max(1, 240 - len(suffix))] or "artifact"
        if stem.split(".", 1)[0].upper() in WINDOWS_RESERVED_NAMES:
            stem = f"_{stem}"
        return f"{stem}{suffix}"

    def _read_text(self, record: ArtifactRecord) -> str:
        """严格按 UTF-8 读取受控 Artifact 文本。"""
        return self._resolve_record_path(record).read_text(encoding="utf-8")

    def _resolve_record_path(self, record: ArtifactRecord) -> Path:
        """重新解析数据库相对路径并校验仍位于 Artifact 根目录。"""
        if not record.relative_path:
            raise ValueError("artifact_not_ready")
        path = (self.root / record.relative_path).resolve()
        if path.parent.parent != self.root or path.parent.name != record.id:
            raise ValueError("artifact_not_found")
        if not path.is_file() or path.is_symlink():
            raise ValueError("artifact_not_found")
        return path

    def _delete_directory(self, artifact_id: str) -> bool:
        """精确删除随机 ID 目录；失败时保留索引供后续重试。"""
        directory = self.root / artifact_id
        if not re.fullmatch(r"[a-f0-9]{32}", artifact_id):
            return False
        try:
            if not directory.exists() and not directory.is_symlink():
                return True
            if directory.is_symlink() or not directory.is_dir():
                LOGGER.warning("Artifact 目录类型异常 id=%s", artifact_id)
                return False
            shutil.rmtree(directory)
            return True
        except OSError as error:
            LOGGER.warning("Artifact 目录删除失败 id=%s error=%s", artifact_id, error)
            return False

    @staticmethod
    def _record(row: sqlite3.Row) -> ArtifactRecord:
        """把 SQLite 行转换为内部记录。"""
        return ArtifactRecord(
            id=str(row["id"]),
            conversation_id=str(row["conversation_id"]),
            message_id=str(row["message_id"]),
            task_id=str(row["task_id"]),
            name=str(row["display_name"]),
            format=str(row["format"]),
            detected_mime=str(row["detected_mime"]),
            size_bytes=int(row["size_bytes"]),
            preview_kind=str(row["preview_kind"]),
            status=str(row["status"]),
            error=str(row["error"]) if row["error"] is not None else None,
            relative_path=(
                str(row["relative_storage_path"])
                if row["relative_storage_path"] is not None
                else None
            ),
            saved_at=str(row["saved_at"]) if row["saved_at"] is not None else None,
        )
