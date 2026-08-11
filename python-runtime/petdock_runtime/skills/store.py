from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .manifest import SkillMetadata

"""Skill SQLite 状态、权限和运行日志存储。"""


class SkillStore:
    """持久化 Skill 元数据，同时避免向 Renderer 暴露真实路径。"""

    def __init__(self, path: str) -> None:
        """打开 Skill 数据库并执行可重复迁移。"""
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._initialize()

    def _initialize(self) -> None:
        """创建阶段 5 首版表和索引。"""
        with self._lock, self._connection:
            self._connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys=ON;
                CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS skills (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    root_path TEXT NOT NULL,
                    instructions_path TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    source_display TEXT NOT NULL,
                    repository TEXT,
                    subdirectory TEXT,
                    requested_ref TEXT,
                    resolved_commit TEXT,
                    version_label TEXT,
                    content_hash TEXT NOT NULL,
                    compatibility TEXT NOT NULL,
                    permissions_json TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    installed_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_error TEXT
                );
                CREATE TABLE IF NOT EXISTS skill_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    skill_id TEXT NOT NULL,
                    trigger TEXT NOT NULL,
                    status TEXT NOT NULL,
                    error_code TEXT,
                    error_message TEXT,
                    duration_ms INTEGER,
                    created_at TEXT NOT NULL,
                    completed_at TEXT
                );
                CREATE INDEX IF NOT EXISTS skill_runs_skill_idx
                    ON skill_runs(skill_id, created_at DESC);
                INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1')
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value;
                """
            )

    def synchronize(self, skills: list[SkillMetadata]) -> None:
        """同步磁盘扫描结果，保留用户启停状态。"""
        now = _now()
        ids = {skill.id for skill in skills}
        with self._lock, self._connection:
            for skill in skills:
                self._connection.execute(
                    """
                    INSERT INTO skills(
                        id, name, description, root_path, instructions_path,
                        source_type, source_display, repository, subdirectory,
                        requested_ref, resolved_commit, version_label, content_hash,
                        compatibility, permissions_json, enabled, installed_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        name=excluded.name,
                        description=excluded.description,
                        root_path=excluded.root_path,
                        instructions_path=excluded.instructions_path,
                        source_type=excluded.source_type,
                        source_display=excluded.source_display,
                        repository=excluded.repository,
                        subdirectory=excluded.subdirectory,
                        requested_ref=excluded.requested_ref,
                        resolved_commit=excluded.resolved_commit,
                        version_label=excluded.version_label,
                        content_hash=excluded.content_hash,
                        compatibility=excluded.compatibility,
                        permissions_json=excluded.permissions_json,
                        updated_at=excluded.updated_at,
                        last_error=NULL
                    """,
                    (
                        skill.id,
                        skill.name,
                        skill.description,
                        str(skill.root_path),
                        str(skill.instructions_path),
                        skill.source_type,
                        skill.source_display,
                        skill.repository,
                        skill.subdirectory,
                        skill.requested_ref,
                        skill.resolved_commit,
                        skill.version_label,
                        skill.content_hash,
                        skill.compatibility,
                        json.dumps(skill.permissions, ensure_ascii=False),
                        now,
                        now,
                    ),
                )
            if ids:
                placeholders = ",".join("?" for _ in ids)
                self._connection.execute(
                    f"DELETE FROM skills WHERE id NOT IN ({placeholders})",  # noqa: S608 - 占位符数量由集合长度生成。
                    tuple(sorted(ids)),
                )
            else:
                self._connection.execute("DELETE FROM skills")

    def snapshot(self) -> dict[str, list[dict[str, Any]]]:
        """返回管理界面需要的脱敏 Skill 摘要。"""
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT id, name, description, source_type, source_display,
                       repository, subdirectory, requested_ref,
                       version_label, resolved_commit, compatibility,
                       permissions_json, enabled, installed_at, updated_at, last_error,
                       (SELECT status FROM skill_runs WHERE skill_id = skills.id ORDER BY id DESC LIMIT 1) AS last_run_status,
                       (SELECT error_message FROM skill_runs WHERE skill_id = skills.id ORDER BY id DESC LIMIT 1) AS last_run_error,
                       (SELECT created_at FROM skill_runs WHERE skill_id = skills.id ORDER BY id DESC LIMIT 1) AS last_run_at
                FROM skills ORDER BY enabled DESC, name COLLATE NOCASE
                """
            ).fetchall()
        return {"skills": [_summary(row) for row in rows]}

    def get_internal(self, skill_id: str) -> dict[str, Any] | None:
        """返回 Runtime 内部激活所需记录。"""
        with self._lock:
            row = self._connection.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
        return dict(row) if row else None

    def set_enabled(self, skill_id: str, enabled: bool) -> bool:
        """更新 Skill 启用状态。"""
        with self._lock, self._connection:
            cursor = self._connection.execute(
                "UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?",
                (int(enabled), _now(), skill_id),
            )
        return cursor.rowcount > 0

    def begin_run(self, task_id: str, conversation_id: str, skill_id: str, trigger: str) -> int:
        """记录一次 Skill 调用开始。"""
        with self._lock, self._connection:
            cursor = self._connection.execute(
                """
                INSERT INTO skill_runs(task_id, conversation_id, skill_id, trigger, status, created_at)
                VALUES (?, ?, ?, ?, 'running', ?)
                """,
                (task_id, conversation_id, skill_id, trigger, _now()),
            )
        return int(cursor.lastrowid)

    def finish_run(
        self,
        run_id: int,
        status: str,
        duration_ms: int,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        """完成 Skill 运行记录并截断潜在敏感错误。"""
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE skill_runs
                SET status = ?, duration_ms = ?, error_code = ?, error_message = ?, completed_at = ?
                WHERE id = ?
                """,
                (status, duration_ms, error_code, (error_message or "")[:1000] or None, _now(), run_id),
            )

    def recent_runs(self, skill_id: str, limit: int = 50) -> list[dict[str, Any]]:
        """返回指定 Skill 的最近运行摘要。"""
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT id, skill_id, trigger, status, error_code, error_message,
                       duration_ms, created_at, completed_at
                FROM skill_runs WHERE skill_id = ? ORDER BY id DESC LIMIT ?
                """,
                (skill_id, max(1, min(limit, 100))),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "skillId": row["skill_id"],
                "trigger": row["trigger"],
                "status": row["status"],
                "errorCode": row["error_code"],
                "errorMessage": row["error_message"],
                "durationMs": row["duration_ms"],
                "createdAt": row["created_at"],
                "completedAt": row["completed_at"],
            }
            for row in rows
        ]

    def close(self) -> None:
        """关闭数据库连接。"""
        with self._lock:
            self._connection.close()


