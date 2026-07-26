from __future__ import annotations

import asyncio

from httpx import ASGITransport, AsyncClient

from petdock_runtime.backends import MockBackend
from petdock_runtime.config import RuntimeConfig
from petdock_runtime.embeddings import LocalHashEmbedding
from petdock_runtime.knowledge import ChromaVectorStore, KnowledgeService
from petdock_runtime.knowledge_store import KnowledgeStore
from petdock_runtime.memory_store import MemoryStore
from petdock_runtime.memory_extractor import _fallback_candidate
from petdock_runtime.protocol import AssistantRequest
from petdock_runtime.server import create_app
from petdock_runtime.service import AssistantService

TOKEN = "t" * 64


def make_request(task_id: str = "task-1") -> AssistantRequest:
    return AssistantRequest(
        protocolVersion=1,
        taskId=task_id,
        conversationId="conversation-1",
        input="你好",
        source="assistant-window",
        context={"activePetId": "hammer-dude", "locale": "zh-CN", "timezone": "Asia/Shanghai"},
    )


def test_health_and_authorization() -> None:
    async def scenario() -> tuple[int, int]:
        config = RuntimeConfig(TOKEN, "mock", None, None, "unused")
        transport = ASGITransport(app=create_app(config))
        async with AsyncClient(transport=transport, base_url="http://runtime.test") as client:
            health = await client.get("/health")
            unauthorized = await client.post("/v1/chat", json=make_request().model_dump())
            return health.json()["protocolVersion"], unauthorized.status_code

    protocol_version, unauthorized_status = asyncio.run(scenario())
    assert protocol_version == 1
    assert unauthorized_status == 401


def test_mock_backend_streams_and_completes() -> None:
    async def scenario() -> list[dict[str, object]]:
        service = AssistantService(MockBackend())
        request = make_request()
        service.start(request)
        return [event async for event in service.events(request.taskId)]

    events = asyncio.run(scenario())
    assert any(event["type"] == "message_delta" for event in events)
    assert events[-1]["payload"] == {"finishReason": "stop"}


def test_running_task_can_be_cancelled() -> None:
    async def scenario() -> list[dict[str, object]]:
        service = AssistantService(MockBackend())
        request = make_request("task-cancel")
        service.start(request)
        await asyncio.sleep(0.03)
        assert service.cancel(request.taskId)
        return [event async for event in service.events(request.taskId)]

    events = asyncio.run(scenario())
    assert events[-1]["payload"] == {"finishReason": "cancelled"}


def test_memory_store_persists_history_and_indexes(tmp_path) -> None:
    path = tmp_path / "assistant.db"
    store = MemoryStore(str(path))
    store.append_message("conversation-1", "user", "你好")
    store.append_message("conversation-1", "assistant", "你好，有什么可以帮你？")
    store.remember_preference("以后使用简洁回答")
    store.record_tool_log(
        {
            "taskId": "task-1",
            "toolCallId": "call-1",
            "toolName": "open_file_or_folder",
            "args": {"path": r"C:\Users\Alice\Documents\Project"},
            "risk": "confirm",
            "policyDecision": "confirm",
            "userDecision": "approved",
            "ok": True,
        }
    )
    snapshot = store.snapshot()
    assert snapshot["conversations"][0]["messageCount"] == 2
    assert snapshot["memories"][0]["value"] == "以后使用简洁回答"
    assert snapshot["directories"][0]["displayPath"].startswith("...")
    assert "Alice" not in str(snapshot["directories"])
    directory_id = snapshot["directories"][0]["id"]
    assert store.delete_item("directory", directory_id)
    store.close()

    reopened = MemoryStore(str(path))
    assert len(reopened.load_messages("conversation-1")) == 2
    assert reopened.delete_item("conversation", "conversation-1")
    reopened.close()


def test_memory_api_requires_runtime_token_and_supports_cleanup(tmp_path) -> None:
    async def scenario() -> tuple[int, dict[str, object], int, dict[str, object]]:
        config = RuntimeConfig(TOKEN, "mock", None, None, "unused", str(tmp_path / "api.db"))
        transport = ASGITransport(app=create_app(config))
        headers = {"Authorization": f"Bearer {TOKEN}"}
        async with AsyncClient(transport=transport, base_url="http://runtime.test") as client:
            unauthorized = await client.get("/v1/memory")
            logged = await client.post(
                "/v1/memory/tool-log",
                headers=headers,
                json={
                    "taskId": "task-1",
                    "toolCallId": "call-1",
                    "toolName": "open_app",
                    "args": {"appId": "notepad"},
                    "risk": "confirm",
                    "policyDecision": "confirm",
                    "ok": True,
                },
            )
            snapshot = await client.get("/v1/memory", headers=headers)
            cleared = await client.post(
                "/v1/memory/clear",
                headers=headers,
                json={"scope": "tool_logs"},
            )
            return unauthorized.status_code, snapshot.json(), cleared.status_code, logged.json()

    unauthorized_status, snapshot, cleared_status, logged = asyncio.run(scenario())
    assert unauthorized_status == 401
    assert snapshot["apps"][0]["appId"] == "notepad"
    assert cleared_status == 200
    assert logged == {"accepted": True}


