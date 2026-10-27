"""知识库官方路由客户端；仅使用 Runtime 短期会话。"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from typing import Protocol

import httpx

from ..managed.session import ManagedSessionStore
from ..rag.planner import RetrievalRoute
from .rerank import _device_id_from_token

ROUTES = {"SKIP", "RETRIEVE", "BOTH", "CLARIFY"}


class ManagedRouteError(RuntimeError):
    """只保留稳定错误码，不包含用户文本或远端响应。"""

    def __init__(self, code: str) -> None:
        """保存用于降级日志的错误分类。"""
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class RouteDecision:
    """模型路由与诊断概率，低置信度不改变所选路由。"""

    route: RetrievalRoute
    confidence: float
    probabilities: dict[str, float]


class RouteProvider(Protocol):
    """路由窄接口，不承担召回或工具权限判断。"""

    async def classify(self, text: str, library_count: int) -> RouteDecision:
        """返回独立语义判断。"""

    async def close(self) -> None:
        """释放连接资源。"""


class ManagedRouteProvider:
    """异步调用官方 Gateway，不持有 Jev 上游地址或密钥。"""

    def __init__(self, base_url: str, client_version: str, device_id: str,
                 session: ManagedSessionStore, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        """创建禁止重试与重定向的客户端。"""
        self._url = f"{base_url.rstrip('/')}/ai/v1/knowledge/route"
        self._version, self._device_id, self._session = client_version, device_id, session
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(18, connect=5),
                                         follow_redirects=False, transport=transport)

    async def classify(self, text: str, library_count: int) -> RouteDecision:
        """发送当前输入；取消自动向上传播，不自动重放计费请求。"""
        lease = self._session.lease()
        if lease is None:
            raise ManagedRouteError("managed_authentication_required")
        if not text.strip() or len(text) > 8192:
            raise ManagedRouteError("route_input_out_of_range")
        headers = {
            "Authorization": f"Bearer {lease.access_token}",
            "X-PetDock-Trace-Id": str(uuid.uuid4()), "X-PetDock-Request-Id": str(uuid.uuid4()),
            "X-PetDock-Attempt-Id": str(uuid.uuid4()), "X-PetDock-Client-Version": self._version,
            "X-PetDock-Device-Id": _device_id_from_token(lease.access_token, self._device_id),
        }
        try:
            response = await self._client.post(self._url, headers=headers, json={
                "logicalModel": "route-standard", "input": text, "selectedLibraryCount": library_count,
            })
        except httpx.TimeoutException:
            raise ManagedRouteError("route_provider_timeout") from None
        except httpx.HTTPError:
            raise ManagedRouteError("route_provider_unavailable") from None
        if response.status_code != 200:
            # 只从稳定白名单映射错误，不把任意上游内容写进本地日志。
            code = {401: "managed_authentication_required", 403: "managed_capability_not_entitled",
                    429: "route_rate_limited", 413: "route_input_out_of_range"}.get(
                        response.status_code, "route_provider_unavailable")
            raise ManagedRouteError(code)
        try:
            if len(response.content) > 65_536:
                raise ValueError
            body = response.json()
            route, confidence, probabilities = body["route"], body["confidence"], body["probabilities"]
            if route not in ROUTES or not isinstance(probabilities, dict) or set(probabilities) != ROUTES:
                raise ValueError
            if any(isinstance(value, bool) or not isinstance(value, (int, float))
                   or not math.isfinite(value) or not 0 <= value <= 1
                   for value in [confidence, *probabilities.values()]):
                raise ValueError
            return RouteDecision(route, confidence, probabilities)
        except (ValueError, TypeError, KeyError):
            raise ManagedRouteError("route_provider_invalid_response") from None

    async def close(self) -> None:
        """关闭异步连接池。"""
        await self._client.aclose()
