from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta

import httpx
from langchain_core.messages import HumanMessage

from petdock_runtime.managed.auth_refresh import ManagedAuthRefreshCoordinator, ManagedAuthResultValue
from petdock_runtime.managed.session import ManagedSessionStore
from petdock_runtime.agent.contracts import ManagedAuthRefreshRequired
from petdock_runtime.providers.chat import (
    ManagedChatModel,
    ManagedProviderError,
    _serialize_messages,
)


def _session() -> ManagedSessionStore:
    """创建测试用内存 Session，不输出或持久化任何凭据。"""
    store = ManagedSessionStore()
    store.update("t" * 64, datetime.now(UTC) + timedelta(minutes=5), 3)
    return store


def _sse(headers: httpx.Headers, events: list[dict[str, object]]) -> httpx.Response:
    """按请求链路头构造最小合法 Cloud SSE 响应。"""
    trace_id = headers["X-PetDock-Trace-Id"]
    request_id = headers["X-PetDock-Request-Id"]
    payload = []
    for event in events:
        payload.append({"eventVersion": 1, "traceId": trace_id, "requestId": request_id, **event})
    body = "".join(f"data: {json.dumps(item)}\n\n" for item in payload)
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)


def test_managed_provider_serializes_history_and_consumes_sse() -> None:
    """Managed 适配器发送严格消息并消费 delta、usage、completed。"""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return _sse(request.headers, [
            {"type": "delta", "sequence": 1, "text": "你好"},
            {"type": "usage", "sequence": 2, "inputUnits": 2, "outputUnits": 1},
            {"type": "completed", "sequence": 3, "finishReason": "stop"},
        ])

    async def scenario() -> list[str]:
        model = ManagedChatModel(
            "https://ai.petdock.site",
            "0.2.0",
            "00000000-0000-4000-8000-000000000001",
            _session(),
            ManagedAuthRefreshCoordinator(),
            transport=httpx.MockTransport(handler),
        )
        model.set_request_context("00000000-0000-4000-8000-000000000002")
        model.bind_tools([])
        chunks = [chunk async for chunk in model.astream([HumanMessage(content="你好")])]
        await model.close()
        return [chunk.content for chunk in chunks]

    assert asyncio.run(scenario()) == ["你好"]
    payload = json.loads(requests[0].content)
    assert payload == {"logicalModel": "chat-standard", "messages": [{"role": "user", "content": "你好"}], "stream": True}
    assert "Authorization" in requests[0].headers


def test_managed_provider_refreshes_once_before_output() -> None:
    """流前 token_expired 只触发一次 Main 刷新，并保留 requestId、更换 attemptId。"""
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(401, json={"error": {"code": "token_expired", "retryable": False}})
        return _sse(request.headers, [
            {"type": "delta", "sequence": 1, "text": "完成"},
            {"type": "usage", "sequence": 2, "inputUnits": 1, "outputUnits": 1},
            {"type": "completed", "sequence": 3, "finishReason": "stop"},
        ])

    async def scenario() -> tuple[ManagedAuthRefreshRequired, list[str]]:
        coordinator = ManagedAuthRefreshCoordinator()
        model = ManagedChatModel(
            "https://ai.petdock.site",
            "0.2.0",
            "00000000-0000-4000-8000-000000000001",
            _session(),
            coordinator,
            transport=httpx.MockTransport(handler),
        )
        model.set_request_context("00000000-0000-4000-8000-000000000002")
        iterator = model.astream([])
        event = await anext(iterator)
        assert isinstance(event, ManagedAuthRefreshRequired)
        # 即使 Main 在 Runtime 恢复生成器前提交，结果也必须已经被登记并可消费。
        assert await coordinator.submit(event.task_id, event.request_id, ManagedAuthResultValue("refreshed", None))
        first = await anext(iterator)
        rest = [chunk async for chunk in iterator]
        await model.close()
        return event, [first.content, *[chunk.content for chunk in rest]]

    event, text = asyncio.run(scenario())
    assert text == ["完成"]
    assert calls[0].headers["X-PetDock-Request-Id"] == calls[1].headers["X-PetDock-Request-Id"]
    assert calls[0].headers["X-PetDock-Attempt-Id"] != calls[1].headers["X-PetDock-Attempt-Id"]


def test_managed_provider_rejects_sequence_and_maps_transport_error() -> None:
    """序号异常和网络异常都映射为稳定错误，不传播响应正文。"""
    def handler(request: httpx.Request) -> httpx.Response:
        return _sse(request.headers, [{"type": "delta", "sequence": 2, "text": "非法"}])

    async def scenario() -> None:
        model = ManagedChatModel(
            "https://ai.petdock.site", "0.2.0", "00000000-0000-4000-8000-000000000001",
            _session(), ManagedAuthRefreshCoordinator(), transport=httpx.MockTransport(handler),
        )
        model.set_request_context("00000000-0000-4000-8000-000000000002")
        try:
            [chunk async for chunk in model.astream([])]
        except ManagedProviderError as error:
            assert error.code == "stream_protocol_error"
        else:
            raise AssertionError("应拒绝跳号 SSE")
        await model.close()

    asyncio.run(scenario())


def test_managed_provider_keeps_multiple_tool_calls_separate() -> None:
    """多个 Cloud 工具事件必须映射为不同的 LangChain 工具片段索引。"""
    def handler(request: httpx.Request) -> httpx.Response:
        return _sse(request.headers, [
            {"type": "tool_call", "sequence": 1, "toolCallId": "call-1", "name": "open_app", "arguments": {"appId": "notepad"}},
            {"type": "tool_call", "sequence": 2, "toolCallId": "call-2", "name": "list_memories", "arguments": {}},
            {"type": "usage", "sequence": 3, "inputUnits": 1, "outputUnits": 1},
            {"type": "completed", "sequence": 4, "finishReason": "tool_calls"},
        ])

    async def scenario() -> list[dict[str, object]]:
        model = ManagedChatModel(
            "https://ai.petdock.site", "0.2.0", "00000000-0000-4000-8000-000000000001",
            _session(), ManagedAuthRefreshCoordinator(), transport=httpx.MockTransport(handler),
        )
        model.set_request_context("00000000-0000-4000-8000-000000000002")
        chunks = [chunk async for chunk in model.astream([HumanMessage(content="执行")])]
        await model.close()
        return [fragment for chunk in chunks for fragment in (chunk.tool_call_chunks or [])]

    assert [fragment["index"] for fragment in asyncio.run(scenario())] == [0, 1]


def test_serialize_messages_maps_tool_history() -> None:
    """历史消息转换为 Cloud toolCalls/toolCallId 字段。"""
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

    messages = _serialize_messages([
        HumanMessage(content="执行"),
        AIMessage(content="", tool_calls=[{"id": "call-1", "name": "demo", "args": {"x": 1}}]),
        ToolMessage(content="完成", tool_call_id="call-1"),
    ])
    assert messages[1]["toolCalls"] == [{"id": "call-1", "name": "demo", "arguments": {"x": 1}}]
    assert messages[2] == {"role": "tool", "toolCallId": "call-1", "content": "完成"}
