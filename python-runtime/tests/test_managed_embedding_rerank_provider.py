from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from petdock_runtime.managed.session import ManagedSessionStore
from petdock_runtime.providers.managed_embedding import ManagedEmbeddingProvider
from petdock_runtime.providers.managed_embedding import ManagedEmbeddingError
from petdock_runtime.providers.rerank import ManagedRerankProvider


def _token(device_id: str) -> str:
    """构造只用于测试设备 Claim 读取的非签名 JWT。"""
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    claims = base64.urlsafe_b64encode(
        json.dumps({"device_id": device_id}).encode()
    ).rstrip(b"=").decode()
    return f"{header}.{claims}.signature"


def _session(device_id: str) -> ManagedSessionStore:
    """创建带有效 Runtime Lease 的测试会话。"""
    session = ManagedSessionStore()
    session.update(_token(device_id), datetime.now(UTC) + timedelta(minutes=5), 1)
    return session


def test_managed_embedding_uses_device_claim_from_runtime_token() -> None:
    expected_device = "11111111-1111-4111-8111-111111111111"
    observed: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        observed["device"] = request.headers["X-PetDock-Device-Id"]
        return httpx.Response(
            200,
            json={
                "descriptorId": "embedding-standard",
                "revision": "bge-base-zh-v1.5",
                "vectors": [[1.0] * 768],
            },
        )

    provider = ManagedEmbeddingProvider(
        "https://ai.example.test", "0.2.0", "99999999-9999-4999-8999-999999999999", _session(expected_device)
    )
    provider._client = httpx.Client(transport=httpx.MockTransport(handler))

    assert len(provider.embed_documents(["测试文本"])[0]) == 768
    assert observed["device"] == expected_device


def test_managed_embedding_quota_error_is_circuit_broken_until_reset() -> None:
    """验证额度耗尽后不重复请求官方接口，会话更新后可重新探测。"""
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, json={"error": {"code": "quota_exhausted"}})
        return httpx.Response(
            200,
            json={
                "descriptorId": "embedding-standard",
                "revision": "bge-base-zh-v1.5",
                "vectors": [[1.0] * 768],
            },
        )

    provider = ManagedEmbeddingProvider(
        "https://ai.example.test", "0.2.0", "99999999-9999-4999-8999-999999999999", _session("33333333-3333-4333-8333-333333333333")
    )
    provider._client = httpx.Client(transport=httpx.MockTransport(handler))

    with pytest.raises(ManagedEmbeddingError, match="managed_quota_exhausted"):
        provider.embed_documents(["第一次请求"])
    with pytest.raises(ManagedEmbeddingError, match="managed_quota_exhausted"):
        provider.embed_documents(["熔断期间不应发请求"])
    assert calls == 1

    provider.reset_degraded()
    assert len(provider.embed_documents(["额度恢复后重新探测"])[0]) == 768
    assert calls == 2


def test_managed_rerank_uses_device_claim_from_runtime_token() -> None:
    expected_device = "22222222-2222-4222-8222-222222222222"
    observed: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        observed["device"] = request.headers["X-PetDock-Device-Id"]
        return httpx.Response(200, json={"results": [{"id": "a", "score": 0.9}]})

    provider = ManagedRerankProvider(
        "https://ai.example.test", "0.2.0", "99999999-9999-4999-8999-999999999999", _session(expected_device)
    )
    provider._client = httpx.Client(transport=httpx.MockTransport(handler))

    assert provider.rerank("查询", [{"id": "a", "content": "候选"}]) == {"a": 0.9}
    assert observed["device"] == expected_device
