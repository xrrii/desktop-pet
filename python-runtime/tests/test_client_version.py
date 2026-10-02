from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from petdock_runtime.config import RuntimeConfig, resolve_client_version


def test_source_version_is_independent_of_working_directory(monkeypatch, tmp_path) -> None:
    """开发环境的两个配置入口都读取项目版本，不依赖进程当前目录。"""
    monkeypatch.delenv("PETDOCK_CLIENT_VERSION", raising=False)
    monkeypatch.delattr(sys, "_MEIPASS", raising=False)
    metadata = Path(__file__).resolve().parents[2] / "package.json"
    version = json.loads(metadata.read_text(encoding="utf-8"))["version"]
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PETDOCK_RUNTIME_TOKEN", "t" * 64)
    monkeypatch.setenv("PETDOCK_ASSISTANT_BACKEND", "mock")

    assert resolve_client_version() == version
    assert RuntimeConfig("t" * 64, "mock", None, None, "unused").managed_client_version == version
    assert RuntimeConfig.from_environment().managed_client_version == version


def test_packaged_version_uses_bundled_metadata(monkeypatch, tmp_path) -> None:
    """模拟 PyInstaller 解包目录，版本不能回落到开发源码元数据。"""
    monkeypatch.delenv("PETDOCK_CLIENT_VERSION", raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    (tmp_path / "package.json").write_text(json.dumps({"version": "9.8.7"}), encoding="utf-8")

    assert resolve_client_version() == "9.8.7"


def test_main_injection_precedes_missing_bundled_metadata(monkeypatch, tmp_path) -> None:
    """Main 的实际版本优先，不要求为已注入版本读取备用文件。"""
    monkeypatch.setenv("PETDOCK_CLIENT_VERSION", " 9.7.5 ")
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)

    assert resolve_client_version() == "9.7.5"


@pytest.mark.parametrize("value", ["", "dev"])
def test_invalid_main_injection_does_not_fall_back(monkeypatch, value) -> None:
    """显式空值和非法版本仍应拒绝，不能被默认版本掩盖。"""
    monkeypatch.setenv("PETDOCK_CLIENT_VERSION", value)

    with pytest.raises(ValueError, match="PETDOCK_CLIENT_VERSION 格式无效"):
        resolve_client_version()


@pytest.mark.parametrize("content", [None, "{invalid", '{"version":42}', '[]'])
def test_missing_or_invalid_bundled_metadata_fails(monkeypatch, tmp_path, content) -> None:
    """随包元数据缺失或损坏时停止，不能报告固定旧版本。"""
    monkeypatch.delenv("PETDOCK_CLIENT_VERSION", raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    if content is not None:
        (tmp_path / "package.json").write_text(content, encoding="utf-8")

    with pytest.raises(ValueError, match="应用版本元数据|PETDOCK_CLIENT_VERSION 格式无效"):
        resolve_client_version()
