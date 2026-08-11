"""C4 Vision Analyzer 探测、错误分类、隔离输出和缓存测试。"""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest
from PIL import Image

import petdock_runtime.vision.analyzer as vision_module
from petdock_runtime.vision.analyzer import VisionAnalyzer, VisionConfiguration, VisionRequestError


class _FakeClient:
    """为视觉 HTTP 分类测试提供不联网的异步客户端。"""

    def __init__(self, response: httpx.Response | Exception) -> None:
        """保存预设响应或异常。"""
        self.response = response

    async def __aenter__(self) -> "_FakeClient":
        """进入异步上下文。"""
        return self

    async def __aexit__(self, *_args: object) -> None:
        """退出异步上下文。"""

    async def post(self, *_args: object, **_kwargs: object) -> httpx.Response:
        """返回预设响应，或模拟网络异常。"""
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def _analyzer(tmp_path: Path) -> VisionAnalyzer:
    """创建使用固定测试配置的隔离 Analyzer。"""
    return VisionAnalyzer(
        VisionConfiguration("https://vision.invalid/v1", "secret", "vision-model", "custom"),
        str(tmp_path / "vision.db"),
    )


def test_probe_requires_random_code_match(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """只有模型正确读取随机验证码时状态才可变为 supported。"""
    analyzer = _analyzer(tmp_path)
    monkeypatch.setattr(vision_module.secrets, "randbelow", lambda _limit: 123456)

    async def success(*_args: object, **_kwargs: object) -> str:
        """模拟模型正确读取验证码。"""
        return "123456"

    monkeypatch.setattr(analyzer, "_request", success)
    assert asyncio.run(analyzer.probe())["status"] == "supported"

    async def mismatch(*_args: object, **_kwargs: object) -> str:
        """模拟文本模型无法读取图片。"""
        return "654321"

    monkeypatch.setattr(analyzer, "_request", mismatch)
    assert asyncio.run(analyzer.probe())["status"] == "unsupported"
    analyzer.close()


def test_supported_probe_state_survives_restart_and_is_bound_to_configuration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """主动探测成功后，重启 Runtime 应恢复已支持状态且配置变化会重新测试。"""
    analyzer = _analyzer(tmp_path)
    monkeypatch.setattr(vision_module.secrets, "randbelow", lambda _limit: 123456)

    async def success(*_args: object, **_kwargs: object) -> str:
        """模拟视觉模型正确返回随机验证码。"""
        return "123456"

    monkeypatch.setattr(analyzer, "_request", success)
    assert asyncio.run(analyzer.probe())["status"] == "supported"
    analyzer.close()

    restored = _analyzer(tmp_path)
    assert restored.status == "supported"
    restored.close()

    changed = VisionAnalyzer(
        VisionConfiguration("https://vision.invalid/v1", "secret", "another-model", "custom"),
        str(tmp_path / "vision.db"),
    )
    assert changed.status == "untested"
    changed.close()


def test_temporary_probe_failure_clears_previous_persisted_support(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """临时视觉服务故障不能让旧的已支持状态在重启后继续生效。"""
    analyzer = _analyzer(tmp_path)
    monkeypatch.setattr(vision_module.secrets, "randbelow", lambda _limit: 123456)

    async def success(*_args: object, **_kwargs: object) -> str:
        """模拟首次探测成功。"""
        return "123456"

    monkeypatch.setattr(analyzer, "_request", success)
    assert asyncio.run(analyzer.probe())["status"] == "supported"

    async def unavailable(*_args: object, **_kwargs: object) -> str:
        """模拟临时服务不可用。"""
        raise VisionRequestError("unavailable", "vision_provider_timeout")

    monkeypatch.setattr(analyzer, "_request", unavailable)
    assert asyncio.run(analyzer.probe())["status"] == "unavailable"
    analyzer.close()

    restored = _analyzer(tmp_path)
    assert restored.status == "untested"
    restored.close()


@pytest.mark.parametrize(
    ("response", "status", "code"),
    [
        (httpx.Response(401), "invalid-credentials", "vision_invalid_credentials"),
        (httpx.Response(403), "invalid-credentials", "vision_invalid_credentials"),
        (httpx.Response(404), "unavailable", "vision_provider_unavailable"),
        (httpx.Response(404, json={"error": {"code": "model_not_found"}}), "unsupported", "vision_model_unsupported"),
        (httpx.Response(400, json={"error": {"code": "model_not_found"}}), "unsupported", "vision_model_unsupported"),
        (httpx.Response(429), "unavailable", "vision_rate_limited"),
        (httpx.Response(503), "unavailable", "vision_provider_unavailable"),
        (httpx.ReadTimeout("timeout"), "unavailable", "vision_provider_timeout"),
    ],
)
def test_http_failures_are_classified_without_caching_unsupported(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    response: httpx.Response | Exception,
    status: str,
    code: str,
) -> None:
    """凭据、模型不存在、限流、超时和 5xx 必须使用不同错误码。"""
    analyzer = _analyzer(tmp_path)
    monkeypatch.setattr(vision_module.httpx, "AsyncClient", lambda **_kwargs: _FakeClient(response))
    with pytest.raises(VisionRequestError) as error:
        asyncio.run(analyzer._request(b"png", "probe", structured=False))
    assert error.value.status == status
    assert error.value.code == code
    analyzer.close()


def test_summary_schema_cache_and_no_base64_persistence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """摘要按图片/配置/提示缓存，数据库不得保存图片 Base64。"""
    analyzer = _analyzer(tmp_path)
    analyzer.status = "supported"
    source = tmp_path / "source.png"
    Image.new("RGB", (32, 32), "white").save(source)
    calls = 0

    async def summary(*_args: object, **_kwargs: object) -> str:
        """模拟固定结构视觉响应。"""
        nonlocal calls
        calls += 1
        return '{"title":"测试图","summary":"只读摘要","visibleText":[],"observations":["白色"],"limitations":["无精确坐标"]}'

    monkeypatch.setattr(analyzer, "_request", summary)
    first = asyncio.run(analyzer.analyze("task-1", source, tmp_path / "safe-1.png"))
    second = asyncio.run(analyzer.analyze("task-2", source, tmp_path / "safe-2.png"))
    assert first == second
    assert calls == 1
    assert not (tmp_path / "safe-1.png").exists()
    assert not (tmp_path / "safe-2.png").exists()
    row = analyzer._connection.execute("SELECT summary_json FROM vision_summary_cache").fetchone()
    assert row and "base64" not in str(row[0]).casefold()
    analyzer.close()


def test_analyze_cancel_does_not_write_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """取消视觉任务应清理派生图且不写入摘要缓存。"""
    analyzer = _analyzer(tmp_path)
    analyzer.status = "supported"
    source = tmp_path / "source.png"
    Image.new("RGB", (16, 16), "white").save(source)
    gate = asyncio.Event()

    async def blocked(*_args: object, **_kwargs: object) -> object:
        """阻塞到测试主动取消。"""
        await gate.wait()
        return None

    monkeypatch.setattr(analyzer, "_analyze_bytes", blocked)

    async def run() -> None:
        """创建并取消一个视觉任务。"""
        task = asyncio.create_task(analyzer.analyze("cancel-me", source, tmp_path / "derived.png"))
        await asyncio.sleep(0)
        assert analyzer.cancel("cancel-me") is True
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert analyzer._connection.execute("SELECT COUNT(*) FROM vision_summary_cache").fetchone()[0] == 0
    assert not (tmp_path / "derived.png").exists()
    analyzer.close()
