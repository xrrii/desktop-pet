from __future__ import annotations

import asyncio
from dataclasses import dataclass


@dataclass(frozen=True)
class ManagedAuthResultValue:
    """Main 返回的任务认证结果，不包含任何凭据。"""

    result: str
    error_code: str | None


class ManagedAuthRefreshCoordinator:
    """按 taskId/requestId 关联未来的任务内认证刷新结果。"""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._pending: dict[tuple[str, str], asyncio.Future[ManagedAuthResultValue]] = {}

    async def wait_for_result(
        self,
        task_id: str,
        request_id: str,
        timeout_seconds: float,
    ) -> ManagedAuthResultValue:
        """登记并等待一次刷新结果；同一请求不能重复登记。"""
        key = (task_id, request_id)
        future = asyncio.get_running_loop().create_future()
        async with self._lock:
            if key in self._pending:
                raise ValueError("Managed 认证刷新请求已经在等待中。")
            self._pending[key] = future
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout_seconds)
        finally:
            async with self._lock:
                if self._pending.get(key) is future:
                    self._pending.pop(key, None)

    async def submit(
        self,
        task_id: str,
        request_id: str,
        result: ManagedAuthResultValue,
    ) -> bool:
        """提交 Main 结果；没有匹配等待任务时返回 false。"""
        key = (task_id, request_id)
        async with self._lock:
            future = self._pending.get(key)
            if future is None or future.done():
                return False
            future.set_result(result)
            return True

    async def close(self) -> None:
        """Runtime 关闭时取消全部等待任务。"""
        async with self._lock:
            futures = list(self._pending.values())
            self._pending.clear()
        for future in futures:
            if not future.done():
                future.cancel()

