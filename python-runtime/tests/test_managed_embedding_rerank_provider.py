from __future__ import annotations

import base64
import json
import math
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from petdock_runtime.managed.session import ManagedSessionStore
from petdock_runtime.knowledge.service import KnowledgeService
from petdock_runtime.knowledge.store import KnowledgeStore
from petdock_runtime.providers.embeddings import LocalHashEmbedding
from petdock_runtime.providers.managed_embedding import ManagedEmbeddingProvider
from petdock_runtime.providers.managed_embedding import ManagedEmbeddingError
from petdock_runtime.providers.rerank import ManagedRerankProvider
from petdock_runtime.rag.vector_store import ChromaVectorStore


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
    """验证预占拒绝后不重复发送更大请求，会话更新后可重新探测。"""
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


def _batch_provider(handler) -> ManagedEmbeddingProvider:
    """创建使用合成传输和二维向量的分批测试适配器。"""
    provider = ManagedEmbeddingProvider(
        "https://ai.example.test", "0.2.0", "99999999-9999-4999-8999-999999999999",
        _session("33333333-3333-4333-8333-333333333333"), dimensions=2,
    )
    provider._client.close()
    provider._client = httpx.Client(transport=httpx.MockTransport(handler))
    return provider


def _embedding_response(vectors: list[list[float]]) -> httpx.Response:
    """生成符合官方 Descriptor 的合成响应。"""
    return httpx.Response(200, json={
        "descriptorId": "embedding-standard", "revision": "bge-base-zh-v1.5", "vectors": vectors,
    })


@pytest.mark.parametrize("lengths,expected_batches", [([448] * 130, 5), ([1] * 130, 5), ([50_000, 1], 2)])
def test_managed_embedding_batches_by_items_and_total_characters(lengths: list[int], expected_batches: int) -> None:
    """正常请求使用较小计算批次，单项保留协议兼容，并保持跨批次向量顺序。"""
    calls = []
    cursor = 0

    def handler(request: httpx.Request) -> httpx.Response:
        """以服务端门禁拒绝过大的批次，按原始顺序返回不同向量。"""
        nonlocal cursor
        texts = json.loads(request.content)["input"]
        calls.append(texts)
        if len(texts) > 128 or sum(len(text.strip()) for text in texts) > 50_000:
            return httpx.Response(413, json={"error": {"code": "request_too_large"}})
        vectors = [[float(index + 1), 1.0] for index in range(cursor, cursor + len(texts))]
        cursor += len(texts)
        return _embedding_response(vectors)

    provider = _batch_provider(handler)
    texts = ["测" * length for length in lengths]
    try:
        vectors = provider.embed_documents(texts)
    finally:
        provider.close()
    assert len(calls) == expected_batches
    assert [text for batch in calls for text in batch] == texts
    assert vectors == [
        pytest.approx([(index + 1) / math.hypot(index + 1, 1), 1 / math.hypot(index + 1, 1)])
        for index in range(len(texts))
    ]


def test_managed_embedding_bulk_quota_rejection_does_not_block_smaller_query() -> None:
    """余额不足以预占大批次时，小查询仍可使用官方向量。"""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        """模拟仍有少量余额，只拒绝较大的请求。"""
        texts = json.loads(request.content)["input"]
        calls.append(texts)
        if sum(len(text) for text in texts) > 100:
            return httpx.Response(429, json={"error": {"code": "quota_exhausted"}})
        return _embedding_response([[1.0, 0.0] for _ in texts])

    provider = _batch_provider(handler)
    try:
        for texts in (["测" * 120], ["测" * 120], ["测" * 121]):
            with pytest.raises(ManagedEmbeddingError, match="managed_quota_exhausted"):
                provider.embed_documents(texts)
        assert calls == [["测" * 120]]
        assert provider.embed_query("小查询") == [1.0, 0.0]
        assert len(calls) == 2
    finally:
        provider.close()


def test_managed_embedding_smaller_rejection_reduces_gate_until_reset(caplog) -> None:
    """余额真正不足时逐步收紧门禁，重置后恢复，并且日志不包含输入或令牌。"""
    calls = 0
    rejected = True

    def handler(request: httpx.Request) -> httpx.Response:
        """模拟预占一直被拒，直到会话对应的新额度生效。"""
        nonlocal calls
        calls += 1
        if rejected:
            return httpx.Response(429, json={"error": {"code": "quota_exhausted"}})
        return _embedding_response([[1.0, 0.0]])

    provider = _batch_provider(handler)
    try:
        for text in ("合成私密正文" * 20, "合成私密正文", "合成私密正文" * 2, "字", "字"):
            with pytest.raises(ManagedEmbeddingError, match="managed_quota_exhausted"):
                provider.embed_query(text)
        assert calls == 3
        assert "合成私密正文" not in caplog.text
        assert provider._session.lease().access_token not in caplog.text
        rejected = False
        provider.reset_degraded()
        assert provider.embed_query("合成私密正文") == [1.0, 0.0]
        assert calls == 4
    finally:
        provider.close()


