"""本地检索后的 Rerank Provider 窄接口及 Managed 适配器。"""

from __future__ import annotations

import json
import base64
import binascii
import logging
import uuid
from typing import Protocol

import httpx

from ..managed.session import ManagedSessionStore

LOGGER = logging.getLogger("petdock.providers.rerank")


class RerankProvider(Protocol):
    """只接受已通过本地准入的查询和候选，不负责召回。"""

    def rerank(self, query: str, candidates: list[dict[str, str]]) -> dict[str, float]:
        """返回原候选 ID 到有限分数的映射。"""

    def close(self) -> None:
        """释放 Provider 资源。"""


class ManagedRerankError(RuntimeError):
    """Managed Rerank 稳定错误，不保留查询或候选正文。"""

    def __init__(self, code: str) -> None:
        """保存稳定错误码。"""
        super().__init__(code)
        self.code = code


class ManagedRerankProvider:
    """通过 AI Gateway 调用服务器本地 BGE Reranker。"""

    def __init__(self, base_url: str, client_version: str, device_id: str, session: ManagedSessionStore) -> None:
        """创建独立同步客户端，不接收 BYOK 凭据。"""
        self._url = f"{base_url.rstrip('/')}/ai/v1/rerank"
        self._client_version = client_version
        self._device_id = device_id
        self._session = session
        self._client = httpx.Client(timeout=httpx.Timeout(35.0, connect=8.0), follow_redirects=False)

    def rerank(self, query: str, candidates: list[dict[str, str]]) -> dict[str, float]:
        """执行一次不可自动重放的受控重排请求。"""
        lease = self._session.lease()
        if lease is None:
            raise ManagedRerankError("managed_authentication_required")
        headers = {
            "Authorization": f"Bearer {lease.access_token}",
            "X-PetDock-Trace-Id": str(uuid.uuid4()),
            "X-PetDock-Request-Id": str(uuid.uuid4()),
            "X-PetDock-Attempt-Id": str(uuid.uuid4()),
            "X-PetDock-Client-Version": self._client_version,
            # 与 Chat Provider 一致，优先使用 Runtime Session JWT 的设备 Claim。
            "X-PetDock-Device-Id": _device_id_from_token(lease.access_token, self._device_id),
            "Accept": "application/json",
        }
        try:
            response = self._client.post(
                self._url,
                headers=headers,
                json={"logicalModel": "rerank-standard", "query": query, "candidates": candidates},
            )
        except httpx.TimeoutException as error:
            raise ManagedRerankError("rerank_provider_timeout") from error
        except httpx.HTTPError as error:
            raise ManagedRerankError("rerank_provider_unavailable") from error
        if response.status_code != 200:
            error_code = _response_error(response.content)
            # 只记录状态和稳定错误码，不记录查询、候选、Token 或响应正文。
            LOGGER.warning(
                "Managed Rerank 上游请求失败 status=%s errorCode=%s",
                response.status_code,
                error_code,
            )
            raise ManagedRerankError(error_code)
        try:
            body = response.json()
            rows = body["results"]
            expected = {str(item["id"]) for item in candidates}
            actual = {str(item["id"]) for item in rows}
            if len(rows) != len(candidates) or actual != expected:
                raise ValueError("候选集合不一致")
            scores = {str(item["id"]): float(item["score"]) for item in rows}
            if any(score != score or score in {float("inf"), float("-inf")} for score in scores.values()):
                raise ValueError("分数无效")
            return scores
        except (ValueError, TypeError, KeyError, IndexError, json.JSONDecodeError) as error:
            raise ManagedRerankError("rerank_provider_invalid_response") from error

    def close(self) -> None:
        """关闭 HTTP 客户端。"""
        self._client.close()


def _response_error(body: bytes) -> str:
    """将 Cloud ErrorEnvelope 映射为本地稳定错误。"""
    try:
        code = json.loads(body).get("error", {}).get("code")
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
        code = None
    return {
        "authentication_required": "managed_authentication_required",
        "token_expired": "managed_authentication_required",
        "capability_not_entitled": "managed_capability_not_entitled",
        "quota_exhausted": "managed_quota_exhausted",
        "provider_timeout": "rerank_provider_timeout",
    }.get(code, "rerank_provider_unavailable")


def _device_id_from_token(token: str, fallback: str) -> str:
    """读取已由 Main 注入的 JWT 设备 Claim；解析失败时使用启动配置。"""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return fallback
        padding = "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + padding))
        value = claims.get("device_id") if isinstance(claims, dict) else None
        if isinstance(value, str):
            uuid.UUID(value)
            return value
    except (IndexError, ValueError, TypeError, binascii.Error, json.JSONDecodeError):
        pass
    return fallback
