from __future__ import annotations

import base64
import binascii
import json
import logging
import uuid
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI

from ..managed.auth_refresh import ManagedAuthRefreshCoordinator
from ..managed.session import ManagedSessionStore
from ..agent.contracts import ManagedAuthRefreshRequired
from .selector import ChatSource

"""Chat 模型创建端口与 BYOK 适配器。"""

LOGGER = logging.getLogger("petdock.providers.chat")
ChatPurpose = Literal["agent", "memory"]


class AgentChatModel(Protocol):
    """主 Agent 需要的最小流式模型端口。"""

    def astream(self, input: Sequence[object]) -> AsyncIterator[Any]:
        """流式返回模型块；具体 SDK 类型只存在于适配器内部。"""


class ManagedProviderError(RuntimeError):
    """Managed 数据面稳定错误，不携带 Token、响应正文或上游细节。"""

    def __init__(self, code: str, retryable: bool = False) -> None:
        """只保存公共错误码和是否可重试标志。"""
        super().__init__(code)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class _ManagedChunk:
    """把 Cloud SSE 事件转换成现有 LangChain 后端可消费的最小块。"""

    content: str = ""
    tool_call_chunks: list[dict[str, object]] | None = None


class TextChatModel(Protocol):
    """后台分析任务需要的最小单次文本模型端口。"""

    async def ainvoke(self, input: object) -> Any:
        """执行一次非流式生成。"""


class ChatModelFactory:
    """按有效来源和用途创建 Chat 模型，不持久化任何配置。"""

    def __init__(
        self,
        source: ChatSource,
        *,
        api_key: str | None,
        base_url: str | None,
        model: str,
        managed_ai_base_url: str = "https://ai.petdock.site",
        managed_client_version: str = "0.2.0",
        managed_device_id: str = "",
        managed_session: ManagedSessionStore | None = None,
        managed_auth_refresh: ManagedAuthRefreshCoordinator | None = None,
    ) -> None:
        """保存本次 Runtime 的只读装配参数。"""
        self.source = source
        self._api_key = api_key
        self._base_url = base_url
        self._model = model
        self._managed_ai_base_url = managed_ai_base_url.rstrip("/")
        self._managed_client_version = managed_client_version
        self._managed_device_id = managed_device_id or str(uuid.uuid4())
        self._managed_session = managed_session
        self._managed_auth_refresh = managed_auth_refresh
        self._managed_model: ManagedChatModel | None = None

    @property
    def backend_name(self) -> Literal["mock", "langchain"]:
        """返回与现有 Runtime 就绪协议兼容的技术后端名称。"""
        if self.source == "mock":
            return "mock"
        if self.source == "byok":
            self._require_byok_configuration()
            return "langchain"
        if self.source == "managed":
            return "langchain"
        raise ValueError("Chat 能力已关闭，不能创建模型后端。")

    def create_agent_model(self, tools: list[dict[str, object]]) -> AgentChatModel:
        """创建主 Agent 的 BYOK 流式模型，并绑定固定工具定义。"""
        self._require_source("agent")
        LOGGER.info("创建 Chat 模型 source=%s purpose=agent", self.source)
        if self.source == "managed":
            if not self._managed_session or not self._managed_auth_refresh:
                raise ValueError("Managed Chat 会话服务未准备。")
            self._managed_model = ManagedChatModel(
                self._managed_ai_base_url,
                self._managed_client_version,
                self._managed_device_id,
                self._managed_session,
                self._managed_auth_refresh,
            )
            return self._managed_model.bind_tools(tools)
        return ChatOpenAI(
            api_key=self._api_key,
            base_url=self._base_url,
            model=self._model,
            temperature=0.2,
            streaming=True,
        ).bind_tools(tools)  # type: ignore[return-value]

    def create_text_model(self, purpose: ChatPurpose) -> TextChatModel | None:
        """创建后台文本模型；Mock 和 Managed 首版固定使用本地规则。"""
        if purpose != "memory":
            raise ValueError("未知 Chat 模型用途。")
        if self.source in {"mock", "managed", "disabled"}:
            LOGGER.info("后台 Chat 使用本地规则 source=%s purpose=%s", self.source, purpose)
            return None
        self._require_byok_configuration()
        LOGGER.info("创建 Chat 模型 source=%s purpose=%s model=%s", self.source, purpose, self._model)
        return ChatOpenAI(
            api_key=self._api_key,
            base_url=self._base_url,
            model=self._model,
            temperature=0,
            streaming=False,
        )

    async def close(self) -> None:
        """关闭 Managed HTTP 客户端，BYOK 模型无需额外资源。"""
        if self._managed_model:
            await self._managed_model.close()

    def _require_source(self, purpose: ChatPurpose) -> None:
        """拒绝 Phase 1 未启用的来源，确保不会发生隐式网络回退。"""
        if self.source == "byok":
            self._require_byok_configuration()
            return
        if self.source == "managed" and purpose == "agent":
            if not self._managed_session or not self._managed_auth_refresh:
                raise ValueError("Managed Chat 会话服务未准备。")
            return
        raise ValueError(f"Chat 来源 {self.source} 不能创建 {purpose} 模型。")

    def _require_byok_configuration(self) -> None:
        """校验 BYOK 模型构造所需的最小配置。"""
        if not self._api_key:
            raise ValueError("BYOK Chat 缺少 API Key。")
        if not self._model:
            raise ValueError("BYOK Chat 缺少模型名称。")


