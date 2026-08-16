from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from httpx import ASGITransport, AsyncClient

from petdock_runtime.api.server import create_app
from petdock_runtime.config import RuntimeConfig
from petdock_runtime.managed.auth_refresh import (
    ManagedAuthRefreshCoordinator,
    ManagedAuthResultValue,
)
from petdock_runtime.managed.session import ManagedSessionStore

LOCAL_TOKEN = "l" * 64
RUNTIME_TOKEN = "synthetic-runtime-access-token-value-0001"
TASK_ID = "7a70c803-f62f-4418-81c6-905f848322f1"
REQUEST_ID = "54ca903e-23da-42bb-a69b-125f3669962b"


def test_managed_session_routes_keep_only_redacted_memory_status(tmp_path) -> None:
    """验证更新、查询和清除闭环，状态响应不得包含官方 Token。"""

    async def scenario() -> tuple[int, dict[str, object], int, dict[str, object]]:
        app = create_app(runtime_config(tmp_path))
        transport = ASGITransport(app=app)
        headers = {"Authorization": f"Bearer {LOCAL_TOKEN}"}
        async with AsyncClient(transport=transport, base_url="http://runtime.test") as client:
            unauthorized = await client.get("/v1/managed/session/status")
            updated = await client.put(
                "/v1/managed/session",
                headers=headers,
                json={
                    "accessToken": RUNTIME_TOKEN,
                    "expiresAt": "2099-08-16T00:15:00Z",
                    "capabilitySnapshotVersion": 3,
                },
            )
            status = await client.get("/v1/managed/session/status", headers=headers)
            cleared = await client.delete("/v1/managed/session", headers=headers)
            empty = await client.get("/v1/managed/session/status", headers=headers)
            return unauthorized.status_code, status.json(), updated.status_code, {
                "clearStatus": cleared.status_code,
                "empty": empty.json(),
            }

    unauthorized, status, updated, cleared = asyncio.run(scenario())
    assert unauthorized == 401
    assert updated == 204
    assert status == {
        "configured": True,
        "expiresAt": "2099-08-16T00:15:00Z",
        "capabilitySnapshotVersion": 3,
    }
    assert RUNTIME_TOKEN not in str(status)
    assert cleared == {
        "clearStatus": 204,
        "empty": {
            "configured": False,
            "expiresAt": None,
            "capabilitySnapshotVersion": None,
        },
    }


def test_managed_session_request_rejects_unknown_fields_and_naive_time(tmp_path) -> None:
    """本地协议拒绝额外字段和无时区时间。"""

    async def scenario() -> tuple[int, int]:
        transport = ASGITransport(app=create_app(runtime_config(tmp_path)))
        headers = {"Authorization": f"Bearer {LOCAL_TOKEN}"}
        base = {
            "accessToken": RUNTIME_TOKEN,
            "expiresAt": "2026-08-16T00:15:00Z",
            "capabilitySnapshotVersion": 3,
        }
        async with AsyncClient(transport=transport, base_url="http://runtime.test") as client:
            extra = await client.put(
                "/v1/managed/session",
                headers=headers,
                json={**base, "refreshToken": "forbidden"},
            )
            naive = await client.put(
                "/v1/managed/session",
                headers=headers,
                json={**base, "expiresAt": "2026-08-16T00:15:00"},
            )
            return extra.status_code, naive.status_code

    assert asyncio.run(scenario()) == (400, 400)


def test_managed_auth_result_matches_one_waiting_request() -> None:
    """刷新结果只能消费一次，并严格关联 taskId/requestId。"""

    async def scenario() -> tuple[ManagedAuthResultValue, bool]:
        coordinator = ManagedAuthRefreshCoordinator()
        waiting = asyncio.create_task(coordinator.wait_for_result(TASK_ID, REQUEST_ID, 1))
        await asyncio.sleep(0)
        accepted = await coordinator.submit(
            TASK_ID,
            REQUEST_ID,
            ManagedAuthResultValue("refreshed", None),
        )
        result = await waiting
        repeated = await coordinator.submit(
            TASK_ID,
            REQUEST_ID,
            ManagedAuthResultValue("failed", "token_expired"),
        )
        await coordinator.close()
        assert accepted
        return result, repeated

    result, repeated = asyncio.run(scenario())
    assert result == ManagedAuthResultValue("refreshed", None)
    assert not repeated


def test_managed_session_repr_hides_token() -> None:
    """即使异常日志误用 repr，也不能输出官方 Runtime Token。"""
    store = ManagedSessionStore(lambda: datetime(2026, 8, 16, 0, 0, tzinfo=UTC))
    store.update(RUNTIME_TOKEN, datetime(2026, 8, 16, 0, 15, tzinfo=UTC), 3)

    assert RUNTIME_TOKEN not in repr(store.lease())
    assert store.status()["configured"] is True


def test_managed_session_expiry_is_cleared_from_lease_and_status() -> None:
    """Lease 到期后 Provider 读取和脱敏状态都必须视为未配置。"""
    current = datetime(2026, 8, 16, 0, 15, tzinfo=UTC)
    store = ManagedSessionStore(lambda: current)
    store.update(RUNTIME_TOKEN, current, 3)

    assert store.lease() is None
    assert store.status() == {
        "configured": False,
        "expiresAt": None,
        "capabilitySnapshotVersion": None,
    }


def runtime_config(tmp_path) -> RuntimeConfig:
    """创建所有持久目录都位于 pytest 临时目录的 Runtime 配置。"""
    return RuntimeConfig(
        LOCAL_TOKEN,
        "mock",
        None,
        None,
        "unused",
        str(tmp_path / "memory.db"),
        str(tmp_path / "knowledge.db"),
        str(tmp_path / "chroma"),
        str(tmp_path / "skills.db"),
        str(tmp_path / "skills"),
        attachment_root=str(tmp_path / "attachments"),
        artifact_root=str(tmp_path / "artifacts"),
        attachment_index_root=str(tmp_path / "attachment-index"),
    )
