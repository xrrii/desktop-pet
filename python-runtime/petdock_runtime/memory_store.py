from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

"""PetDock 本地记忆 SQLite 存储层。

本模块集中处理迁移、会话消息、长期记忆、候选记忆、工具日志及脱敏，
上层不应绕过这里直接拼接 SQL 或读取原始路径。
"""


def _now() -> str:
    """返回统一使用的 UTC ISO-8601 时间戳。"""
    return datetime.now(timezone.utc).isoformat()


class MemoryStore:
    """负责助手会话、长期记忆和工具记录的 SQLite 持久化。"""

    def __init__(self, path: str) -> None:
        """打开数据库连接，启用 WAL/外键并执行幂等迁移。"""
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self.path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._migrate()

    def close(self) -> None:
        """关闭 Runtime 持有的 SQLite 连接。"""
        self._connection.close()

    def _migrate(self) -> None:
        """创建当前版本所需的表、索引和 schema 元数据。"""
        with self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    preview TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
                    content TEXT NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS messages_conversation_idx
                    ON messages(conversation_id, id);
                CREATE TABLE IF NOT EXISTS memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL CHECK (kind = 'preference'),
                    memory_key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'user',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(kind, memory_key)
                );
                CREATE TABLE IF NOT EXISTS memory_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL CHECK (kind = 'preference'),
                    content TEXT NOT NULL,
                    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
                    source_conversation_id TEXT NOT NULL,
                    sensitivity TEXT NOT NULL DEFAULT 'normal',
                    reason TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
                    created_at TEXT NOT NULL,
                    resolved_at TEXT
                );
                CREATE INDEX IF NOT EXISTS memory_candidates_status_idx
                    ON memory_candidates(status, created_at DESC);
                CREATE TABLE IF NOT EXISTS app_index (
                    app_id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    use_count INTEGER NOT NULL DEFAULT 0,
                    last_used_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS file_index (
                    path TEXT PRIMARY KEY,
                    display_path TEXT NOT NULL,
                    use_count INTEGER NOT NULL DEFAULT 0,
                    last_used_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tool_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL,
                    tool_call_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    args_json TEXT NOT NULL,
                    risk TEXT NOT NULL,
                    policy_decision TEXT NOT NULL,
                    user_decision TEXT,
                    ok INTEGER,
                    error TEXT,
                    duration_ms INTEGER,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS tool_logs_created_idx
                    ON tool_logs(created_at DESC);
                INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1')
                    ON CONFLICT(key) DO NOTHING;
                """
            )

    def ensure_conversation(self, conversation_id: str, first_input: str | None = None) -> None:
        """确保会话摘要存在，并刷新最近更新时间。"""
        now = _now()
        title = _clip(first_input or "新对话", 80)
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO conversations(id, title, preview, created_at, updated_at)
                VALUES (?, ?, '', ?, ?)
                ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at
                """,
                (conversation_id, title, now, now),
            )

    def append_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """追加一条用户、助手或工具消息，并更新会话预览。"""
        self.ensure_conversation(conversation_id, content if role == "user" else None)
        now = _now()
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO messages(conversation_id, role, content, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (conversation_id, role, content, _json(metadata or {}), now),
            )
            self._connection.execute(
                "UPDATE conversations SET preview=?, updated_at=? WHERE id=?",
                (_clip(content, 120), now, conversation_id),
            )

    def load_messages(self, conversation_id: str, limit: int = 48) -> list[dict[str, Any]]:
        """按时间顺序读取最近消息，转换 metadata JSON 供 LangChain 使用。"""
        rows = self._connection.execute(
            """
            SELECT role, content, metadata_json, created_at
            FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?
            """,
            (conversation_id, max(1, min(limit, 200))),
        ).fetchall()
        result: list[dict[str, Any]] = []
        for row in reversed(rows):
            try:
                metadata = json.loads(row["metadata_json"])
            except json.JSONDecodeError:
                metadata = {}
            result.append({"role": row["role"], "content": row["content"], "metadata": metadata})
        return result

    def conversation_messages(self, conversation_id: str) -> list[dict[str, Any]]:
        """返回用于恢复聊天界面的用户/助手消息及脱敏附件摘要。"""
        rows = self._connection.execute(
            """
            SELECT role, content, metadata_json, created_at FROM messages
            WHERE conversation_id=? AND role IN ('user', 'assistant')
            ORDER BY id ASC LIMIT 200
            """,
            (conversation_id,),
        ).fetchall()
        messages: list[dict[str, Any]] = []
        for row in rows:
            try:
                metadata = json.loads(row["metadata_json"])
            except json.JSONDecodeError:
                metadata = {}
            attachments = metadata.get("attachments", []) if isinstance(metadata, dict) else []
            if not row["content"] and not attachments:
                continue
            message: dict[str, Any] = {
                "role": row["role"],
                "content": row["content"],
                "createdAt": row["created_at"],
            }
            if isinstance(attachments, list) and attachments:
                message["attachments"] = attachments
            messages.append(message)
        return messages

    def remember_preference(self, value: str, source: str = "user") -> bool:
        """保存一条已确认偏好；敏感或空内容会被拒绝。"""
        cleaned = _clip(value.strip(), 500)
        if not cleaned or _looks_sensitive(cleaned):
            return False
        now = _now()
        key = cleaned.casefold()
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO memories(kind, memory_key, value, source, created_at, updated_at)
                VALUES ('preference', ?, ?, ?, ?, ?)
                ON CONFLICT(kind, memory_key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (key, cleaned, source, now, now),
            )
        return True

    def add_candidate(
        self,
        conversation_id: str,
        content: str,
        confidence: float,
        reason: str = "",
        sensitivity: str = "normal",
    ) -> int | None:
        """写入待确认候选，低置信度或敏感内容不进入长期记忆。"""
        cleaned = _clip(content.strip(), 500)
        if not cleaned or confidence < 0.7 or sensitivity != "normal" or _looks_sensitive(cleaned):
            return None
        with self._connection:
            cursor = self._connection.execute(
                """
                SELECT id FROM memory_candidates
                WHERE source_conversation_id=? AND content=? AND status='pending'
                LIMIT 1
                """,
                (conversation_id, cleaned),
            )
            existing = cursor.fetchone()
            if existing:
                return int(existing["id"])
            cursor = self._connection.execute(
                """
                INSERT INTO memory_candidates(
                    kind, content, confidence, source_conversation_id,
                    sensitivity, reason, status, created_at
                ) VALUES ('preference', ?, ?, ?, ?, ?, 'pending', ?)
                """,
                (cleaned, min(max(confidence, 0), 1), conversation_id, sensitivity, _clip(reason, 500), _now()),
            )
        return int(cursor.lastrowid)

    def resolve_candidate(self, candidate_id: int, decision: str) -> bool:
        """确认或拒绝候选；确认时才转写到正式 memories 表。"""
        if decision not in {"confirmed", "rejected"}:
            raise ValueError("Invalid memory candidate decision.")
        row = self._connection.execute(
            "SELECT content, status FROM memory_candidates WHERE id=?",
            (candidate_id,),
        ).fetchone()
        if not row or row["status"] != "pending":
            return False
        now = _now()
        with self._connection:
            self._connection.execute(
                "UPDATE memory_candidates SET status=?, resolved_at=? WHERE id=?",
                (decision, now, candidate_id),
            )
            if decision == "confirmed":
                self.remember_preference(row["content"], source="candidate")
        return True

    def extract_preference(self, text: str) -> str | None:
        """保留旧版明确记忆表达解析，供离线兼容逻辑使用。"""
        """仅识别明确的“记住”表达，避免把普通聊天误存为长期记忆。"""
        patterns = (
            r"^(?:请)?记住(?:我)?(?:喜欢|偏好|习惯|称呼我为|叫我)\s*(.+)$",
            r"^以后(?:请|都)?(?:用|使用)\s*(.+)$",
        )
        for pattern in patterns:
            match = re.match(pattern, text.strip(), re.IGNORECASE)
            if match:
                return _clip(match.group(1).strip(), 500) or None
        return None

    def record_tool_log(self, entry: dict[str, Any]) -> None:
        """保存工具审计记录，并在成功时更新常用应用/目录索引。"""
        now = _now()
        args = _redact(entry.get("args", {}))
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO tool_logs(
                    task_id, tool_call_id, tool_name, args_json, risk,
                    policy_decision, user_decision, ok, error, duration_ms, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(entry.get("taskId", "")),
                    str(entry.get("toolCallId", "")),
                    str(entry.get("toolName", "")),
                    _json(args),
                    str(entry.get("risk", "")),
                    str(entry.get("policyDecision", "")),
                    entry.get("userDecision"),
                    None if entry.get("ok") is None else int(bool(entry.get("ok"))),
                    _clip(str(entry.get("error", "")), 2_000) if entry.get("error") else None,
                    entry.get("durationMs"),
                    now,
                ),
            )
            if entry.get("ok") is True:
                tool_name = entry.get("toolName")
                args_record = entry.get("args") if isinstance(entry.get("args"), dict) else {}
                if tool_name == "open_app" and isinstance(args_record.get("appId"), str):
                    self._upsert_app(args_record["appId"], now)
                if tool_name == "open_file_or_folder" and isinstance(args_record.get("path"), str):
                    self._upsert_file(args_record["path"], now)

    def _upsert_app(self, app_id: str, now: str) -> None:
        """增加应用使用次数并刷新最后使用时间。"""
        self._connection.execute(
            """
            INSERT INTO app_index(app_id, display_name, use_count, last_used_at)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(app_id) DO UPDATE SET use_count=use_count+1, last_used_at=excluded.last_used_at
            """,
            (app_id, app_id, now),
        )

    def _upsert_file(self, path: str, now: str) -> None:
        """保存目录真实键和脱敏展示值，便于后续删除而不泄露路径。"""
        display = _redact_path(path)
        self._connection.execute(
            """
            INSERT INTO file_index(path, display_path, use_count, last_used_at)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(path) DO UPDATE SET use_count=use_count+1, last_used_at=excluded.last_used_at
            """,
            (path, display, now),
        )

    def snapshot(self) -> dict[str, list[dict[str, Any]]]:
        """返回供管理界面展示的脱敏记忆摘要。"""
        conversations = self._connection.execute(
            """
            SELECT c.id, c.title, c.preview, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS message_count
            FROM conversations c ORDER BY c.updated_at DESC LIMIT 100
            """
        ).fetchall()
        memories = self._connection.execute(
            "SELECT id, kind, value, source, created_at, updated_at FROM memories ORDER BY updated_at DESC"
        ).fetchall()
        apps = self._connection.execute(
            "SELECT app_id, display_name, use_count, last_used_at FROM app_index ORDER BY use_count DESC, last_used_at DESC"
        ).fetchall()
        files = self._connection.execute(
            "SELECT path, display_path, use_count, last_used_at FROM file_index ORDER BY use_count DESC, last_used_at DESC"
        ).fetchall()
        logs = self._connection.execute(
            """
            SELECT id, tool_name, risk, policy_decision, user_decision, ok, error, duration_ms, created_at
            FROM tool_logs ORDER BY id DESC LIMIT 100
            """
        ).fetchall()
        candidates = self._connection.execute(
            """
            SELECT id, kind, content, confidence, reason, created_at
            FROM memory_candidates WHERE status='pending' ORDER BY created_at DESC LIMIT 50
            """
        ).fetchall()
        return {
            "conversations": [_row(row, {"message_count": "messageCount", "created_at": "createdAt", "updated_at": "updatedAt"}) for row in conversations],
            "memories": [_row(row, {"created_at": "createdAt", "updated_at": "updatedAt"}) for row in memories],
            "candidates": [_row(row, {"created_at": "createdAt"}) for row in candidates],
            "apps": [_row(row, {"app_id": "appId", "display_name": "displayName", "use_count": "useCount", "last_used_at": "lastUsedAt"}) for row in apps],
            "directories": [{"id": _path_id(row["path"]), "displayPath": row["display_path"], "useCount": row["use_count"], "lastUsedAt": row["last_used_at"]} for row in files],
            "toolLogs": [_row(row, {"tool_name": "toolName", "policy_decision": "policyDecision", "user_decision": "userDecision", "duration_ms": "durationMs", "created_at": "createdAt"}) for row in logs],
        }

    def delete_item(self, kind: str, item_id: str) -> bool:
        """删除一条会话、偏好、应用或目录索引记录。"""
        if kind == "directory":
            rows = self._connection.execute("SELECT path FROM file_index").fetchall()
            for row in rows:
                if _path_id(row["path"]) == item_id:
                    with self._connection:
                        cursor = self._connection.execute("DELETE FROM file_index WHERE path=?", (row["path"],))
                    return cursor.rowcount > 0
            return False
        table = {"conversation": ("conversations", "id"), "memory": ("memories", "id"), "app": ("app_index", "app_id")}.get(kind)
        if not table:
            return False
        with self._connection:
            cursor = self._connection.execute(f"DELETE FROM {table[0]} WHERE {table[1]}=?", (item_id,))
        return cursor.rowcount > 0

    def clear(self, scope: str) -> None:
        """按类别清空记忆数据，并遵守消息表的外键删除顺序。"""
        tables = {
            "all": ("messages", "conversations", "memories", "memory_candidates", "app_index", "file_index", "tool_logs"),
            "conversations": ("messages", "conversations"),
            "memories": ("memories", "memory_candidates", "app_index", "file_index"),
            "tool_logs": ("tool_logs",),
        }
        selected = tables.get(scope)
        if not selected:
            raise ValueError("Invalid memory clear scope.")
        with self._connection:
            for table in selected:
                self._connection.execute(f"DELETE FROM {table}")


