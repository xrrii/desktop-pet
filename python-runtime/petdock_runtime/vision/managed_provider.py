"""Managed Vision 独立网络适配器，只消费 Runtime 内存短期会话。"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

from ..agent.contracts import ManagedAuthRefreshRequired
from ..managed.auth_refresh import ManagedAuthRefreshCoordinator
from ..managed.session import ManagedSessionStore


class ManagedVisionError(RuntimeError):
    """Managed Vision 稳定错误，不保留 Token、图片或响应正文。"""

    def __init__(self, code: str) -> None:
        """保存允许向附件流程传播的固定错误码。"""
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ManagedVisionResult:
    """Cloud 返回的结构化摘要及 Descriptor Revision。"""

    descriptor_revision: str
    summary: dict[str, object]


RefreshNotifier = Callable[[ManagedAuthRefreshRequired], Awaitable[None]]


class ManagedVisionProvider:
    """调用官方 Capabilities 与 Vision Multipart 路由的独立 Adapter。"""

    def __init__(
        self,
        base_url: str,
        client_version: str,
        device_id: str,
        session: ManagedSessionStore,
        auth_refresh: ManagedAuthRefreshCoordinator,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """创建独立连接池；不接收或复用 BYOK/Chat Provider 配置。"""
        root = base_url.rstrip("/")
        self._capabilities_url = f"{root}/ai/v1/capabilities"
        self._analyze_url = f"{root}/ai/v1/vision/analyze"
        self._client_version = client_version
        self._device_id = device_id
        self._session = session
        self._auth_refresh = auth_refresh
        self._descriptor_revision: str | None = None
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(65.0, connect=10.0),
            follow_redirects=False,
            transport=transport,
        )

    @property
    def descriptor_revision(self) -> str | None:
        """返回最近一次认证探测得到的公开 Revision。"""
        return self._descriptor_revision

    @property
    def signature(self) -> str:
        """返回不含端点和凭据的缓存签名。"""
        return f"managed-vision-v1:{self._descriptor_revision or 'unresolved'}"

    async def probe(self) -> str:
        """只读取公开能力描述，不上传探测图片或消耗 Vision 配额。"""
        return await self._load_descriptor("vision-probe", None)

    async def prepare(self, task_id: str, notify_refresh: RefreshNotifier) -> str:
        """在缓存查找和图片上传前解析本次请求使用的 Descriptor。"""
        return await self._load_descriptor(task_id, notify_refresh)

    async def analyze(
        self,
        task_id: str,
        image: bytes,
        notify_refresh: RefreshNotifier,
        descriptor_revision: str | None = None,
    ) -> ManagedVisionResult:
        """在上传前安全点允许一次认证刷新；上传请求本身永不自动重放。"""
        revision = descriptor_revision or await self._load_descriptor(task_id, notify_refresh)
        lease = self._session.lease()
        if lease is None:
            raise ManagedVisionError("managed_authentication_required")
        trace_id, request_id, attempt_id = (str(uuid.uuid4()) for _ in range(3))
        headers = self._headers(lease.access_token, trace_id, request_id, attempt_id)
        try:
            async with self._client.stream(
                "POST",
                self._analyze_url,
                headers=headers,
                data={
                    "logicalModel": "vision-standard",
                    "descriptorRevision": revision,
                    "mimeType": "image/png",
                },
                files={"image": ("derived.png", image, "image/png")},
            ) as response:
                body = await _read_limited(response, 262_144)
        except asyncio.CancelledError:
            raise
        except httpx.TimeoutException as error:
            raise ManagedVisionError("vision_provider_timeout") from error
        except httpx.HTTPError as error:
            raise ManagedVisionError("vision_provider_unavailable") from error
        if response.status_code != 200:
            raise _response_error(response.status_code, body)
        payload = _json_object(body)
        response_revision = payload.get("descriptorRevision")
        summary = payload.get("summary")
        usage = payload.get("usage")
        if response_revision != revision or not isinstance(summary, dict) or not isinstance(usage, dict):
            raise ManagedVisionError("vision_summary_failed")
        if type(usage.get("inputUnits")) is not int or type(usage.get("outputUnits")) is not int:
            raise ManagedVisionError("vision_summary_failed")
        return ManagedVisionResult(revision, summary)

    async def close(self) -> None:
        """关闭独立 Vision HTTP 连接池。"""
        await self._client.aclose()

    async def _load_descriptor(
        self,
        task_id: str,
        notify_refresh: RefreshNotifier | None,
    ) -> str:
        """认证读取 Descriptor；仅在图片上传前通过 Main 刷新一次 Token。"""
        trace_id = str(uuid.uuid4())
        request_id = str(uuid.uuid4())
        refreshed = False
        while True:
            lease = self._session.lease()
            if lease is None:
                raise ManagedVisionError("managed_authentication_required")
            attempt_id = str(uuid.uuid4())
            try:
                response = await self._client.get(
                    self._capabilities_url,
                    headers=self._headers(lease.access_token, trace_id, request_id, attempt_id),
                )
            except httpx.TimeoutException as error:
                raise ManagedVisionError("vision_provider_timeout") from error
            except httpx.HTTPError as error:
                raise ManagedVisionError("vision_provider_unavailable") from error
            body = response.content[:65_537]
            error = _response_error(response.status_code, body, "token_expired") \
                if response.status_code != 200 else None
            if error and error.code == "token_expired" and notify_refresh and not refreshed:
                refreshed = True
                await self._auth_refresh.prepare(task_id, request_id)
                await notify_refresh(ManagedAuthRefreshRequired(task_id, trace_id, request_id))
                try:
                    result = await self._auth_refresh.wait_for_result(task_id, request_id, 120)
                except TimeoutError as timeout_error:
                    raise ManagedVisionError("managed_authentication_required") from timeout_error
                if result.result != "refreshed":
                    raise ManagedVisionError(result.error_code or "managed_authentication_required")
                continue
            if error:
                raise error
            if len(body) > 65_536:
                raise ManagedVisionError("vision_provider_unavailable")
            payload = _json_object(body)
            capabilities = payload.get("capabilities")
            vision = capabilities.get("vision") if isinstance(capabilities, dict) else None
            descriptor = vision.get("descriptor") if isinstance(vision, dict) else None
            revision = descriptor.get("revision") if isinstance(descriptor, dict) else None
            if (not isinstance(vision, dict) or vision.get("available") is not True
                    or vision.get("logicalModel") != "vision-standard"
                    or not isinstance(revision, str) or not revision or len(revision) > 64):
                raise ManagedVisionError("vision_provider_unavailable")
            self._descriptor_revision = revision
            return revision

    def _headers(self, token: str, trace_id: str, request_id: str, attempt_id: str) -> dict[str, str]:
        """构造数据面认证和链路头，Token 仅存在于当前请求内存。"""
        return {
            "Authorization": f"Bearer {token}",
            "X-PetDock-Trace-Id": trace_id,
            "X-PetDock-Request-Id": request_id,
            "X-PetDock-Attempt-Id": attempt_id,
            "X-PetDock-Client-Version": self._client_version,
            "X-PetDock-Device-Id": _device_id_from_token(token, self._device_id),
            "Accept": "application/json",
        }


async def _read_limited(response: httpx.Response, limit: int) -> bytes:
    """分块读取响应并限制内存占用。"""
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > limit:
            raise ManagedVisionError("vision_summary_failed")
        chunks.append(chunk)
    return b"".join(chunks)


def _json_object(body: bytes) -> dict[str, object]:
    """解析有界 JSON 对象，错误正文不进入异常。"""
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ManagedVisionError("vision_provider_unavailable") from error
    if not isinstance(value, dict):
        raise ManagedVisionError("vision_provider_unavailable")
    return value


def _response_error(
    status_code: int,
    body: bytes,
    token_expired_code: str = "managed_authentication_required",
) -> ManagedVisionError:
    """将数据面 ErrorEnvelope 转换为稳定本地错误。"""
    code = "vision_provider_unavailable"
    try:
        payload = json.loads(body)
        error = payload.get("error") if isinstance(payload, dict) else None
        value = error.get("code") if isinstance(error, dict) else None
        if isinstance(value, str) and value:
            code = value
    except (UnicodeDecodeError, json.JSONDecodeError):
        pass
    mapping = {
        "authentication_required": "managed_authentication_required",
        "capability_not_entitled": "managed_capability_not_entitled",
        "capability_disabled": "vision_provider_unavailable",
        "provider_timeout": "vision_provider_timeout",
        "provider_unavailable": "vision_provider_unavailable",
        "quota_exhausted": "managed_quota_exhausted",
        "rate_limited": "vision_rate_limited",
        # POST 上传后的过期只映射为重新认证，调用方不得自动重放图片。
        "token_expired": token_expired_code,
    }
    return ManagedVisionError(mapping.get(code, "vision_provider_unavailable"))


def _device_id_from_token(token: str, fallback: str) -> str:
    """读取 Main 已验证 JWT 的设备 Claim；失败时使用受控启动配置。"""
    try:
        parts = token.split(".")
        padding = "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + padding))
        value = claims.get("device_id") if isinstance(claims, dict) else None
        if isinstance(value, str):
            uuid.UUID(value)
            return value
    except (IndexError, ValueError, TypeError, binascii.Error, json.JSONDecodeError):
        pass
    return fallback
