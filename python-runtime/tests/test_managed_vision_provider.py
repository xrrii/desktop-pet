"""Managed Vision Descriptor、上传、认证刷新和不重放边界测试。"""

from __future__ import annotations

import asyncio
import base64
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

import httpx
import pytest

from petdock_runtime.managed.auth_refresh import ManagedAuthRefreshCoordinator, ManagedAuthResultValue
from petdock_runtime.managed.session import ManagedSessionStore
from petdock_runtime.vision.managed_provider import ManagedVisionError, ManagedVisionProvider

DEVICE_ID = "33333333-3333-4333-8333-333333333333"


def _token(label: str) -> str:
    """构造只用于测试设备 Claim 读取的非签名 JWT 形状。"""
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps({"device_id": DEVICE_ID, "label": label}).encode()).decode().rstrip("=")
    return f"{header}.{payload}.synthetic"


def _session(label: str = "initial") -> ManagedSessionStore:
    """创建仍有效的内存短期会话。"""
    session = ManagedSessionStore()
    session.update(_token(label), datetime.now(UTC) + timedelta(minutes=10), 1)
    return session


def _capabilities() -> httpx.Response:
    """返回可用 Vision Descriptor。"""
    return httpx.Response(200, json={
        "version": 1,
        "capabilities": {
            "vision": {
                "available": True,
                "reason": None,
                "logicalModel": "vision-standard",
                "descriptor": {
                    "id": "vision-standard",
                    "revision": "vision-r1",
                    "promptVersion": "vision-summary-v1",
                    "outputSchemaVersion": "vision-structured-v1",
                },
            },
        },
    })


def test_managed_vision_fetches_descriptor_then_uploads_one_derived_image() -> None:
    """Adapter 先获取 Revision，再以固定 Multipart 字段上传单张 PNG。"""
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        assert request.headers["x-petdock-device-id"] == DEVICE_ID
        if request.method == "GET":
            return _capabilities()
        assert b'name="descriptorRevision"' in request.content
        assert b"vision-r1" in request.content
        assert b'synthetic-derived-image' in request.content
        return httpx.Response(200, json={
            "descriptorRevision": "vision-r1",
            "summary": {
                "title": "测试图",
                "summary": "只读摘要",
                "visibleText": [],
                "observations": ["合成观察"],
                "limitations": [],
            },
            "usage": {"inputUnits": 12, "outputUnits": 8},
        })

    async def scenario() -> None:
        provider = ManagedVisionProvider(
            "https://ai.invalid", "0.2.0", DEVICE_ID, _session(),
            ManagedAuthRefreshCoordinator(), httpx.MockTransport(handler),
        )
        try:
            revision = await provider.prepare("task-1", lambda _: asyncio.sleep(0))
            result = await provider.analyze(
                "task-1", b"synthetic-derived-image", lambda _: asyncio.sleep(0), revision,
            )
            assert result.descriptor_revision == "vision-r1"
            assert result.summary["title"] == "测试图"
        finally:
            await provider.close()

    asyncio.run(scenario())
    assert paths == ["/ai/v1/capabilities", "/ai/v1/vision/analyze"]


def test_managed_vision_refreshes_only_before_upload_and_never_replays_post() -> None:
    """Capabilities 的过期 Token 可刷新一次，POST 过期后不得自动再次上传图片。"""
    session = _session()
    coordinator = ManagedAuthRefreshCoordinator()
    gets = 0
    posts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal gets, posts
        if request.method == "GET":
            gets += 1
            if gets == 1:
                return httpx.Response(401, json={"error": {"code": "token_expired"}})
            return _capabilities()
        posts += 1
        return httpx.Response(401, json={"error": {"code": "token_expired"}})

    async def scenario() -> None:
        provider = ManagedVisionProvider(
            "https://ai.invalid", "0.2.0", DEVICE_ID, session,
            coordinator, httpx.MockTransport(handler),
        )

        async def refresh(event: object) -> None:
            """模拟 Main 原子换入新 Token 后回传刷新结果。"""
            task_id = str(getattr(event, "task_id"))
            request_id = str(getattr(event, "request_id"))
            session.update(_token("refreshed"), datetime.now(UTC) + timedelta(minutes=10), 2)
            assert await coordinator.submit(
                task_id, request_id, ManagedAuthResultValue("refreshed", None),
            )

        try:
            revision = await provider.prepare("task-2", refresh)
            with pytest.raises(ManagedVisionError) as error:
                await provider.analyze("task-2", b"derived", refresh, revision)
            assert error.value.code == "managed_authentication_required"
        finally:
            await provider.close()
            await coordinator.close()

    asyncio.run(scenario())
    assert gets == 2
    assert posts == 1


def test_managed_vision_rejects_response_revision_mismatch() -> None:
    """Cloud 回显 Revision 不一致时拒绝摘要，避免跨版本缓存污染。"""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return _capabilities()
        return httpx.Response(200, json={
            "descriptorRevision": "vision-r2",
            "summary": {"title": "x"},
            "usage": {"inputUnits": 1, "outputUnits": 1},
        })

    async def scenario() -> None:
        provider = ManagedVisionProvider(
            "https://ai.invalid", "0.2.0", DEVICE_ID, _session(),
            ManagedAuthRefreshCoordinator(), httpx.MockTransport(handler),
        )
        try:
            revision = await provider.prepare("task-3", lambda _: asyncio.sleep(0))
            with pytest.raises(ManagedVisionError) as error:
                await provider.analyze("task-3", b"derived", lambda _: asyncio.sleep(0), revision)
            assert error.value.code == "vision_summary_failed"
        finally:
            await provider.close()

    asyncio.run(scenario())


def test_managed_vision_configuration_never_inherits_byok_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Managed Vision effectiveSource 必须清空视觉和主模型继承凭据。"""
    from petdock_runtime.config import RuntimeConfig

    monkeypatch.setenv("PETDOCK_RUNTIME_TOKEN", "t" * 64)
    monkeypatch.setenv("PETDOCK_LLM_API_KEY", "must-not-reach-vision")
    monkeypatch.setenv("PETDOCK_VISION_API_KEY", "must-not-reach-managed-adapter")
    monkeypatch.setenv("PETDOCK_RUNTIME_CAPABILITIES_JSON", json.dumps({
        "version": 1,
        "capabilities": {
            "chat": {"effectiveSource": "mock"},
            "embedding": {"effectiveSource": "local"},
            "vision": {"effectiveSource": "managed"},
            "rerank": {"effectiveSource": "disabled"},
            "web_search": {"effectiveSource": "disabled"},
        },
    }))
    config = RuntimeConfig.from_environment()
    assert config.vision_source == "managed"
    assert config.vision_api_key is None
    assert config.vision_base_url is None
    assert config.vision_model is None
    UUID(config.managed_device_id)
