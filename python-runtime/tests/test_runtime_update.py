from __future__ import annotations

import asyncio
from types import SimpleNamespace

from httpx import ASGITransport, AsyncClient

from petdock_runtime.agent.mock_backend import MockBackend
from petdock_runtime.agent.service import AssistantService
from petdock_runtime.api import server
from petdock_runtime.config import RuntimeConfig
from petdock_runtime.knowledge.service import KnowledgeService
from petdock_runtime.memory.extractor import MemoryExtractor
from petdock_runtime.protocol import AssistantRequest

TOKEN = "synthetic-update-token"


def make_request() -> AssistantRequest:
    """构造不触发真实模型或正文日志的离线任务。"""
    return AssistantRequest(
        protocolVersion=1, taskId="synthetic-task", conversationId="synthetic-conversation",
        input="合成测试", source="assistant-window",
        context={"activePetId": "synthetic", "locale": "zh-CN", "timezone": "Asia/Shanghai"},
    )


def test_runtime_update_barrier_authorization_busy_and_resume(monkeypatch) -> None:
    """安装互锁保护在途请求和后台计数，拒绝新请求后可恢复。"""
    async def scenario() -> None:
        counts = {"chat": 0, "knowledge": 0, "memory": 0}
        resources = SimpleNamespace(**{name: None for name in (
            "memory", "attachments", "vision", "artifacts", "knowledge_store", "embedding",
            "attachment_index", "knowledge", "skills", "skill_installer", "assistant",
            "managed_session", "managed_auth_refresh",
        )})
        resources.assistant = SimpleNamespace(
            active_task_count=lambda: counts["chat"], memory_task_count=lambda: counts["memory"],
        )
        resources.knowledge = SimpleNamespace(active_task_count=lambda: counts["knowledge"])
        monkeypatch.setattr(server, "create_runtime_resources", lambda _: resources)
        app = server.create_app(RuntimeConfig(TOKEN, "mock", None, None, "unused"))
        started, release = asyncio.Event(), asyncio.Event()

        @app.get("/v1/synthetic-slow")
        async def slow() -> dict[str, bool]:
            """保持一个真实 ASGI 在途请求，覆盖检查与任务进入之间的竞态。"""
            started.set()
            await release.wait()
            return {"done": True}

        @app.get("/v1/synthetic-new")
        async def new_request() -> dict[str, bool]:
            """用于验证冻结之后的新操作不会进入业务路由。"""
            return {"done": True}

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://runtime.test") as client:
            headers = {"Authorization": f"Bearer {TOKEN}"}
            assert (await client.post("/v1/update/prepare")).status_code == 401
            assert (await client.post("/v1/update/resume")).status_code == 401
            for key, field in (("chat", "chatTasks"), ("knowledge", "knowledgeTasks"), ("memory", "memoryTasks")):
                counts[key] = 1
                response = await client.post("/v1/update/prepare", headers=headers)
                assert response.json()["accepted"] is False
                assert response.json()[field] == 1
                counts[key] = 0
            pending = asyncio.create_task(client.get("/v1/synthetic-slow"))
            await started.wait()
            response = await client.post("/v1/update/prepare", headers=headers)
            assert response.json()["accepted"] is False
            assert response.json()["activeRequests"] == 1
            release.set()
            await pending
            response = await client.post("/v1/update/prepare", headers=headers)
            assert response.json() == {
                "accepted": True, "activeRequests": 0, "chatTasks": 0, "knowledgeTasks": 0, "memoryTasks": 0,
            }
            assert (await client.get("/v1/synthetic-new")).status_code == 409
            assert (await client.post("/v1/update/resume", headers=headers)).status_code == 200
            assert (await client.get("/v1/synthetic-new")).status_code == 200

    asyncio.run(scenario())


def test_disconnected_chat_still_counts_as_busy() -> None:
    """SSE 会话被移除后真实助手协程仍计入忙碌，直到完成或取消闭合。"""
    async def scenario() -> None:
        service = AssistantService(MockBackend())
        service.start(make_request())
        stream = service.events("synthetic-task")
        await anext(stream)
        await stream.aclose()
        assert service.active_task_count() == 1
        await service.close()
        assert service.active_task_count() == 0

    asyncio.run(scenario())


def test_memory_background_work_prevents_install_and_closes() -> None:
    """聊天已结束后的记忆分析仍阻止安装，并在数据库关闭前收束。"""
    async def scenario() -> None:
        release = asyncio.Event()

        class SyntheticModel:
            async def ainvoke(self, _prompt: str):
                """模拟仍在进行的模型请求，不访问网络。"""
                await release.wait()
                return SimpleNamespace(content="[]")

        extractor = MemoryExtractor(SimpleNamespace(), SyntheticModel())
        service = AssistantService(MockBackend(), extractor)
        service.start(make_request())
        events = [event async for event in service.events("synthetic-task")]
        assert events[-1]["type"] == "done"
        assert service.active_task_count() == 0
        assert service.memory_task_count() == 1
        await service.close()
        assert service.memory_task_count() == 0

    asyncio.run(scenario())


def test_knowledge_counts_real_background_jobs() -> None:
    """索引启动请求返回后，未完成的真实后台协程仍计入忙碌。"""
    async def scenario() -> None:
        knowledge = KnowledgeService(SimpleNamespace(), SimpleNamespace())
        release = asyncio.Event()
        task = asyncio.create_task(release.wait())
        knowledge._tasks["synthetic-library"] = task
        assert knowledge.active_task_count() == 1
        release.set()
        await task
        assert knowledge.active_task_count() == 0

    asyncio.run(scenario())
