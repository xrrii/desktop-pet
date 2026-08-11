from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import yaml

"""Agent Skills 清单解析、路径校验和兼容性判断。"""

FRONTMATTER_LIMIT_BYTES = 64 * 1024
INSTRUCTIONS_LIMIT_BYTES = 256 * 1024
EXTENSION_MANIFEST_LIMIT_BYTES = 64 * 1024
SKILL_NAME_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
SUPPORTED_PERMISSIONS = {
    "knowledge.read",
    "memory.read",
    "memory.write",
    "network.read",
    "tool.open_url",
    "tool.open_app",
    "tool.open_path",
}
SkillCompatibility = Literal[
    "compatible",
    "instruction-only",
    "missing-dependencies",
    "unsupported-runtime",
    "invalid",
]


class SkillManifestError(ValueError):
    """表示 Skill 元数据、正文或路径不满足安全约束。"""

    def __init__(self, code: str, message: str) -> None:
        """保存稳定错误码和适合展示的中文错误。"""
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SkillMetadata:
    """只包含启动扫描允许读取的 Skill 元数据和内部定位信息。"""

    id: str
    name: str
    description: str
    root_path: Path
    instructions_path: Path
    permissions: tuple[str, ...]
    compatibility: SkillCompatibility
    version_label: str | None
    source_type: Literal["local", "github"]
    source_display: str
    repository: str | None
    subdirectory: str | None
    requested_ref: str | None
    resolved_commit: str | None
    content_hash: str


@dataclass(frozen=True)
class SkillActivation:
    """当前任务激活后才生成的完整 Skill 指令。"""

    metadata: SkillMetadata
    instructions: str


def parse_skill_metadata(skill_md: Path) -> SkillMetadata:
    """只读取 frontmatter 和小型扩展清单，生成归一化元数据。"""
    root = skill_md.parent.resolve(strict=True)
    if skill_md.is_symlink() or not skill_md.is_file():
        raise SkillManifestError("skill_invalid_manifest", "SKILL.md 必须是普通文件。")
    header = _read_frontmatter(skill_md)
    name = header.get("name")
    description = header.get("description")
    if not isinstance(name, str) or not SKILL_NAME_PATTERN.fullmatch(name):
        raise SkillManifestError(
            "skill_invalid_manifest",
            "Skill name 必须为 1 至 64 位小写字母、数字或连字符。",
        )
    if not isinstance(description, str) or not description.strip() or len(description.strip()) > 1024:
        raise SkillManifestError(
            "skill_invalid_manifest",
            "Skill description 必须为 1 至 1024 个字符。",
        )

    extension = _read_extension_manifest(root)
    source = _read_source_metadata(root)
    permissions = _parse_permissions(extension.get("permissions", []))
    version = extension.get("version")
    if version is not None and (not isinstance(version, str) or len(version) > 64):
        raise SkillManifestError("skill_invalid_manifest", "skill.json version 无效。")

    scripts_path = root / "scripts"
    compatibility: SkillCompatibility = "instruction-only" if scripts_path.exists() else "compatible"
    source_type = "github" if source.get("provider") == "github" else "local"
    repository = _optional_string(source.get("repository"), 256)
    subdirectory = _optional_string(source.get("subdirectory"), 1024)
    requested_ref = _optional_string(source.get("ref"), 256)
    resolved_commit = _optional_string(source.get("commit"), 64)
    source_display = repository if source_type == "github" and repository else "本地安装"

    return SkillMetadata(
        id=name,
        name=name,
        description=" ".join(description.split()),
        root_path=root,
        instructions_path=skill_md.resolve(strict=True),
        permissions=permissions,
        compatibility=compatibility,
        version_label=version,
        source_type=source_type,
        source_display=source_display,
        repository=repository,
        subdirectory=subdirectory,
        requested_ref=requested_ref,
        resolved_commit=resolved_commit,
        content_hash=_optional_string(source.get("contentHash"), 128) or "",
    )


def load_skill_instructions(metadata: SkillMetadata) -> SkillActivation:
    """在 Skill 被激活时读取正文，启动扫描不会调用本方法。"""
    path = metadata.instructions_path
    if path.is_symlink() or not _is_within(path.resolve(strict=True), metadata.root_path):
        raise SkillManifestError("skill_content_changed", "Skill 入口已离开安装目录。")
    raw = path.read_bytes()
    if len(raw) > INSTRUCTIONS_LIMIT_BYTES:
        raise SkillManifestError("skill_instruction_too_large", "Skill 指令超过 256 KB 上限。")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise SkillManifestError("skill_invalid_manifest", "SKILL.md 必须使用 UTF-8 编码。") from error
    match = re.match(r"\A---\r?\n.*?\r?\n---\r?\n?", text, flags=re.DOTALL)
    if not match:
        raise SkillManifestError("skill_invalid_manifest", "SKILL.md frontmatter 无效。")
    instructions = text[match.end() :].strip()
    if not instructions:
        raise SkillManifestError("skill_invalid_manifest", "SKILL.md 缺少技能正文。")
    return SkillActivation(metadata=metadata, instructions=instructions)


