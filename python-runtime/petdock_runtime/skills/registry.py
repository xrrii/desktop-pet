from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path

from .manifest import (
    SkillActivation,
    SkillManifestError,
    SkillMetadata,
    calculate_package_hash,
    discover_skill_files,
    load_skill_instructions,
    parse_skill_metadata,
)
from .store import SkillStore

"""Skill 元数据注册表、渐进式披露和资源读取。"""

LOGGER = logging.getLogger("petdock.skills")
MODEL_METADATA_BUDGET = 8_000
MODEL_CANDIDATE_LIMIT = 20
SEARCH_RESULT_LIMIT = 10
RESOURCE_FILE_LIMIT = 512 * 1024
RESOURCE_RESPONSE_LIMIT = 64 * 1024
RESOURCE_PATH_PATTERN = re.compile(r"^(references|assets)/[^\\]+(?:/[^\\]+)*$")


class SkillRegistry:
    """只缓存 Skill 元数据，正文和资源均在任务需要时加载。"""

    def __init__(self, packages_root: str, store: SkillStore) -> None:
        """绑定安装目录和状态存储，并执行首次元数据扫描。"""
        self._root = Path(packages_root)
        self._root.mkdir(parents=True, exist_ok=True)
        self._store = store
        self._metadata: dict[str, SkillMetadata] = {}
        self._lock = threading.RLock()
        self.refresh()

    @property
    def store(self) -> SkillStore:
        """仅向同一 Runtime 内的安装器提供状态存储。"""
        return self._store

    def refresh(self) -> dict[str, object]:
        """重新扫描 frontmatter；不会读取任意 Skill 正文。"""
        discovered: dict[str, SkillMetadata] = {}
        errors: list[dict[str, str]] = []
        for path in discover_skill_files(self._root):
            try:
                metadata = parse_skill_metadata(path)
                if metadata.id in discovered:
                    raise SkillManifestError("skill_name_conflict", f"Skill 名称重复：{metadata.id}")
                discovered[metadata.id] = metadata
            except (OSError, SkillManifestError) as error:
                code = error.code if isinstance(error, SkillManifestError) else "skill_invalid_manifest"
                errors.append({"code": code, "message": str(error)[:500]})
                LOGGER.warning("Skill 元数据扫描失败：%s", str(error))
        with self._lock:
            self._metadata = discovered
            self._store.synchronize(list(discovered.values()))
        LOGGER.info("Skill 元数据扫描完成：skills=%d errors=%d", len(discovered), len(errors))
        return {"count": len(discovered), "errors": errors}

    def snapshot(self) -> dict[str, object]:
        """返回脱敏 Skill 列表和扫描状态。"""
        return self._store.snapshot()

    def set_enabled(self, skill_id: str, enabled: bool) -> bool:
        """启用或禁用已经注册的 Skill。"""
        self._validate_id(skill_id)
        return self._store.set_enabled(skill_id, enabled)

    def metadata_catalog(self, query: str = "") -> list[dict[str, str]]:
        """按本地相关度返回名称和描述，不披露正文。"""
        query_tokens = _tokens(query)
        candidates: list[tuple[int, SkillMetadata]] = []
        with self._lock:
            metadata_values = list(self._metadata.values())
        for metadata in metadata_values:
            record = self._store.get_internal(metadata.id)
            if not record or not bool(record["enabled"]):
                continue
            haystack = f"{metadata.name} {metadata.description}".casefold()
            score = sum(3 if token in metadata.name else 1 for token in query_tokens if token in haystack)
            candidates.append((score, metadata))
        candidates.sort(key=lambda item: (-item[0], item[1].name))
        limit = SEARCH_RESULT_LIMIT if query.strip() else MODEL_CANDIDATE_LIMIT
        return [
            {"name": metadata.name, "description": metadata.description}
            for _, metadata in candidates[:limit]
        ]

    def model_catalog(self, query: str) -> str:
        """在固定字符预算内生成模型可见的紧凑元数据目录。"""
        lines: list[str] = []
        used = 0
        for item in self.metadata_catalog(query):
            line = f"- {item['name']}：{item['description']}"
            if used + len(line) > MODEL_METADATA_BUDGET:
                break
            lines.append(line)
            used += len(line)
        return "\n".join(lines)

    def activate(self, skill_id: str) -> SkillActivation:
        """校验启用状态后按需读取完整 Skill 指令。"""
        self._validate_id(skill_id)
        with self._lock:
            metadata = self._metadata.get(skill_id)
        record = self._store.get_internal(skill_id)
        if not metadata or not record:
            raise SkillManifestError("skill_not_found", "Skill 不存在。")
        if not bool(record["enabled"]):
            raise SkillManifestError("skill_disabled", "Skill 已禁用。")
        if metadata.compatibility == "invalid":
            raise SkillManifestError("skill_incompatible", "Skill 当前不可用。")
        if metadata.content_hash and calculate_package_hash(metadata.root_path) != metadata.content_hash:
            raise SkillManifestError("skill_content_changed", "Skill 内容已在安装后发生变化，请刷新或重新安装。")
        return load_skill_instructions(metadata)

    def read_resource(self, skill_id: str, resource_path: str) -> str:
        """按需读取当前 Skill 内允许的 UTF-8 文本资源。"""
        activation = self.activate(skill_id)
        normalized = resource_path.replace("\\", "/").strip("/")
        if not RESOURCE_PATH_PATTERN.fullmatch(normalized) or ".." in normalized.split("/"):
            raise SkillManifestError("skill_resource_denied", "资源路径不在允许目录中。")
        candidate = activation.metadata.root_path.joinpath(*normalized.split("/"))
        if candidate.is_symlink() or not candidate.is_file():
            raise SkillManifestError("skill_resource_not_found", "Skill 资源不存在。")
        resolved = candidate.resolve(strict=True)
        try:
            resolved.relative_to(activation.metadata.root_path)
        except ValueError as error:
            raise SkillManifestError("skill_resource_denied", "资源路径超出 Skill 目录。") from error
        if resolved.stat().st_size > RESOURCE_FILE_LIMIT:
            raise SkillManifestError("skill_resource_too_large", "Skill 资源超过 512 KB 上限。")
        try:
            content = resolved.read_text(encoding="utf-8")
        except UnicodeDecodeError as error:
            raise SkillManifestError("skill_resource_denied", "二进制资源不能进入模型上下文。") from error
        encoded = content.encode("utf-8")
        if len(encoded) > RESOURCE_RESPONSE_LIMIT:
            content = encoded[:RESOURCE_RESPONSE_LIMIT].decode("utf-8", errors="ignore")
        return content

    def permissions_for(self, skill_id: str) -> set[str]:
        """返回 Skill 声明的权限集合。"""
        with self._lock:
            metadata = self._metadata.get(skill_id)
        return set(metadata.permissions) if metadata else set()

    def begin_run(self, task_id: str, conversation_id: str, skill_id: str, trigger: str) -> int:
        """记录 Skill 激活。"""
        return self._store.begin_run(task_id, conversation_id, skill_id, trigger)

    def finish_run(
        self,
        run_id: int,
        status: str,
        duration_ms: int,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        """记录 Skill 完成或失败。"""
        self._store.finish_run(run_id, status, duration_ms, error_code, error_message)

    def recent_runs(self, skill_id: str) -> list[dict[str, object]]:
        """读取最近运行日志。"""
        self._validate_id(skill_id)
        return self._store.recent_runs(skill_id)

    def close(self) -> None:
        """关闭 Skill 状态存储。"""
        self._store.close()

    @staticmethod
    def _validate_id(skill_id: str) -> None:
        """限制外部 API 提交的 Skill ID。"""
        if not isinstance(skill_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", skill_id):
            raise SkillManifestError("skill_not_found", "Skill ID 无效。")


def _tokens(query: str) -> list[str]:
    """生成简单确定性检索词，避免为元数据检索引入模型调用。"""
    normalized = query.casefold().strip()
    latin = re.findall(r"[a-z0-9-]{2,}", normalized)
    chinese = [char for char in normalized if "\u4e00" <= char <= "\u9fff"]
    return list(dict.fromkeys([*latin, *chinese]))
