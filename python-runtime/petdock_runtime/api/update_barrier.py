from __future__ import annotations

from dataclasses import dataclass

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send


@dataclass
class RuntimeUpdateBarrier:
    """记录完整 HTTP/SSE 生命周期，并在更新停机前冻结新请求。"""

    active_requests: int = 0
    prepared: bool = False


class RuntimeUpdateBarrierMiddleware:
    """使用原始 ASGI 生命周期计数，流式响应结束前不得视为空闲。"""

    def __init__(self, app: ASGIApp, barrier: RuntimeUpdateBarrier) -> None:
        """绑定应用与事件循环内共享的互锁状态。"""
        self.app = app
        self.barrier = barrier

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """允许控制路由恢复或关闭服务，其余请求在准备成功后统一拒绝。"""
        controls = {"/health", "/v1/update/prepare", "/v1/update/resume", "/v1/shutdown"}
        if scope["type"] != "http" or scope["path"] in controls:
            await self.app(scope, receive, send)
            return
        if self.barrier.prepared:
            response = JSONResponse(status_code=409, content={"detail": "正在准备安装更新。"})
            await response(scope, receive, send)
            return
        self.barrier.active_requests += 1
        try:
            await self.app(scope, receive, send)
        finally:
            self.barrier.active_requests -= 1
