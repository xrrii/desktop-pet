from __future__ import annotations

import json
import os
import re
import shutil
import stat
import tempfile
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlparse
from uuid import uuid4

import httpx

from .manifest import (
    SkillManifestError,
    SkillMetadata,
    calculate_package_hash,
    discover_skill_files,
    parse_skill_metadata,
)
from .registry import SkillRegistry

"""本地和 GitHub Skill 的预览、安全解压与原子安装。"""

ARCHIVE_LIMIT_BYTES = 25 * 1024 * 1024
EXTRACTED_LIMIT_BYTES = 50 * 1024 * 1024
SINGLE_FILE_LIMIT_BYTES = 5 * 1024 * 1024
PACKAGE_FILE_LIMIT = 500
PREVIEW_LIMIT = 50
PREVIEW_TTL_SECONDS = 15 * 60
ALLOWED_ARCHIVE_HOSTS = {"api.github.com", "codeload.github.com"}
WINDOWS_RESERVED_NAMES = {
    "con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))
}


@dataclass(frozen=True)
class InstallCandidate:
    """保存安装候选的元数据和确认前摘要。"""

    metadata: SkillMetadata
    content_hash: str
    relative_path: str


@dataclass
class InstallPreview:
    """保存等待用户确认的临时预览。"""

    token: str
    source_type: str
    candidates: dict[str, InstallCandidate]
    source_metadata: dict[str, object]
    expires_at: float
    temporary_root: Path | None = None


