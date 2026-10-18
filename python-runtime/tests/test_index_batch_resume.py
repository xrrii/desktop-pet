"""用合成传输复现大文件超时，并验证已完成批次在补建、重启后复用。"""

from __future__ import annotations

import asyncio
import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from threading import Barrier, Lock

import httpx
import pytest

from petdock_runtime.managed.session import ManagedSessionStore
from petdock_runtime.knowledge.service import KnowledgeService
from petdock_runtime.knowledge.store import KnowledgeStore
from petdock_runtime.providers.embeddings import LocalHashEmbedding
from petdock_runtime.providers.managed_embedding import ManagedEmbeddingError, ManagedEmbeddingProvider
from petdock_runtime.rag.vector_store import ChromaVectorStore


def _provider(handler) -> ManagedEmbeddingProvider:
    """装配只访问合成传输的二维官方向量 Provider。"""
    session = ManagedSessionStore()
    session.update("synthetic-index-token", datetime.now(UTC) + timedelta(minutes=5), 1)
    provider = ManagedEmbeddingProvider("https://embedding.test", "0.2.6", "synthetic-device", session, dimensions=2)
    provider._client.close()
    provider._client = httpx.Client(transport=httpx.MockTransport(handler))
    return provider


def _response(texts: list[str]) -> httpx.Response:
    """生成维度、签名正确的合成完整响应。"""
    return httpx.Response(200, json={
        "descriptorId": "embedding-standard", "revision": "bge-base-zh-v1.5",
        "vectors": [[1.0, 0.0] for _ in texts],
    })


def test_dense_document_uses_small_requests_with_same_input_and_order() -> None:
    """模拟长文本计算预算，原来接近五万字符的单批超时，拆小后完成且不丢片段。"""
    observed: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """超过合成计算预算即返回与现场相同的 504，不依赖真实推理耗时。"""
        texts = json.loads(request.content)["input"]
        observed.append(texts)
        if len(texts) > 32 or sum(len(text) for text in texts) > 12_000:
            return httpx.Response(504, json={"error": {"code": "provider_timeout"}})
        return _response(texts)

    provider = _provider(handler)
    texts = [f"合成片段{index}:" + "测" * 407 for index in range(120)]
    try:
        assert len(provider.embed_documents(texts)) == len(texts)
        assert [text for batch in observed for text in batch] == texts
        assert len(observed) > 1
    finally:
        provider.close()


def test_partial_document_resumes_after_restart_without_reembedding_completed_batches(tmp_path) -> None:
    """第二批超时后首批必须已持久化，重开索引只请求未完成片段且不能误标完整。"""
    successful: list[str] = []
    calls = 0
    fail = True

    def handler(request: httpx.Request) -> httpx.Response:
        """首批成功、次批超时；手动恢复阶段禁止再次请求已完成片段。"""
        nonlocal calls
        calls += 1
        texts = json.loads(request.content)["input"]
        if fail and calls == 2:
            return httpx.Response(504, json={"error": {"code": "provider_timeout"}})
        assert not set(texts).intersection(successful), "补建重放了已完成的合成片段"
        successful.extend(texts)
        return _response(texts)

    records = [
        {"id": f"chunk-{index}", "libraryId": "library", "documentId": "document", "content": f"合成资料{index}"}
        for index in range(100)
    ]
    provider = _provider(handler)
    try:
        store = ChromaVectorStore(str(tmp_path / "vectors"), provider)
        with pytest.raises(ManagedEmbeddingError, match="embedding_provider_timeout"):
            store.upsert(records, reuse_existing=True)
        assert 0 < store.count < len(records)
        assert store.count == len(successful)
        fail = False
        reopened = ChromaVectorStore(str(tmp_path / "vectors"), provider)
        reopened.upsert(records, reuse_existing=True)
        assert reopened.count == len(successful) == len(records)
        calls_before = calls
        reopened.upsert(records, reuse_existing=True)
        assert calls == calls_before
    finally:
        provider.close()


def test_resume_checks_content_and_model_space_and_keeps_normal_upsert_semantics(tmp_path) -> None:
    """不能仅凭相同 ID 复用变化正文，也不能跨向量签名复用；普通 upsert 仍主动重算。"""
    observed: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """记录所有合成文本，验证只复用内容和空间都一致的向量。"""
        texts = json.loads(request.content)["input"]
        observed.append(texts)
        return _response(texts)

    provider = _provider(handler)
    records = [{"id": "chunk", "libraryId": "library", "documentId": "doc", "content": "第一版合成资料"}]
    try:
        store = ChromaVectorStore(str(tmp_path / "vectors"), provider)
        # 旧版本只有归属元数据，没有可验证正文摘要，首次补建必须保守重算。
        store._collection.upsert(
            ids=["chunk"], embeddings=[[1.0, 0.0]], metadatas=[{"libraryId": "library", "documentId": "doc"}],
        )
        store.upsert(records, reuse_existing=True)
        records[0]["content"] = "第二版合成资料"
        store.upsert(records, reuse_existing=True)
        store.upsert(records)
        assert observed == [["第一版合成资料"], ["第二版合成资料"], ["第二版合成资料"]]
        other = ChromaVectorStore(str(tmp_path / "vectors"), provider, collection_name="isolated-profile")
        other.upsert(records, reuse_existing=True)
        assert len(observed) == 4
    finally:
        provider.close()


