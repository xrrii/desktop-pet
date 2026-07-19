from __future__ import annotations

import asyncio

from httpx import ASGITransport, AsyncClient

from petdock_runtime.backends import MockBackend
from petdock_runtime.config import RuntimeConfig
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