class ManagedChatModel:
    """调用官方 Chat SSE 的模型适配器，复用本地 Agent 工具循环。"""

    def __init__(
        self,
        base_url: str,
        client_version: str,
        device_id: str,
        session: ManagedSessionStore,
        auth_refresh: ManagedAuthRefreshCoordinator,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """保存脱敏连接配置和 Runtime 内存会话引用。"""
        self._url = f"{base_url.rstrip('/')}/ai/v1/chat/completions"
        self._client_version = client_version
        self._device_id = device_id
        self._session = session
        self._auth_refresh = auth_refresh
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(130.0, connect=10.0),
            transport=transport,
        )
        self._tools: list[dict[str, object]] | None = None
        self._task_id: str | None = None
        self._trace_ids: dict[str, str] = {}
        self._output_started: dict[str, bool] = {}

    # 绑定当前 Agent 的固定工具定义。
    def bind_tools(self, tools: list[dict[str, object]]) -> "ManagedChatModel":
        """复制工具 Schema，禁止后续调用方修改共享目录。"""
        self._tools = json.loads(json.dumps(tools, ensure_ascii=False))
        return self

    # 设置当前本地任务上下文。
    def set_request_context(self, task_id: str) -> None:
        """为一次本地任务建立稳定 traceId。"""
        self._task_id = task_id
        self._trace_ids.setdefault(task_id, str(uuid.uuid4()))
        self._output_started.setdefault(task_id, False)

    # 释放任务和 HTTP 客户端资源。
    def finish_task(self, task_id: str) -> None:
        """清理不含用户正文的任务标识状态。"""
        self._trace_ids.pop(task_id, None)
        self._output_started.pop(task_id, None)
        if self._task_id == task_id:
            self._task_id = None

    async def close(self) -> None:
        """关闭 HTTP 连接池。"""
        await self._client.aclose()

    async def astream(self, input: Sequence[object]) -> AsyncIterator[_ManagedChunk | ManagedAuthRefreshRequired]:
        """发送一次逻辑模型调用并严格消费 Cloud SSE。"""
        task_id = self._task_id
        if not task_id:
            raise ManagedProviderError("internal_error")
        trace_id = self._trace_ids.setdefault(task_id, str(uuid.uuid4()))
        self._output_started[task_id] = False
        request_id = str(uuid.uuid4())
        attempt_id = str(uuid.uuid4())
        retried_auth = False
        expected_sequence = 1
        terminal = False
        saw_usage = False
        tool_call_index = 0
        payload = {"logicalModel": "chat-standard", "messages": _serialize_messages(input), "stream": True}
        if self._tools:
            payload["tools"] = self._tools
        while True:
            lease = self._session.lease()
            if lease is None:
                raise ManagedProviderError("authentication_required")
            headers = {
                "Authorization": f"Bearer {lease.access_token}",
                "X-PetDock-Trace-Id": trace_id,
                "X-PetDock-Request-Id": request_id,
                "X-PetDock-Attempt-Id": attempt_id,
                "X-PetDock-Client-Version": self._client_version,
                "X-PetDock-Device-Id": _device_id_from_token(lease.access_token, self._device_id),
                "Accept": "text/event-stream",
            }
            try:
                async with self._client.stream("POST", self._url, headers=headers, json=payload) as response:
                    if response.status_code != 200:
                        error = await _managed_error(response)
                        if error.code == "token_expired" and not retried_auth and not self._output_started.get(task_id, False):
                            retried_auth = True
                            await self._auth_refresh.prepare(task_id, request_id)
                            yield ManagedAuthRefreshRequired(task_id, trace_id, request_id)
                            try:
                                result = await self._auth_refresh.wait_for_result(task_id, request_id, 120)
                            except TimeoutError as error:
                                raise ManagedProviderError("authentication_required") from error
                            if result.result != "refreshed":
                                error_code = result.error_code if result.error_code in {
                                    "authentication_required",
                                    "device_revoked",
                                    "capability_not_entitled",
                                    "unsupported_client_version",
                                    "provider_unavailable",
                                } else "authentication_required"
                                raise ManagedProviderError(error_code)
                            attempt_id = str(uuid.uuid4())
                            continue
                        raise error
                    async for event in _iter_sse(response.aiter_lines()):
                        if terminal:
                            raise ManagedProviderError("stream_protocol_error")
                        event_trace = event.get("traceId")
                        event_request = event.get("requestId")
                        if event_trace != trace_id or event_request != request_id:
                            raise ManagedProviderError("stream_protocol_error")
                        if event.get("eventVersion") != 1 or type(event.get("sequence")) is not int or event.get("sequence") != expected_sequence:
                            raise ManagedProviderError("stream_protocol_error")
                        expected_sequence += 1
                        event_type = event.get("type")
                        if event_type == "delta":
                            text = event.get("text")
                            if not isinstance(text, str) or not text:
                                raise ManagedProviderError("stream_protocol_error")
                            self._output_started[task_id] = True
                            yield _ManagedChunk(content=text)
                        elif event_type == "tool_call":
                            name = event.get("name")
                            arguments = event.get("arguments")
                            call_id = event.get("toolCallId")
                            if not isinstance(name, str) or not isinstance(arguments, dict) or not isinstance(call_id, str):
                                raise ManagedProviderError("stream_protocol_error")
                            self._output_started[task_id] = True
                            yield _ManagedChunk(tool_call_chunks=[{"index": tool_call_index, "id": call_id, "name": name, "args": json.dumps(arguments, ensure_ascii=False)}])
                            tool_call_index += 1
                        elif event_type == "usage":
                            if saw_usage:
                                raise ManagedProviderError("stream_protocol_error")
                            saw_usage = True
                            continue
                        elif event_type == "completed":
                            if not saw_usage:
                                raise ManagedProviderError("stream_protocol_error")
                            if event.get("finishReason") not in {"stop", "tool_calls", "cancelled"}:
                                raise ManagedProviderError("stream_protocol_error")
                            terminal = True
                        elif event_type == "error":
                            if not isinstance(event.get("code"), str) or not isinstance(event.get("retryable"), bool):
                                raise ManagedProviderError("stream_protocol_error")
                            raise ManagedProviderError(event["code"], event["retryable"])
                        else:
                            raise ManagedProviderError("stream_protocol_error")
                    if not terminal:
                        raise ManagedProviderError("stream_protocol_error")
                    # completed 表示本次逻辑请求已经闭合，不能再次进入重试循环。
                    return
            except httpx.TimeoutException as error:
                raise ManagedProviderError("provider_timeout", True) from error
            except httpx.HTTPError as error:
                raise ManagedProviderError("provider_unavailable", True) from error