def test_same_desktop_sends_only_one_embedding_request_at_a_time(caplog) -> None:
    """多个建库线程共享单批发送门禁，并将等待与传输耗时写入脱敏日志。"""
    active = peak = 0
    state_lock = Lock()
    ready = Barrier(3)

    def handler(request: httpx.Request) -> httpx.Response:
        """合成传输释放 GIL，确保无门禁时三个线程会实际重叠。"""
        nonlocal active, peak
        with state_lock:
            active += 1
            peak = max(peak, active)
        try:
            time.sleep(0.01)
            return _response(json.loads(request.content)["input"])
        finally:
            with state_lock:
                active -= 1

    def query() -> list[float]:
        """同步起跑模拟同一桌面多个索引任务，不访问生产服务。"""
        ready.wait(timeout=3)
        return provider.embed_query("不应出现在日志中的合成正文")

    provider = _provider(handler)
    caplog.set_level("INFO", logger="petdock.providers.managed_embedding")
    try:
        with ThreadPoolExecutor(max_workers=3) as pool:
            jobs = [pool.submit(query) for _ in range(3)]
            assert [job.result(timeout=5) for job in jobs] == [[1.0, 0.0]] * 3
        assert peak == 1
        assert "localWaitMs=" in caplog.text and "durationMs=" in caplog.text
        assert "不应出现在日志中的合成正文" not in caplog.text
        assert "synthetic-index-token" not in caplog.text
    finally:
        provider.close()


def test_knowledge_health_stays_incomplete_until_all_missing_chunks_resume(tmp_path) -> None:
    """真实后台任务、SQLite 与 Chroma 验证部分结果保留、补建复用以及文件变化失效。"""
    class PartialEmbedding(LocalHashEmbedding):
        """用小批量本地推理模拟长文档第二批超时。"""

        document_batch_size = 2

        def __init__(self) -> None:
            """记录实际成功推理的合成片段与当前故障开关。"""
            super().__init__()
            self.descriptor = replace(self.descriptor, id="synthetic-partial-resume")
            self.calls = 0
            self.fail = True
            self.completed: list[str] = []

        def embed_documents(self, texts: list[str]) -> list[list[float]]:
            """已落库片段不得在补建中再次执行，失败批次不返回结果。"""
            self.calls += 1
            if self.fail and self.calls == 2:
                raise ManagedEmbeddingError("embedding_provider_timeout")
            self.completed.extend(texts)
            return super().embed_documents(texts)

    async def scenario() -> None:
        """任务间重开存储模拟应用重启，不通过私有状态伪造建库就绪。"""
        source = tmp_path / "notes"
        source.mkdir()
        document = source / "large.md"
        document.write_text("\n\n".join(
            f"## 合成段落 {index}\n" + "".join(f"合成知识{index}-{part}。" for part in range(90))
            for index in range(12)
        ), encoding="utf-8")
        provider = PartialEmbedding()

        def service() -> KnowledgeService:
            """每次装配重新打开同一持久化数据库和模型空间。"""
            return KnowledgeService(
                KnowledgeStore(str(tmp_path / "knowledge.db")),
                ChromaVectorStore(str(tmp_path / "vectors"), provider),
                ChromaVectorStore(str(tmp_path / "vectors"), LocalHashEmbedding()),
            )

        first = service()
        library = await first.create_library("合成大文档", str(source))
        library_id = str(library["id"])
        await first._tasks[library_id]
        health = first.snapshot()["libraries"][0]["embeddingIndex"]
        assert health["readyDocuments"] == 0 and health["requiresRebuild"] is True
        assert health["lastFailureCode"] == "embedding_provider_timeout"
        saved = list(provider.completed)
        assert len(saved) == 2 and first.vectors.count == 2
        await first.close()

        provider.fail = False
        resumed = service()
        try:
            await resumed.start_index(library_id, retry_embedding=True)
            await resumed._tasks[library_id]
            assert provider.completed[:2] == saved
            assert not set(saved).intersection(provider.completed[2:])
            summary = resumed.snapshot()["libraries"][0]
            assert resumed.vectors.count == summary["chunkCount"] == len(provider.completed)
            assert summary["embeddingIndex"]["requiresRebuild"] is False
            assert summary["embeddingIndex"]["lastFailureCode"] is None
            calls = provider.calls
            # 来源变化必须替换分块并重新推理，不能沿用原文档的断点。
            document.write_text("变化后的合成资料。", encoding="utf-8")
            await resumed.start_index(library_id, retry_embedding=True)
            await resumed._tasks[library_id]
            assert provider.calls == calls + 1
            assert resumed.vectors.count == 1
        finally:
            await resumed.close()

    asyncio.run(scenario())
