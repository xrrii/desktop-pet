from __future__ import annotations

import asyncio
from dataclasses import replace

import pytest

from petdock_runtime.knowledge.service import KnowledgeService
from petdock_runtime.knowledge.store import KnowledgeStore
from petdock_runtime.providers.embeddings import LocalHashEmbedding
from petdock_runtime.providers.managed_embedding import ManagedEmbeddingError
from petdock_runtime.rag.vector_store import ChromaVectorStore


class ControlledSemanticEmbedding(LocalHashEmbedding):
    """使用本地向量模拟官方建库成功、失败和恢复，不访问外部服务。"""

    def __init__(self) -> None:
        """建立独立语义签名，并记录实际建库请求次数。"""
        super().__init__()
        self.descriptor = replace(self.descriptor, id="test-semantic-index-health")
        self.failure: str | None = None
        self.calls = 0
        self.resets = 0

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """按测试开关拒绝当前批次。"""
        self.calls += 1
        if self.failure:
            raise ManagedEmbeddingError(self.failure)
        return super().embed_documents(texts)

    def reset_degraded(self) -> None:
        """记录用户补建操作确实重置了 Provider 门禁。"""
        self.resets += 1


async def _wait_index(service: KnowledgeService, library_id: str) -> None:
    """等待真实后台任务结束，避免只凭数据库完成标记产生竞态。"""
    task = service._tasks.get(library_id)
    if task is not None:
        await task


@pytest.mark.parametrize("code", [
    "managed_quota_exhausted", "managed_authentication_required", "embedding_provider_timeout",
])
def test_partial_fallback_persists_and_manual_retry_only_rebuilds_missing_documents(tmp_path, code) -> None:
    """部分降级跨重启可见，补建只处理缺失语义索引，并在全部恢复后清除告警。"""
    async def scenario() -> None:
        source = tmp_path / "notes"
        source.mkdir()
        (source / "a.md").write_text("已完成语义索引的合成文档。", encoding="utf-8")
        database = str(tmp_path / "knowledge.db")
        provider = ControlledSemanticEmbedding()
        primary = ChromaVectorStore(str(tmp_path / "vectors"), provider)
        fallback = ChromaVectorStore(str(tmp_path / "vectors"), LocalHashEmbedding())
        service = KnowledgeService(KnowledgeStore(database), primary, fallback)
        library = await service.create_library("测试资料", str(source))
        library_id = str(library["id"])
        await _wait_index(service, library_id)
        provider.failure = code
        (source / "b.md").write_text("本次只能完成本地检索的合成文档。", encoding="utf-8")
        await service.start_index(library_id)
        await _wait_index(service, library_id)
        summary = service.snapshot()["libraries"][0]
        assert summary["status"] == ("paused" if code == "managed_authentication_required" else "ready")
        assert summary["embeddingIndex"] == {
            "mode": "semantic", "totalDocuments": 2, "readyDocuments": 1,
            "fallbackDocuments": 1, "pendingDocuments": 0, "requiresRebuild": True, "lastFailureCode": code,
        }
        await service.close()

        restored = KnowledgeService(KnowledgeStore(database), primary, fallback)
        try:
            assert restored.snapshot()["libraries"][0]["embeddingIndex"] == summary["embeddingIndex"]
            if code == "managed_quota_exhausted":
                # 同一进程中之前的失败仍可阻止大批次；用户点补建必须主动解开此库门禁。
                restored._mark_embedding_degraded(library_id)
            provider.failure = None
            calls = provider.calls
            await restored.start_index(library_id, retry_embedding=True)
            await _wait_index(restored, library_id)
            health = restored.snapshot()["libraries"][0]["embeddingIndex"]
            assert health["readyDocuments"] == 2
            assert health["fallbackDocuments"] == health["pendingDocuments"] == 0
            assert health["requiresRebuild"] is False
            assert health["lastFailureCode"] is None
            assert provider.calls == calls + 1
            assert provider.resets == 1
            # 完整且未变化的索引再次刷新不产生向量请求。
            await restored.start_index(library_id, retry_embedding=True)
            await _wait_index(restored, library_id)
            assert provider.calls == calls + 1
        finally:
            await restored.close()

    asyncio.run(scenario())