def discover_skill_files(root: Path, max_depth: int = 4) -> list[Path]:
    """在受限深度内发现 SKILL.md，跳过链接、隐藏目录和构建目录。"""
    if not root.exists():
        return []
    root = root.resolve(strict=True)
    ignored = {".git", "node_modules", "build", "dist", "release", "__pycache__"}
    candidates: list[Path] = []
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        depth = len(current_path.relative_to(root).parts)
        directories[:] = sorted(
            directory
            for directory in directories
            if depth < max_depth
            and not directory.startswith(".")
            and directory not in ignored
            and not (current_path / directory).is_symlink()
        )
        if "SKILL.md" in files:
            candidate = current_path / "SKILL.md"
            if not candidate.is_symlink():
                candidates.append(candidate)
    return sorted(candidates, key=lambda item: str(item).casefold())


def calculate_package_hash(root: Path) -> str:
    """对安装包普通文件计算确定性摘要，拒绝符号链接和根目录逃逸。"""
    root = root.resolve(strict=True)
    digest = hashlib.sha256()
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        directories[:] = sorted(directory for directory in directories if not (current_path / directory).is_symlink())
        for filename in sorted(files):
            if filename == ".petdock-source.json":
                continue
            path = current_path / filename
            if path.is_symlink():
                raise SkillManifestError("skill_invalid_manifest", "Skill 包不能包含符号链接。")
            resolved = path.resolve(strict=True)
            if not _is_within(resolved, root):
                raise SkillManifestError("skill_invalid_manifest", "Skill 文件超出安装目录。")
            relative = resolved.relative_to(root).as_posix().encode("utf-8")
            digest.update(len(relative).to_bytes(4, "big"))
            digest.update(relative)
            with resolved.open("rb") as stream:
                while block := stream.read(64 * 1024):
                    digest.update(block)
    return digest.hexdigest()


def _read_frontmatter(path: Path) -> dict[str, Any]:
    """流式读取有上限的 YAML frontmatter，绝不读取整个正文。"""
    with path.open("rb") as stream:
        raw = stream.read(FRONTMATTER_LIMIT_BYTES + 1)
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    if not raw.startswith((b"---\n", b"---\r\n")):
        raise SkillManifestError("skill_invalid_manifest", "SKILL.md 必须以 YAML frontmatter 开头。")
    match = re.search(br"\r?\n---\r?\n", raw[4:])
    if not match:
        raise SkillManifestError("skill_invalid_manifest", "SKILL.md frontmatter 未在 64 KB 内结束。")
    prefix_length = 4
    yaml_bytes = raw[prefix_length : prefix_length + match.start()]
    try:
        value = yaml.safe_load(yaml_bytes.decode("utf-8"))
    except (UnicodeDecodeError, yaml.YAMLError) as error:
        raise SkillManifestError("skill_invalid_manifest", "SKILL.md frontmatter 不是安全的 UTF-8 YAML。") from error
    if not isinstance(value, dict):
        raise SkillManifestError("skill_invalid_manifest", "SKILL.md frontmatter 必须是对象。")
    return value


def _read_extension_manifest(root: Path) -> dict[str, Any]:
    """读取可选 PetDock 扩展清单。"""
    path = root / "skill.json"
    if not path.exists():
        return {}
    if path.is_symlink() or path.stat().st_size > EXTENSION_MANIFEST_LIMIT_BYTES:
        raise SkillManifestError("skill_invalid_manifest", "skill.json 不是合法的小型普通文件。")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SkillManifestError("skill_invalid_manifest", "skill.json 必须是 UTF-8 JSON。") from error
    if not isinstance(value, dict) or value.get("schemaVersion", 1) != 1:
        raise SkillManifestError("skill_invalid_manifest", "skill.json schemaVersion 不受支持。")
    return value


def _read_source_metadata(root: Path) -> dict[str, Any]:
    """读取由 PetDock 安装器生成的来源元数据。"""
    path = root / ".petdock-source.json"
    if not path.exists() or path.is_symlink() or path.stat().st_size > EXTENSION_MANIFEST_LIMIT_BYTES:
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _parse_permissions(value: object) -> tuple[str, ...]:
    """校验扩展清单权限，未知权限不能被静默忽略。"""
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise SkillManifestError("skill_invalid_manifest", "skill.json permissions 必须是字符串数组。")
    unknown = sorted(set(value) - SUPPORTED_PERMISSIONS)
    if unknown:
        raise SkillManifestError("skill_invalid_manifest", f"Skill 声明了未知权限：{', '.join(unknown)}")
    return tuple(sorted(set(value)))


def _optional_string(value: object, max_length: int) -> str | None:
    """读取有长度限制的可选字符串。"""
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:max_length] if text else None


def _is_within(path: Path, root: Path) -> bool:
    """判断真实路径是否位于指定根目录。"""
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