def test_managed_embedding_index_fallback_keeps_existing_semantic_query_available(tmp_path) -> None:
    """真实 Chroma 建库大批次降级后，已建语义索引的小查询仍可访问官方服务。"""
    def handler(request: httpx.Request) -> httpx.Response:
        """仅允许小请求，模拟有余额但不足以预占整批的服务端。"""
        texts = json.loads(request.content)["input"]
        if sum(len(text) for text in texts) > 100:
            return httpx.Response(429, json={"error": {"code": "quota_exhausted"}})
        return _embedding_response([[1.0, 0.0] for _ in texts])

    provider = _batch_provider(handler)
    primary = ChromaVectorStore(str(tmp_path / "vectors"), provider)
    fallback = ChromaVectorStore(str(tmp_path / "vectors"), LocalHashEmbedding())
    store = KnowledgeStore(str(tmp_path / "knowledge.db"))
    service = KnowledgeService(store, primary, fallback)
    try:
        small = {"id": "small", "libraryId": "library", "documentId": "doc-small", "content": "合成资料"}
        bulk = {"id": "bulk", "libraryId": "library", "documentId": "doc-bulk", "content": "合成资料" * 40}
        assert service._upsert_vectors([small], "library") == provider.descriptor.signature
        assert service._upsert_vectors([bulk], "library") == fallback.descriptor.signature
        assert primary.count == 1
        assert fallback.count == 2
        assert primary.search("合成资料", ["library"]) == [("small", pytest.approx(1.0))]
        service.reset_embedding_degradation()
        assert not service._is_embedding_degraded("library")
    finally:
        provider.close()
        store.close()


@pytest.mark.parametrize("status,code", [(413, "request_too_large"), (401, "token_expired")])
def test_managed_embedding_other_rejection_does_not_trip_quota_gate(status: int, code: str) -> None:
    """请求过大和会话失效不能被缓存为额度不足。"""
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        """首次失败，下一次同规模请求成功。"""
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(status, json={"error": {"code": code}})
        return _embedding_response([[1.0, 0.0]])

    provider = _batch_provider(handler)
    try:
        with pytest.raises(ManagedEmbeddingError) as error:
            provider.embed_query("合成测试")
        assert error.value.code != "managed_quota_exhausted"
        assert provider.embed_query("合成测试") == [1.0, 0.0]
        assert calls == 2
    finally:
        provider.close()


def test_managed_embedding_batch_failure_does_not_replay_or_return_partial_vectors() -> None:
    """分批中途失败时不重放已结算请求，也不返回不完整向量。"""
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        """首批成功后模拟额度拒绝。"""
        nonlocal calls
        calls += 1
        if calls == 2:
            return httpx.Response(429, json={"error": {"code": "quota_exhausted"}})
        texts = json.loads(request.content)["input"]
        return _embedding_response([[1.0, 0.0] for _ in texts])

    provider = _batch_provider(handler)
    try:
        with pytest.raises(ManagedEmbeddingError, match="managed_quota_exhausted"):
            provider.embed_documents(["测" * 448] * 300)
        assert calls == 2
    finally:
        provider.close()


def test_managed_embedding_session_rotation_retries_only_rejected_batch_once() -> None:
    """第二批遇到旧会话 401 时仅使用新 Lease 重试该批，保留请求并更换尝试标识。"""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        """在第二次请求到达时模拟 Main 注入新会话并撤销旧会话。"""
        calls.append(request)
        if len(calls) == 2:
            provider._session.update("synthetic-new-runtime-token", datetime.now(UTC) + timedelta(minutes=5), 2)
            return httpx.Response(401, json={"error": {"code": "token_expired"}})
        texts = json.loads(request.content)["input"]
        return _embedding_response([[1.0, 0.0] for _ in texts])

    provider = _batch_provider(handler)
    try:
        assert len(provider.embed_documents(["合成资料"] * 33)) == 33
        assert len(calls) == 3
        assert json.loads(calls[0].content)["input"] == ["合成资料"] * 32
        assert json.loads(calls[1].content)["input"] == json.loads(calls[2].content)["input"] == ["合成资料"]
        assert calls[1].headers["X-PetDock-Request-Id"] == calls[2].headers["X-PetDock-Request-Id"]
        assert calls[1].headers["X-PetDock-Attempt-Id"] != calls[2].headers["X-PetDock-Attempt-Id"]
        assert calls[2].headers["Authorization"] == "Bearer synthetic-new-runtime-token"
    finally:
        provider.close()


@pytest.mark.parametrize("rotated", [False, True])
def test_managed_embedding_unauthorized_without_recovery_is_not_replayed(rotated: bool) -> None:
    """没有新 Lease 时不重试，新 Lease 仍被拒时也只重试一次，避免循环。"""
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        """持续拒绝请求，并可模拟每次都发生会话变更。"""
        nonlocal calls
        calls += 1
        if rotated:
            provider._session.update(f"synthetic-token-{calls}", datetime.now(UTC) + timedelta(minutes=5), calls)
        return httpx.Response(401, json={"error": {"code": "authentication_required"}})

    provider = _batch_provider(handler)
    try:
        with pytest.raises(ManagedEmbeddingError, match="managed_authentication_required"):
            provider.embed_documents(["合成资料"] * 130)
        assert calls == (2 if rotated else 1)
    finally:
        provider.close()


@pytest.mark.parametrize("texts", [["有效输入", "测" * 50_001], ["有效输入", "   "]])
def test_managed_embedding_invalid_item_is_rejected_before_any_request(texts: list[str]) -> None:
    """任何单项越界或为空时整批先拒绝，避免前面的批次已产生用量。"""
    def handler(request: httpx.Request) -> httpx.Response:
        """本地校验失败不应触发请求。"""
        raise AssertionError("无效批次不应请求官方接口")

    provider = _batch_provider(handler)
    try:
        with pytest.raises(ManagedEmbeddingError, match="embedding_provider_invalid_input"):
            provider.embed_documents(texts)
    finally:
        provider.close()


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