def test_authentication_failure_pauses_before_next_document_and_preserves_retry(tmp_path) -> None:
    """认证被拒后只处理当前文件，补建恢复时不再要求重启，也不删除尚未扫描文档。"""
    async def scenario() -> None:
        """以真实后台索引与 Chroma 验证暂停、文档保留和补建复用。"""
        source = tmp_path / "notes"
        source.mkdir()
        for index in range(3):
            (source / f"{index}.md").write_text(f"合成资料 {index}。", encoding="utf-8")
        provider = ControlledSemanticEmbedding()
        service = KnowledgeService(
            KnowledgeStore(str(tmp_path / "knowledge.db")),
            ChromaVectorStore(str(tmp_path / "vectors"), provider),
            ChromaVectorStore(str(tmp_path / "vectors"), LocalHashEmbedding()),
        )
        try:
            library = await service.create_library("合成资料", str(source))
            library_id = str(library["id"])
            await _wait_index(service, library_id)
            assert provider.calls == 3
            # 三个文件都已登记；第一个变化后认证失败，后续两个文档不得被当作删除。
            (source / "0.md").write_text("已变化的合成资料，等待官方会话恢复。", encoding="utf-8")
            provider.failure = "managed_authentication_required"
            await service.start_index(library_id, retry_embedding=True)
            await _wait_index(service, library_id)
            summary = service.snapshot()["libraries"][0]
            assert summary["status"] == "paused"
            assert summary["processedFiles"] == 1
            assert summary["documentCount"] == 3
            assert summary["embeddingIndex"]["readyDocuments"] == 2
            assert summary["embeddingIndex"]["lastFailureCode"] == "managed_authentication_required"
            assert provider.calls == 4
            provider.failure = None
            await service.start_index(library_id, retry_embedding=True)
            await _wait_index(service, library_id)
            assert provider.calls == 5
            summary = service.snapshot()["libraries"][0]
            assert summary["status"] == "ready"
            assert summary["embeddingIndex"]["requiresRebuild"] is False
        finally:
            await service.close()

    asyncio.run(scenario())


def test_legacy_hash_index_is_reported_without_inventing_quota_failure(tmp_path) -> None:
    """旧版 Hash 记录可以识别为待补建，但不能猜测历史失败原因。"""
    async def scenario() -> None:
        source = tmp_path / "notes"
        source.mkdir()
        (source / "a.md").write_text("旧版合成本地索引。", encoding="utf-8")
        database = str(tmp_path / "knowledge.db")
        fallback = ChromaVectorStore(str(tmp_path / "vectors"), LocalHashEmbedding())
        local = KnowledgeService(KnowledgeStore(database), fallback)
        library = await local.create_library("本地资料", str(source))
        await _wait_index(local, str(library["id"]))
        health = local.snapshot()["libraries"][0]["embeddingIndex"]
        assert health["mode"] == "hash"
        assert health["requiresRebuild"] is False
        await local.close()

        semantic = KnowledgeService(
            KnowledgeStore(database), ChromaVectorStore(str(tmp_path / "vectors"), ControlledSemanticEmbedding()), fallback,
        )
        try:
            summary = semantic.snapshot()["libraries"][0]
            assert summary["embeddingIndex"]["fallbackDocuments"] == 1
            assert summary["embeddingIndex"]["requiresRebuild"] is True
            assert summary["embeddingIndex"]["lastFailureCode"] is None
            assert "embedding_signature" not in str(summary)
            assert str(source) not in str(summary)
        finally:
            await semantic.close()

    asyncio.run(scenario())
