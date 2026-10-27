"""验证 Jev 独立路由、故障降级和取消边界。"""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
import httpx

from petdock_runtime.agent.context import retrieve_sources
from petdock_runtime.providers.managed_route import ManagedRouteError, ManagedRouteProvider, RouteDecision
from petdock_runtime.managed.session import ManagedSessionStore


def request(text: str = "你好", libraries: list[str] | None = None) -> SimpleNamespace:
    """构造仅包含检索入口使用字段的合成请求。"""
    return SimpleNamespace(input=text, knowledgeLibraryIds=["synthetic-library"] if libraries is None else libraries)


def knowledge(decision: RouteDecision | Exception | None) -> SimpleNamespace:
    """构造可观察的异步路由和检索端口。"""
    provider = None if decision is None else SimpleNamespace(classify=AsyncMock(
        side_effect=decision if isinstance(decision, BaseException) else None,
        return_value=decision,
    ))
    return SimpleNamespace(route_provider=provider, search_with_trace=AsyncMock(return_value=SimpleNamespace(
        sources=[], trace=SimpleNamespace(degraded_to_hash=False, degraded_reason=None),
    )))


@pytest.mark.parametrize("route,expected_searches", [("SKIP", 0), ("CLARIFY", 0), ("RETRIEVE", 1), ("BOTH", 1)])
def test_valid_jev_decision_never_invokes_regex(route: str, expected_searches: int) -> None:
    """即使寒暄与正则结果不同、置信度很低，也只采用模型所选路由。"""
    service = knowledge(RouteDecision(route, 0.1, {key: 0.25 for key in ["SKIP", "RETRIEVE", "BOTH", "CLARIFY"]}))
    with patch("petdock_runtime.agent.context.plan_retrieval", side_effect=AssertionError("正常路径执行了正则")):
        asyncio.run(retrieve_sources(service, request(), None))
    assert service.route_provider.classify.await_count == 1
    assert service.search_with_trace.await_count == expected_searches


def test_unavailable_jev_calls_regex_once() -> None:
    """调用失败仅执行一次本地降级，恢复正常知识库检索。"""
    from petdock_runtime.rag.planner import plan_retrieval
    service = knowledge(ManagedRouteError("route_provider_timeout"))
    with patch("petdock_runtime.agent.context.plan_retrieval", wraps=plan_retrieval) as fallback:
        asyncio.run(retrieve_sources(service, request("文档中的部署步骤是什么"), None))
    fallback.assert_called_once()
    assert service.search_with_trace.await_count == 1


@pytest.mark.parametrize("libraries,tool_result", [([], None), (["synthetic-library"], object())])
def test_status_skip_never_calls_either_router(libraries, tool_result) -> None:
    """未选知识库和工具续轮按状态直接跳过，避免重复计费。"""
    service = knowledge(RouteDecision("RETRIEVE", 1, {}))
    with patch("petdock_runtime.agent.context.plan_retrieval", side_effect=AssertionError("状态跳过执行了正则")):
        asyncio.run(retrieve_sources(service, request(libraries=libraries), tool_result))
    service.route_provider.classify.assert_not_awaited()
    service.search_with_trace.assert_not_awaited()


def test_cancelled_request_never_falls_back() -> None:
    """取消模型调用必须向上传播，不能继续执行本地检索。"""
    service = knowledge(RouteDecision("RETRIEVE", 1, {}))
    service.route_provider.classify.side_effect = asyncio.CancelledError
    with patch("petdock_runtime.agent.context.plan_retrieval", side_effect=AssertionError("取消后执行了正则")):
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(retrieve_sources(service, request(), None))
    service.search_with_trace.assert_not_awaited()


@pytest.mark.parametrize("mode", ["valid", "invalid", "timeout"])
def test_managed_route_http_boundary(mode: str) -> None:
    """验证官方 Gateway 协议、无效响应和超时，不访问真实上游。"""
    calls = []

    def upstream(request: httpx.Request) -> httpx.Response:
        """只接受最小路由请求，模拟稳定结果与异常。"""
        calls.append(request)
        assert str(request.url) == "https://gateway.invalid/ai/v1/knowledge/route"
        assert json.loads(request.content) == {
            "logicalModel": "route-standard", "input": "合成问题", "selectedLibraryCount": 2,
        }
        if mode == "timeout":
            raise httpx.ReadTimeout("合成超时", request=request)
        return httpx.Response(200, json={
            "route": "RETRIEVE", "confidence": 0.1,
            "probabilities": {"RETRIEVE": 1} if mode == "invalid" else
                {key: 0.25 for key in ["SKIP", "RETRIEVE", "BOTH", "CLARIFY"]},
        })

    async def run() -> None:
        """注入内存短期会话并确保关闭连接池。"""
        session = ManagedSessionStore()
        session.update("synthetic-runtime-token", datetime.now(UTC) + timedelta(minutes=5), 3)
        provider = ManagedRouteProvider("https://gateway.invalid", "0.0.0", "synthetic-device", session,
                                        transport=httpx.MockTransport(upstream))
        try:
            if mode == "valid":
                result = await provider.classify("合成问题", 2)
                assert result.route == "RETRIEVE" and result.confidence == 0.1
            else:
                with pytest.raises(ManagedRouteError, match="route_provider_" + (
                        "timeout" if mode == "timeout" else "invalid_response")):
                    await provider.classify("合成问题", 2)
            assert len(calls) == 1
            session.clear()
            with pytest.raises(ManagedRouteError, match="managed_authentication_required"):
                await provider.classify("合成问题", 2)
            assert len(calls) == 1
        finally:
            await provider.close()

    asyncio.run(run())