def _json(value: Any) -> str:
    """将任意值编码成稳定的紧凑 JSON。"""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _clip(value: str, limit: int) -> str:
    """限制日志、记忆和摘要文本长度，避免异常输入膨胀数据库。"""
    return value if len(value) <= limit else f"{value[:limit]}..."


def _redact_path(path: str) -> str:
    """仅保留路径末端用于界面显示，隐藏用户目录前缀。"""
    parts = re.split(r"[\\/]", path)
    return f"...\\{parts[-2]}\\{parts[-1]}" if len(parts) >= 2 else f"...\\{parts[-1]}"


def _path_id(path: str) -> str:
    """为真实路径生成稳定的不可逆删除键。"""
    return hashlib.sha256(path.encode("utf-8", errors="replace")).hexdigest()[:24]


def _looks_sensitive(value: str) -> bool:
    """识别常见凭据和高敏感信息关键词，阻止其进入长期记忆。"""
    patterns = (
        r"密码|口令|验证码|身份证|银行卡|信用卡|社会安全号|api[-_ ]?key|access[-_ ]?token|secret",
    )
    return any(re.search(pattern, value, re.IGNORECASE) for pattern in patterns)


def _redact(value: Any, key: str = "") -> Any:
    """递归脱敏工具参数中的路径、URL 和过长文本。"""
    if isinstance(value, dict):
        return {name: _redact(item, name) for name, item in value.items()}
    if isinstance(value, list):
        return [_redact(item, key) for item in value]
    if key.lower() == "path" and isinstance(value, str):
        return _redact_path(value)
    if key.lower() == "url" and isinstance(value, str):
        try:
            from urllib.parse import urlsplit

            parsed = urlsplit(value)
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        except ValueError:
            return "[无效 URL]"
    return _clip(value, 1_000) if isinstance(value, str) else value


def _row(row: sqlite3.Row, aliases: dict[str, str]) -> dict[str, Any]:
    """把 SQLite 行转换为 API 使用的驼峰字段字典，并修正布尔值。"""
    result: dict[str, Any] = {}
    for key in row.keys():
        value = row[key]
        if key == "ok" and value is not None:
            value = bool(value)
        result[aliases.get(key, key)] = value
    return result