def test_memory_candidate_requires_confirmation(tmp_path) -> None:
    store = MemoryStore(str(tmp_path / "candidate.db"))
    candidate_id = store.add_candidate("conversation-1", "先给结论", 0.91, "用户多次表达")
    assert candidate_id is not None
    assert len(store.snapshot()["candidates"]) == 1
    assert store.resolve_candidate(candidate_id, "confirmed")
    assert store.snapshot()["memories"][0]["value"] == "先给结论"
    assert not store.resolve_candidate(candidate_id, "rejected")
    assert _fallback_candidate("请记住我喜欢简洁回答") == "简洁回答"
    store.close()


def test_knowledge_library_indexes_searches_and_updates(tmp_path) -> None:
    """验证 Chroma 持久化、敏感文件排除、增量更新和混合召回闭环。"""
    async def scenario() -> tuple[dict[str, object], list[str], list[str], bool]:
        source = tmp_path / "资料库"
        source.mkdir()
        document = source / "PetDock.md"
        document.write_text(
            "# 启动方式\n\nPetDock 使用 Electron Main 启动 Python Runtime，并通过 SSE 返回消息。",
            encoding="utf-8",
        )
        (source / ".env").write_text("PETDOCK_LLM_API_KEY=secret", encoding="utf-8")
        store = KnowledgeStore(str(tmp_path / "knowledge.db"))
        vectors = ChromaVectorStore(str(tmp_path / "chroma"), LocalHashEmbedding())
        service = KnowledgeService(store, vectors)
        library = await service.create_library("项目资料", str(source))
        for _ in range(100):
            snapshot = store.get_library(str(library["id"]))
            if snapshot["status"] != "indexing":
                break
            await asyncio.sleep(0.02)
        first = await service.search("Runtime 如何返回消息", [str(library["id"])])
        document.write_text("# 新配置\n\n阶段四使用 Chroma 保存向量索引。", encoding="utf-8")
        await service.start_index(str(library["id"]))
        for _ in range(100):
            snapshot = store.get_library(str(library["id"]))
            if snapshot["status"] != "indexing":
                break
            await asyncio.sleep(0.02)
        second = await service.search("阶段四向量保存在哪里", [str(library["id"])])
        summary = store.snapshot()["libraries"][0]
        deleted = await service.delete_library(str(library["id"]))
        await service.close()
        return summary, [item.content for item in first], [item.content for item in second], deleted

    summary, first, second, deleted = asyncio.run(scenario())
    assert summary["status"] == "ready"
    assert summary["documentCount"] == 1
    assert "资料库" in str(summary["displayPath"])
    assert "Runtime" in " ".join(first)
    assert "Chroma" in " ".join(second)
    assert "secret" not in " ".join(first + second)
    assert deleted


def test_knowledge_api_requires_token_and_emits_sources(tmp_path) -> None:
    """验证知识库接口鉴权以及离线聊天返回结构化引用事件。"""
    async def scenario() -> tuple[int, list[dict[str, object]], int]:
        source = tmp_path / "notes"
        source.mkdir()
        (source / "answer.md").write_text("发布口令是蓝色月亮，仅用于知识库测试。", encoding="utf-8")
        config = RuntimeConfig(
            TOKEN,
            "mock",
            None,
            None,
            "unused",
            str(tmp_path / "memory.db"),
            str(tmp_path / "knowledge.db"),
            str(tmp_path / "chroma"),
        )
        transport = ASGITransport(app=create_app(config))
        headers = {"Authorization": f"Bearer {TOKEN}"}
        async with AsyncClient(transport=transport, base_url="http://runtime.test") as client:
            unauthorized = await client.get("/v1/knowledge")
            created = await client.post(
                "/v1/knowledge/library",
                headers=headers,
                json={"name": "测试资料", "path": str(source)},
            )
            library_id = created.json()["library"]["id"]
            for _ in range(100):
                snapshot = await client.get("/v1/knowledge", headers=headers)
                if snapshot.json()["libraries"][0]["status"] != "indexing":
                    break
                await asyncio.sleep(0.02)
            request = make_request("task-rag").model_copy(
                update={"input": "发布口令是什么", "knowledgeLibraryIds": [library_id]}
            )
            await client.post("/v1/chat", headers=headers, json=request.model_dump())
            event_response = await client.get("/v1/events/task-rag", headers=headers)
            events = [
                __import__("json").loads(line[6:])
                for line in event_response.text.splitlines()
                if line.startswith("data: ")
            ]
            deleted = await client.delete(f"/v1/knowledge/library/{library_id}", headers=headers)
            return unauthorized.status_code, events, deleted.status_code

    unauthorized, events, deleted = asyncio.run(scenario())
    assert unauthorized == 401
    assert any(event["type"] == "retrieval_sources" for event in events)
    assert any("蓝色月亮" in event["payload"].get("delta", "") for event in events)
    assert deleted == 200
