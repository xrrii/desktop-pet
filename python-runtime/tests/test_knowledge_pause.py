"""知识库暂停必须快速确认，并在当前完整推理批次落库后停止。"""

from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from threading import Event
from types import SimpleNamespace

import httpx
import pytest

from petdock_runtime.api import server
from petdock_runtime.config import RuntimeConfig
from petdock_runtime.managed.session import ManagedSessionStore
from petdock_runtime.knowledge.service import KnowledgeService
from petdock_runtime.knowledge.store import KnowledgeStore
from petdock_runtime.providers.embeddings import EmbeddingIndexPaused, LocalHashEmbedding
from petdock_runtime.providers.managed_embedding import ManagedEmbeddingProvider
from petdock_runtime.rag.vector_store import ChromaVectorStore


def test_pause_acknowledges_inflight_batch_and_resume_reuses_saved_chunks(tmp_path, monkeypatch) -> None:
    """阻塞首个模型批次模拟慢推理，暂停接口不得等待整份文档或误报后台已空闲。"""
    entered, release = Event(), Event()

    class SlowEmbedding(LocalHashEmbedding):
        """使用真实 Hash 向量模拟可控的语义批次。"""

        document_batch_size = 2

        def __init__(self) -> None:
            """给合成语义空间独立签名，记录实际完成的片段。"""
            super().__init__()
            self.descriptor = replace(self.descriptor, id="synthetic-pause-semantic")
            self.calls = 0
            self.completed: list[str] = []

        def embed_documents(self, texts: list[str]) -> list[list[float]]:
            """只阻塞首个批次，释放后必须保存它而不发起第二批。"""
            self.calls += 1
            if self.calls == 1:
                entered.set()
                assert release.wait(timeout=5), "测试未释放合成推理批次"
            self.completed.extend(texts)
            return super().embed_documents(texts)

    async def scenario() -> None:
        """驱动真实后台线程、SQLite、Chroma 与暂停/恢复状态机。"""
        source = tmp_path / "notes"
        source.mkdir()
        (source / "large.md").write_text("\n\n".join(
            f"## 合成段落 {index}\n" + "".join(f"合成知识{index}-{part}。" for part in range(90))
            for index in range(8)
        ), encoding="utf-8")
        provider = SlowEmbedding()
        service = KnowledgeService(
            KnowledgeStore(str(tmp_path / "knowledge.db")),
            ChromaVectorStore(str(tmp_path / "vectors"), provider),
            ChromaVectorStore(str(tmp_path / "vectors"), LocalHashEmbedding()),
        )
        resources = SimpleNamespace(**{name: None for name in (
            'memory', 'attachments', 'vision', 'artifacts', 'knowledge_store', 'embedding',
            'attachment_index', 'knowledge', 'skills', 'skill_installer', 'assistant',
            'managed_session', 'managed_auth_refresh',
        )})
        resources.knowledge = service
        resources.assistant = SimpleNamespace(active_task_count=lambda: 0, memory_task_count=lambda: 0)
        monkeypatch.setattr(server, 'create_runtime_resources', lambda _: resources)
        token = 'synthetic-pause-api-token'
        app = server.create_app(RuntimeConfig(token, 'mock', None, None, 'unused'))
        try:
            library = await service.create_library("合成慢索引", str(source))
            library_id = str(library["id"])
            task = service._tasks[library_id]
            assert await asyncio.to_thread(entered.wait, 3)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://runtime.test') as client:
                route = f'/v1/knowledge/library/{library_id}/pause'
                assert (await client.post(route)).status_code == 401
                headers = {'Authorization': f'Bearer {token}'}
                response = await asyncio.wait_for(client.post(route, headers=headers), timeout=0.2)
                assert response.status_code == 200 and response.json() == {'accepted': True}
                barrier = (await client.post('/v1/update/prepare', headers=headers)).json()
                assert barrier['accepted'] is False and barrier['knowledgeTasks'] == 1
            pending = service.snapshot()["libraries"][0]
            assert pending["status"] == "indexing" and pending["pauseRequested"] is True
            assert service.active_task_count() == 1
            assert not await service.start_index(library_id), "暂停尚未结束时不得再启动同库任务"
            release.set()
            await task
            paused = service.snapshot()["libraries"][0]
            assert paused["status"] == "paused" and paused.get("pauseRequested", False) is False
            assert paused["error"] is None
            assert paused["documentCount"] == 1 and paused["chunkCount"] > 2
            assert paused["embeddingIndex"]["requiresRebuild"] is True
            assert paused["embeddingIndex"]["lastFailureCode"] is None
            assert service.active_task_count() == 0
            assert service.vectors.count == len(provider.completed) == 2
            assert service.fallback_vectors.count == 0, "用户暂停不得继续整份文档的 Hash 建库"
            saved = list(provider.completed)
            await service.start_index(library_id, retry_embedding=True)
            await service._tasks[library_id]
            completed = service.snapshot()["libraries"][0]
            assert completed["status"] == "ready" and not completed["embeddingIndex"]["requiresRebuild"]
            assert not set(saved).intersection(provider.completed[2:])
            assert len(provider.completed) == service.vectors.count == completed["chunkCount"]
        finally:
            release.set()
            await service.close()

    asyncio.run(scenario())


def test_pause_while_waiting_for_local_gate_sends_no_new_request() -> None:
    """另一个库占用发送门禁时，暂停必须退出本机等待，不再向远端排队。"""
    entered, release, waiting, stopped = Event(), Event(), Event(), Event()
    observed: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """保持首个已发请求在途，用独立线程验证等待批次可先行停止。"""
        texts = json.loads(request.content)['input']
        observed.append(texts)
        entered.set()
        assert release.wait(timeout=5), '测试未释放合成请求'
        return httpx.Response(200, json={
            'descriptorId': 'embedding-standard', 'revision': 'bge-base-zh-v1.5',
            'vectors': [[1.0, 0.0] for _ in texts],
        })

    def should_stop() -> bool:
        """通知主测试线程第二个批次已经进入可取消路径。"""
        waiting.set()
        return stopped.is_set()

    session = ManagedSessionStore()
    session.update('synthetic-pause-token', datetime.now(UTC) + timedelta(minutes=5), 1)
    provider = ManagedEmbeddingProvider('https://embedding.test', '0.2.6', 'synthetic-device', session, dimensions=2)
    provider._client.close()
    provider._client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(provider.embed_documents, ['已发出的合成片段'])
            try:
                assert entered.wait(timeout=3)
                second = pool.submit(provider.embed_documents_cancellable, ['不应发送的合成片段'], should_stop)
                assert waiting.wait(timeout=3)
                stopped.set()
                with pytest.raises(EmbeddingIndexPaused):
                    second.result(timeout=1)
                assert not first.done() and len(observed) == 1
            finally:
                release.set()
            assert first.result(timeout=3) == [[1.0, 0.0]]
    finally:
        release.set()
        provider.close()