class SkillInstaller:
    """完成本地和 GitHub 来源的预览、安装与卸载。"""

    def __init__(self, packages_root: str, registry: SkillRegistry) -> None:
        """创建同卷临时目录并绑定安装后的热刷新注册表。"""
        self._packages_root = Path(packages_root)
        self._packages_root.mkdir(parents=True, exist_ok=True)
        self._temp_root = self._packages_root.parent / "temp"
        self._temp_root.mkdir(parents=True, exist_ok=True)
        self._registry = registry
        self._previews: dict[str, InstallPreview] = {}

    def preview_local(self, source_path: str) -> dict[str, object]:
        """扫描 Electron Main 原生选择器授权的本地目录。"""
        self._cleanup_expired()
        source = Path(source_path).resolve(strict=True)
        if not source.is_dir() or source.is_symlink():
            raise SkillManifestError("skill_install_failed", "本地 Skill 来源必须是普通目录。")
        candidates = self._scan_candidates(source)
        return self._save_preview("local", candidates, {"provider": "local"})

    async def preview_github(self, github_url: str) -> dict[str, object]:
        """解析公开仓库 commit，下载并安全解压后返回候选。"""
        self._cleanup_expired()
        owner, repository, requested_ref, subdirectory = _parse_github_url(github_url)
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "PetDock/0.1.1"}
        temporary_root = Path(tempfile.mkdtemp(prefix="github-", dir=self._temp_root))
        archive = temporary_root / "repository.zip"
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True, headers=headers) as client:
                if not requested_ref:
                    repository_response = await client.get(
                        f"https://api.github.com/repos/{owner}/{repository}"
                    )
                    if repository_response.status_code != 200:
                        raise SkillManifestError("github_repository_unavailable", "无法读取 GitHub 仓库信息。")
                    repository_payload = repository_response.json()
                    requested_ref = (
                        repository_payload.get("default_branch")
                        if isinstance(repository_payload, dict)
                        else None
                    )
                    if not isinstance(requested_ref, str) or not requested_ref:
                        raise SkillManifestError("github_commit_unresolved", "无法确定 GitHub 默认分支。")
                response = await client.get(
                    f"https://api.github.com/repos/{owner}/{repository}/commits/{requested_ref}"
                )
                if response.status_code == 403:
                    raise SkillManifestError("github_rate_limited", "GitHub API 请求受限，请稍后重试。")
                if response.status_code != 200:
                    raise SkillManifestError("github_commit_unresolved", "无法解析 GitHub 分支或提交。")
                payload = response.json()
                commit = payload.get("sha") if isinstance(payload, dict) else None
                if not isinstance(commit, str) or not re.fullmatch(r"[a-f0-9]{40}", commit):
                    raise SkillManifestError("github_commit_unresolved", "GitHub 返回了无效 commit。")
                await self._download_archive(
                    client,
                    f"https://api.github.com/repos/{owner}/{repository}/zipball/{commit}",
                    archive,
                )
            extracted = temporary_root / "extracted"
            _safe_extract_zip(archive, extracted)
            roots = [item for item in extracted.iterdir() if item.is_dir()]
            if len(roots) != 1:
                raise SkillManifestError("github_archive_invalid", "GitHub 归档根目录无效。")
            source_root = roots[0]
            if subdirectory:
                source_root = source_root.joinpath(*subdirectory.split("/"))
                if not source_root.is_dir() or not _is_within(source_root.resolve(), roots[0].resolve()):
                    raise SkillManifestError("github_archive_invalid", "GitHub Skill 子目录不存在。")
            candidates = self._scan_candidates(source_root)
            return self._save_preview(
                "github",
                candidates,
                {
                    "provider": "github",
                    "repository": f"{owner}/{repository}",
                    "subdirectory": subdirectory,
                    "ref": requested_ref,
                    "commit": commit,
                },
                temporary_root,
            )
        except Exception:
            shutil.rmtree(temporary_root, ignore_errors=True)
            raise

    def install(self, preview_token: str, skill_ids: list[str]) -> dict[str, object]:
        """重新核对摘要并原子安装用户勾选的 Skill。"""
        self._cleanup_expired()
        preview = self._previews.get(preview_token)
        selected = list(dict.fromkeys(skill_ids))
        if not preview or preview.expires_at <= time.monotonic():
            raise SkillManifestError("skill_install_failed", "Skill 安装预览已失效。")
        if not selected or any(skill_id not in preview.candidates for skill_id in selected):
            raise SkillManifestError("skill_install_failed", "待安装 Skill 选择无效。")
        candidates: list[InstallCandidate] = []
        for skill_id in selected:
            candidate = preview.candidates[skill_id]
            _validate_package(candidate.metadata.root_path)
            if calculate_package_hash(candidate.metadata.root_path) != candidate.content_hash:
                raise SkillManifestError("skill_content_changed", f"Skill {skill_id} 在确认前发生变化。")
            candidates.append(candidate)
        self._install_candidates(candidates, preview.source_metadata)
        self._dispose_preview(preview_token)
        self._registry.refresh()
        return {"installed": selected, "snapshot": self._registry.snapshot()}

    def uninstall(self, skill_id: str) -> bool:
        """删除托管安装包，拒绝删除 packages 根目录以外路径。"""
        record = self._registry.store.get_internal(skill_id)
        if not record:
            return False
        target = Path(str(record["root_path"])).resolve(strict=True)
        root = self._packages_root.resolve(strict=True)
        if target.parent != root or target.name != skill_id or not _is_within(target, root):
            raise SkillManifestError("skill_install_failed", "拒绝卸载非托管 Skill 路径。")
        shutil.rmtree(target)
        self._registry.refresh()
        return True

    async def _download_archive(self, client: httpx.AsyncClient, url: str, target: Path) -> None:
        """流式下载归档，并验证最终和中间重定向域名。"""
        async with client.stream("GET", url) as response:
            hosts = [item.url.host for item in response.history] + [response.url.host]
            if response.status_code != 200 or any(host not in ALLOWED_ARCHIVE_HOSTS for host in hosts):
                raise SkillManifestError("github_repository_unavailable", "GitHub 归档下载失败。")
            declared = response.headers.get("content-length")
            if declared and int(declared) > ARCHIVE_LIMIT_BYTES:
                raise SkillManifestError("github_download_too_large", "GitHub 归档超过 25 MB 上限。")
            written = 0
            with target.open("wb") as stream:
                async for block in response.aiter_bytes(64 * 1024):
                    written += len(block)
                    if written > ARCHIVE_LIMIT_BYTES:
                        raise SkillManifestError("github_download_too_large", "GitHub 归档超过 25 MB 上限。")
                    stream.write(block)

    def _scan_candidates(self, source_root: Path) -> list[InstallCandidate]:
        """解析受限数量候选，并计算确认时使用的内容摘要。"""
        root_entry = source_root / "SKILL.md"
        paths = [root_entry] if root_entry.is_file() and not root_entry.is_symlink() else discover_skill_files(source_root)
        if not paths:
            raise SkillManifestError("skill_invalid_manifest", "所选来源中没有找到 SKILL.md。")
        if len(paths) > PREVIEW_LIMIT:
            raise SkillManifestError("skill_install_failed", "Skill 候选超过 50 个，请缩小子目录。")
        candidates: list[InstallCandidate] = []
        seen: set[str] = set()
        for path in paths:
            metadata = parse_skill_metadata(path)
            if metadata.id in seen:
                raise SkillManifestError("skill_name_conflict", f"Skill 名称重复：{metadata.id}")
            seen.add(metadata.id)
            _validate_package(metadata.root_path)
            candidates.append(
                InstallCandidate(
                    metadata,
                    calculate_package_hash(metadata.root_path),
                    metadata.root_path.relative_to(source_root).as_posix() or ".",
                )
            )
        return candidates

    def _save_preview(
        self,
        source_type: str,
        candidates: list[InstallCandidate],
        source_metadata: dict[str, object],
        temporary_root: Path | None = None,
    ) -> dict[str, object]:
        """保存有时限预览并返回脱敏候选。"""
        token = uuid4().hex
        preview = InstallPreview(
            token,
            source_type,
            {item.metadata.id: item for item in candidates},
            source_metadata,
            time.monotonic() + PREVIEW_TTL_SECONDS,
            temporary_root,
        )
        self._previews[token] = preview
        return {
            "previewToken": token,
            "sourceType": source_type,
            "sourceDisplay": source_metadata.get("repository", "本地目录"),
            "resolvedCommit": source_metadata.get("commit"),
            "expiresInSeconds": PREVIEW_TTL_SECONDS,
            "candidates": [
                {
                    "id": item.metadata.id,
                    "name": item.metadata.name,
                    "description": item.metadata.description,
                    "relativePath": item.relative_path,
                    "compatibility": item.metadata.compatibility,
                    "permissions": list(item.metadata.permissions),
                }
                for item in candidates
            ],
        }

    def _install_candidates(
        self,
        candidates: list[InstallCandidate],
        source: dict[str, object],
    ) -> None:
        """统一暂存选中候选，并在任一替换失败时逆序恢复旧版本。"""
        stage = Path(tempfile.mkdtemp(prefix="install-batch-", dir=self._temp_root))
        prepared: list[tuple[Path, Path, Path]] = []
        swapped: list[tuple[Path, Path | None]] = []
        committed = False
        try:
            # 先完成全部复制和清单复核，避免准备阶段失败时触碰现有安装。
            for candidate in candidates:
                staged_package = stage / candidate.metadata.id
                target = self._packages_root / candidate.metadata.id
                backup = self._temp_root / f"backup-{candidate.metadata.id}-{uuid4().hex}"
                _copy_package(candidate.metadata.root_path, staged_package)
                payload = {**source, "contentHash": candidate.content_hash}
                (staged_package / ".petdock-source.json").write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                parse_skill_metadata(staged_package / "SKILL.md")
                prepared.append((staged_package, target, backup))

            # 同卷重命名单包原子；批次失败时借助备份恢复已交换的目标。
            for staged_package, target, backup in prepared:
                if target.is_symlink() or (target.exists() and not target.is_dir()):
                    raise SkillManifestError("skill_install_failed", "Skill 安装目标不是受管普通目录。")
                previous = backup if target.exists() else None
                if previous:
                    os.replace(target, previous)
                swapped.append((target, previous))
                os.replace(staged_package, target)
            committed = True
        except Exception:
            for target, backup in reversed(swapped):
                if target.exists() and target.is_dir() and not target.is_symlink():
                    shutil.rmtree(target)
                if backup and backup.exists():
                    os.replace(backup, target)
            raise
        finally:
            if committed:
                for _, backup in swapped:
                    if backup:
                        shutil.rmtree(backup, ignore_errors=True)
            shutil.rmtree(stage, ignore_errors=True)

    def _cleanup_expired(self) -> None:
        """清理过期预览。"""
        for token, preview in list(self._previews.items()):
            if preview.expires_at <= time.monotonic():
                self._dispose_preview(token)

    def _dispose_preview(self, token: str) -> None:
        """释放预览和 GitHub 临时目录。"""
        preview = self._previews.pop(token, None)
        if preview and preview.temporary_root:
            shutil.rmtree(preview.temporary_root, ignore_errors=True)