def _summary(row: sqlite3.Row) -> dict[str, Any]:
    """把数据库记录转换为 Renderer 安全摘要。"""
    commit = row["resolved_commit"]
    repository = row["repository"]
    requested_ref = row["requested_ref"]
    subdirectory = row["subdirectory"]
    source_url = None
    if row["source_type"] == "github" and repository:
        source_url = f"https://github.com/{repository}"
        if requested_ref:
            source_url += f"/tree/{requested_ref}"
            if subdirectory:
                source_url += f"/{subdirectory}"
    last_run = None
    if row["last_run_status"]:
        last_run = {
            "status": row["last_run_status"],
            "errorMessage": row["last_run_error"],
            "createdAt": row["last_run_at"],
        }
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "sourceType": row["source_type"],
        "sourceDisplay": row["source_display"],
        "sourceUrl": source_url,
        "versionLabel": row["version_label"] or (commit[:8] if commit else None),
        "resolvedCommit": commit,
        "compatibility": row["compatibility"],
        "permissions": json.loads(row["permissions_json"]),
        "enabled": bool(row["enabled"]),
        "installedAt": row["installed_at"],
        "updatedAt": row["updated_at"],
        "lastError": row["last_error"],
        "lastRun": last_run,
    }


def _now() -> str:
    """生成统一 UTC ISO 时间。"""
    return datetime.now(timezone.utc).isoformat()
