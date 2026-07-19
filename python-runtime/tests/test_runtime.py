from __future__ import annotations

import asyncio

from httpx import ASGITransport, AsyncClient

from petdock_runtime.backends import MockBackend
from petdock_runtime.config import RuntimeConfig
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