def _parse_github_url(value: str) -> tuple[str, str, str, str]:
    """解析仓库根目录或 tree/单段-ref/子目录 URL。"""
    parsed = urlparse(value.strip())
    if (
        parsed.scheme != "https"
        or parsed.hostname != "github.com"
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise SkillManifestError("github_url_invalid", "只允许不含凭据的 GitHub HTTPS URL。")
    parts = [unquote(part) for part in parsed.path.strip("/").split("/") if part]
    if len(parts) < 2 or any(not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", part) for part in parts[:2]):
        raise SkillManifestError("github_url_invalid", "GitHub 仓库 URL 无效。")
    owner, repository = parts[0], parts[1].removesuffix(".git")
    ref, subdirectory = "", ""
    if len(parts) > 2:
        if len(parts) < 4 or parts[2] != "tree":
            raise SkillManifestError("github_url_invalid", "只支持仓库根目录或 tree/ref/子目录。")
        ref = parts[3]
        if any(part in {".", ".."} or "\\" in part for part in parts[4:]):
            raise SkillManifestError("github_url_invalid", "GitHub 子目录无效。")
        subdirectory = "/".join(parts[4:])
    return owner, repository, ref, subdirectory


def _safe_extract_zip(archive: Path, target: Path) -> None:
    """逐条目解压 ZIP，拒绝链接、路径穿越和资源炸弹。"""
    target.mkdir(parents=True, exist_ok=False)
    target_root = target.resolve(strict=True)
    total_size = 0
    file_count = 0
    normalized_paths: set[str] = set()
    try:
        with zipfile.ZipFile(archive) as source:
            for info in source.infolist():
                path = PurePosixPath(info.filename)
                if (
                    path.is_absolute()
                    or not path.parts
                    or any(
                        part in {"", ".", ".."} or "\\" in part or ":" in part
                        for part in path.parts
                    )
                ):
                    raise SkillManifestError("github_archive_invalid", "GitHub 归档包含不安全路径。")
                if any(_is_reserved_name(part) for part in path.parts):
                    raise SkillManifestError("github_archive_invalid", "GitHub 归档包含 Windows 保留名称。")
                normalized = "/".join(part.casefold() for part in path.parts)
                if normalized in normalized_paths:
                    raise SkillManifestError("github_archive_invalid", "GitHub 归档包含大小写重名路径。")
                normalized_paths.add(normalized)
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise SkillManifestError("github_archive_invalid", "GitHub 归档不能包含符号链接。")
                destination = target.joinpath(*path.parts)
                if not _is_within(destination.resolve(strict=False), target_root):
                    raise SkillManifestError("github_archive_invalid", "GitHub 归档路径超出临时目录。")
                if info.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                file_count += 1
                total_size += info.file_size
                if file_count > PACKAGE_FILE_LIMIT * PREVIEW_LIMIT or info.file_size > SINGLE_FILE_LIMIT_BYTES:
                    raise SkillManifestError("github_archive_invalid", "GitHub 归档文件数量或单文件大小超限。")
                if total_size > EXTRACTED_LIMIT_BYTES:
                    raise SkillManifestError("github_archive_invalid", "GitHub 归档解压后超过 50 MB。")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with source.open(info) as input_stream, destination.open("wb") as output_stream:
                    shutil.copyfileobj(input_stream, output_stream, 64 * 1024)
    except (zipfile.BadZipFile, RuntimeError) as error:
        shutil.rmtree(target, ignore_errors=True)
        raise SkillManifestError("github_archive_invalid", "GitHub ZIP 归档损坏或加密。") from error
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise


def _validate_package(root: Path) -> None:
    """限制单 Skill 文件数、大小、链接和真实路径。"""
    root = root.resolve(strict=True)
    count = 0
    total = 0
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        if any((current_path / directory).is_symlink() for directory in directories):
            raise SkillManifestError("skill_install_failed", "Skill 包不能包含符号链接目录。")
        for filename in files:
            path = current_path / filename
            if path.is_symlink():
                raise SkillManifestError("skill_install_failed", "Skill 包不能包含符号链接文件。")
            resolved = path.resolve(strict=True)
            if not _is_within(resolved, root):
                raise SkillManifestError("skill_install_failed", "Skill 文件超出来源目录。")
            size = resolved.stat().st_size
            count += 1
            total += size
            if count > PACKAGE_FILE_LIMIT or size > SINGLE_FILE_LIMIT_BYTES or total > EXTRACTED_LIMIT_BYTES:
                raise SkillManifestError("skill_install_failed", "Skill 包文件数量或大小超限。")


def _copy_package(source: Path, target: Path) -> None:
    """复制已验证普通文件，并忽略来源伪造的内部元数据。"""
    target.mkdir(parents=True, exist_ok=False)
    for current, directories, files in os.walk(source, followlinks=False):
        current_path = Path(current)
        destination = target / current_path.relative_to(source)
        destination.mkdir(parents=True, exist_ok=True)
        directories[:] = sorted(directory for directory in directories if not (current_path / directory).is_symlink())
        for filename in sorted(files):
            if filename == ".petdock-source.json":
                continue
            path = current_path / filename
            if path.is_symlink():
                raise SkillManifestError("skill_install_failed", "Skill 包复制时出现符号链接。")
            shutil.copy2(path, destination / filename)


def _is_reserved_name(part: str) -> bool:
    """检查 Windows 保留设备名和盘符。"""
    stem = part.rstrip(" .").split(".", 1)[0].casefold()
    return (
        part != part.rstrip(" .")
        or stem in WINDOWS_RESERVED_NAMES
        or bool(re.fullmatch(r"[A-Za-z]:", part))
    )


def _is_within(path: Path, root: Path) -> bool:
    """判断路径是否位于根目录。"""
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