def _serialize_messages(messages: Sequence[object]) -> list[dict[str, object]]:
    """将 LangChain 消息转换为 Cloud v1 严格消息结构。"""
    serialized: list[dict[str, object]] = []
    for message in messages:
        if isinstance(message, SystemMessage):
            serialized.append({"role": "system", "content": _message_text(message.content)})
        elif isinstance(message, HumanMessage):
            serialized.append({"role": "user", "content": _message_text(message.content)})
        elif isinstance(message, ToolMessage):
            serialized.append({"role": "tool", "toolCallId": message.tool_call_id, "content": _message_text(message.content)})
        elif isinstance(message, AIMessage):
            calls = []
            for call in message.tool_calls:
                calls.append({"id": str(call.get("id") or uuid.uuid4()), "name": str(call.get("name") or ""), "arguments": call.get("args") if isinstance(call.get("args"), dict) else {}})
            if calls:
                serialized.append({"role": "assistant", "content": _message_text(message.content) or None, "toolCalls": calls})
            else:
                serialized.append({"role": "assistant", "content": _message_text(message.content)})
        else:
            raise ManagedProviderError("invalid_request")
    return serialized


def _message_text(content: object) -> str:
    """把 LangChain 多段内容收敛为契约允许的纯文本。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(item.get("text", "")) if isinstance(item, dict) else str(item) for item in content)
    return str(content)


def _device_id_from_token(token: str, fallback: str) -> str:
    """从已由 Main 注入的 JWT 公共 Claims 读取辅助设备标识，不验证或记录 Token。"""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return fallback
        padding = "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + padding))
        device_id = claims.get("device_id") if isinstance(claims, dict) else None
        if isinstance(device_id, str) and len(device_id) == 36:
            uuid.UUID(device_id)
            return device_id
    except (ValueError, TypeError, binascii.Error, json.JSONDecodeError):
        return fallback
    return fallback


async def _managed_error(response: httpx.Response) -> ManagedProviderError:
    """解析错误响应时只保留稳定错误码和重试标志。"""
    try:
        await response.aread()
        payload = response.json()
        error = payload.get("error", {}) if isinstance(payload, dict) else {}
        code = error.get("code") if isinstance(error, dict) else None
        retryable = error.get("retryable") if isinstance(error, dict) else False
        if isinstance(code, str) and code:
            return ManagedProviderError(code, bool(retryable))
    except (ValueError, json.JSONDecodeError):
        pass
    return ManagedProviderError("provider_unavailable", response.status_code >= 500)


async def _iter_sse(lines: AsyncIterator[str]) -> AsyncIterator[dict[str, object]]:
    """按空行切分 SSE data 帧，不记录或拼接响应正文到日志。"""
    data_lines: list[str] = []
    async for line in lines:
        if line == "":
            if data_lines:
                yield _parse_sse_data("\n".join(data_lines))
                data_lines = []
            continue
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if data_lines:
        yield _parse_sse_data("\n".join(data_lines))


def _parse_sse_data(data: str) -> dict[str, object]:
    """解析单个 SSE JSON 数据帧，非法帧按稳定协议错误处理。"""
    try:
        value = json.loads(data)
    except json.JSONDecodeError as error:
        raise ManagedProviderError("stream_protocol_error") from error
    if not isinstance(value, dict):
        raise ManagedProviderError("stream_protocol_error")
    return value
