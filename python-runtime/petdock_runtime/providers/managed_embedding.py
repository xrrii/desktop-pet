"""Managed Embedding 适配器；向官方数据面请求服务器本地模型。"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import time
import uuid
from threading import Lock, RLock
from typing import Any, Callable

import httpx

from ..managed.session import ManagedSessionLease, ManagedSessionStore
from .embeddings import (
    EmbeddingDescriptor,
    _normalize,
    _validate_vectors,
    check_embedding_pause,
    embedding_batch_ranges,
)


# 保留公开协议的单项硬上限；正常建库使用下方更小的计算预算。
MAX_BATCH_INPUT_UNITS = 50_000
LOGGER = logging.getLogger("petdock.providers.managed_embedding")


class ManagedEmbeddingError(RuntimeError):
    """Managed Embedding 稳定错误，不保留输入正文。"""

    def __init__(self, code: str) -> None:
        """保存稳定错误码。"""
        super().__init__(code)
        self.code = code


class ManagedEmbeddingProvider:
    """同步批量调用 Cloud Embedding 路由，供知识库索引线程使用。"""

    # 公开 128 条/50000 字符是协议上限，不能作为单机 CPU 推理的目标批量。
    document_batch_size = 32
    document_batch_input_units = 12_000

    def __init__(
        self,
        base_url: str,
        client_version: str,
        device_id: str,
        session: ManagedSessionStore,
        descriptor_revision: str = "bge-base-zh-v1.5",
        dimensions: int = 768,
    ) -> None:
        """创建独立 HTTP 客户端，不接收 BYOK 凭据。"""
        self._url = f"{base_url.rstrip('/')}/ai/v1/embeddings"
        self._client_version = client_version
        self._device_id = device_id
        self._session = session
        self.descriptor = EmbeddingDescriptor(
            id="bge-base-zh-v1.5",
            revision=descriptor_revision,
            dimensions=dimensions,
            max_tokens=512,
            pooling="mean",
            normalize=True,
            query_prefix="为这个句子生成表示以用于检索：",
            document_prefix="",
            tokenizer_version=descriptor_revision,
            chunk_strategy_version="v2",
            candidate_min_similarity=0.45,
            final_min_similarity=0.62,
        )
        self._client = httpx.Client(timeout=httpx.Timeout(50.0, connect=10.0), follow_redirects=False)
        self._state_lock = RLock()
        self._request_lock = Lock()
        self._quota_rejected_input_units: int | None = None

    def reset_degraded(self) -> None:
        """在服务器能力快照或会话更新后允许重新探测官方额度。"""
        with self._state_lock:
            self._quota_rejected_input_units = None

    def _is_quota_exhausted(self, input_units: int) -> bool:
        """只拦截不小于已拒绝批次的请求，保留小查询使用剩余额度的机会。"""
        with self._state_lock:
            return (
                self._quota_rejected_input_units is not None
                and input_units >= self._quota_rejected_input_units
            )

    def _mark_quota_exhausted(self, input_units: int) -> bool:
        """记住最小被拒批次的规模；预占不足不代表余额已经为零。"""
        with self._state_lock:
            reduced = self._quota_rejected_input_units is None or input_units < self._quota_rejected_input_units
            if reduced:
                self._quota_rejected_input_units = input_units
            return reduced

    def health_check(self) -> None:
        """通过最小文本请求验证认证、能力和模型维度。"""
        self.embed_documents(["PetDock embedding health check"])

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """按条数与总字符预算分批，顺序合并向量；失败不自动重放已结算批次。"""
        return self.embed_documents_cancellable(texts, None)

    def embed_documents_cancellable(
        self, texts: list[str], should_stop: Callable[[], bool] | None,
    ) -> list[list[float]]:
        """允许索引在等待本机发送门禁或下一个批次前暂停，保留普通查询调用接口。"""
        check_embedding_pause(should_stop)
        # 先检查全部单项，避免遇到不可分割的超长文本时已有前序批次消耗额度。
        if any(not text.strip() or len(text) > MAX_BATCH_INPUT_UNITS for text in texts):
            raise ManagedEmbeddingError("embedding_provider_invalid_input")
        vectors: list[list[float]] = []
        for start, end in embedding_batch_ranges(self, texts):
            check_embedding_pause(should_stop)
            vectors.extend(self._embed(texts[start:end], should_stop))
        return vectors

    def embed_query(self, text: str) -> list[float]:
        """生成单条查询向量。"""
        return self.embed_documents([text])[0]

    def count_tokens(self, text: str) -> int:
        """使用与 Cloud 一致的保守字符计数。"""
        return max(1, len(text))

    def close(self) -> None:
        """关闭 HTTP 客户端。"""
        self._client.close()

    def _embed(self, texts: list[str], should_stop: Callable[[], bool] | None = None) -> list[list[float]]:
        """按网络批次串行发送，避免同一桌面多个库把请求同时排进服务端单并发队列。"""
        waiting_at = time.monotonic()
        while True:
            check_embedding_pause(should_stop)
            if self._request_lock.acquire(timeout=0.1):
                break
        try:
            check_embedding_pause(should_stop)
            LOGGER.info(
                "官方 Embedding 批次开始 items=%s inputUnits=%s localWaitMs=%s",
                len(texts), sum(self.count_tokens(text) for text in texts),
                round((time.monotonic() - waiting_at) * 1000),
            )
            # 等到真正发送时再取 Lease，避免在本机排队期间会话已经轮换。
            return self._embed_locked(texts, should_stop)
        finally:
            self._request_lock.release()

    def _embed_locked(self, texts: list[str], should_stop: Callable[[], bool] | None = None) -> list[list[float]]:
        """仅在 401 且已有新 Lease 时重试当前批次一次，绝不重放前序成功批次。"""
        # Cloud 校验后会剔除首尾空白，熔断阈值也按实际预占规模比较。
        input_units = sum(max(1, len(text.strip())) for text in texts)
        if self._is_quota_exhausted(input_units):
            raise ManagedEmbeddingError("managed_quota_exhausted")
        lease = self._session.lease()
        if lease is None:
            raise ManagedEmbeddingError("managed_authentication_required")
        trace_id, request_id = (str(uuid.uuid4()) for _ in range(2))
        response = self._post_batch(texts, lease, trace_id, request_id)
        if response.status_code == 401:
            # Main 定时轮换会在注入新 Lease 后撤销旧会话；并发请求可能恰好使用旧 Token。
            # 只补发明确被认证拒绝的当前请求；超时、5xx、额度拒绝不自动重试。
            refreshed = self._session.lease()
            if refreshed is not None and refreshed.access_token != lease.access_token:
                check_embedding_pause(should_stop)
                LOGGER.info("官方 Embedding 会话已轮换，恢复当前被拒批次 requestId=%s", request_id)
                response = self._post_batch(texts, refreshed, trace_id, request_id)
        if response.status_code != 200:
            error_code = (
                "managed_authentication_required" if response.status_code == 401
                else _response_error(response.content)
            )
            if error_code == "managed_quota_exhausted":
                if self._mark_quota_exhausted(input_units):
                    LOGGER.warning(
                        "官方 Embedding 本批预占额度不足，同等或更大批次降级本地 Hash；"
                        "较小请求仍可尝试 requestId=%s items=%s inputUnits=%s",
                        request_id, len(texts), input_units,
                    )
            else:
                LOGGER.warning(
                    "官方 Embedding 请求失败 requestId=%s status=%s reason=%s items=%s inputUnits=%s",
                    request_id, response.status_code, error_code, len(texts), input_units,
                )
            raise ManagedEmbeddingError(error_code)
        try:
            body = response.json()
            if body.get("descriptorId") != "embedding-standard" or body.get("revision") != self.descriptor.revision:
                raise ValueError("Embedding Descriptor 不一致")
            vectors = [[float(value) for value in row] for row in body["vectors"]]
            _validate_vectors(vectors, self.descriptor.dimensions)
            if len(vectors) != len(texts):
                raise ValueError("Embedding 数量不一致")
            return [_normalize(vector) for vector in vectors]
        except (ValueError, TypeError, KeyError, IndexError, json.JSONDecodeError) as error:
            raise ManagedEmbeddingError("embedding_provider_invalid_response") from error

    def _post_batch(
        self, texts: list[str], lease: ManagedSessionLease, trace_id: str, request_id: str,
    ) -> httpx.Response:
        """提交单次尝试；重试沿用逻辑请求标识并生成新的尝试标识。"""
        headers = {
            "Authorization": f"Bearer {lease.access_token}",
            "X-PetDock-Trace-Id": trace_id,
            "X-PetDock-Request-Id": request_id,
            "X-PetDock-Attempt-Id": str(uuid.uuid4()),
            "X-PetDock-Client-Version": self._client_version,
            # Runtime Session JWT 中的设备 Claim 才是控制面签发的有效设备标识。
            "X-PetDock-Device-Id": _device_id_from_token(lease.access_token, self._device_id),
            "Accept": "application/json",
        }
        started_at = time.monotonic()
        outcome = "transport_error"
        try:
            response = self._client.post(self._url, headers=headers, json={
                "descriptorId": "embedding-standard", "input": texts,
            })
            outcome = str(response.status_code)
            return response
        except httpx.TimeoutException as error:
            outcome = "transport_timeout"
            raise ManagedEmbeddingError("embedding_provider_timeout") from error
        except httpx.HTTPError as error:
            raise ManagedEmbeddingError("embedding_provider_unavailable") from error
        finally:
            LOGGER.info(
                "官方 Embedding 批次传输结束 requestId=%s items=%s inputUnits=%s status=%s durationMs=%s",
                request_id, len(texts), sum(self.count_tokens(text) for text in texts), outcome,
                round((time.monotonic() - started_at) * 1000),
            )


def _response_error(body: bytes) -> str:
    """将 Cloud ErrorEnvelope 映射为本地稳定错误。"""
    try:
        payload: Any = json.loads(body)
        code = payload.get("error", {}).get("code")
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
        code = None
    return {
        "authentication_required": "managed_authentication_required",
        "token_expired": "managed_authentication_required",
        "capability_not_entitled": "managed_capability_not_entitled",
        "quota_exhausted": "managed_quota_exhausted",
        "provider_timeout": "embedding_provider_timeout",
    }.get(code, "embedding_provider_unavailable")


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
