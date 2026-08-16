from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from threading import RLock


@dataclass(frozen=True)
class ManagedSessionLease:
    """Runtime 内存中的官方短期会话，repr 刻意隐藏 Token。"""

    access_token: str = field(repr=False)
    expires_at: datetime
    capability_snapshot_version: int


class ManagedSessionStore:
    """线程安全保存官方 Runtime Token，不提供任何持久化路径。"""

    def __init__(self) -> None:
        self._lock = RLock()
        self._lease: ManagedSessionLease | None = None

    def update(
        self,
        access_token: str,
        expires_at: datetime,
        capability_snapshot_version: int,
    ) -> None:
        """原子替换完整 Lease，避免并发请求读到半更新状态。"""
        lease = ManagedSessionLease(access_token, expires_at, capability_snapshot_version)
        with self._lock:
            self._lease = lease

    def clear(self) -> None:
        """立即删除 Runtime 内存中的官方短期会话。"""
        with self._lock:
            self._lease = None

    def lease(self) -> ManagedSessionLease | None:
        """仅向后续 Managed Provider 返回当前 Lease 的不可变引用。"""
        with self._lock:
            return self._lease

    def status(self) -> dict[str, object]:
        """返回不含 Token、用户、设备和 Session 标识的状态。"""
        with self._lock:
            lease = self._lease
        if lease is None:
            return {
                "configured": False,
                "expiresAt": None,
                "capabilitySnapshotVersion": None,
            }
        return {
            "configured": True,
            "expiresAt": lease.expires_at.isoformat().replace("+00:00", "Z"),
            "capabilitySnapshotVersion": lease.capability_snapshot_version,
        }

