from __future__ import annotations

import asyncio
import json
import re
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass
from uuid import uuid4

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI

from .config import RuntimeConfig
from .protocol import AssistantRequest, ToolResultRequest


@dataclass(frozen=True)
class ToolCallRequest:
    """模型规划出的工具调用，实际执行永远交给 Electron Main。"""

    id: str
    name: str
    args: dict[str, object]
    preview: str


BackendOutput = str | ToolCallRequest


class AssistantBackend(ABC):
    @abstractmethod
    async def stream(
        self, request: AssistantRequest, tool_result: ToolResultRequest | None = None
    ) -> AsyncIterator[BackendOutput]:
        raise NotImplementedError


class MockBackend(AssistantBackend):
    """离线模式支持普通聊天和用于冒烟测试的显式工具意图。"""

    async def stream(
        self, request: AssistantRequest, tool_result: ToolResultRequest | None = None
    ) -> AsyncIterator[BackendOutput]:
        if tool_result:
            if tool_result.decision == "approved" and not tool_result.error:
                response = f"工具 {tool_result.toolCallId} 已执行完成。"
            elif tool_result.decision == "cancelled":
                response = "操作已取消。"
            else:
                response = f"操作未执行：{tool_result.error or '用户拒绝了这次操作。'}"
        else:
            tool_call = _mock_tool_call(request.input)
            if tool_call:
                await asyncio.sleep(0.02)
                yield tool_call
                return
            response = f"我已经收到你的消息：{request.input}\n\n当前没有配置模型服务，因此先以离线模式回应。"

        for index in range(0, len(response), 4):
            await asyncio.sleep(0.025)
            yield response[index : index + 4]


class LangChainBackend(AssistantBackend):
    def __init__(self, config: RuntimeConfig) -> None:
        self._model = ChatOpenAI(
            api_key=config.api_key,
            base_url=config.base_url,
            model=config.model,
            temperature=0.2,
            streaming=True,
        ).bind_tools(TOOL_DEFINITIONS)
        self._histories: dict[str, list[BaseMessage]] = {}
        self._pending_tool_ids: dict[str, set[str]] = {}

    async def stream(
        self, request: AssistantRequest, tool_result: ToolResultRequest | None = None
    ) -> AsyncIterator[BackendOutput]:
        history = self._histories.setdefault(request.conversationId, [])
        pending = self._pending_tool_ids.setdefault(request.conversationId, set())

        if tool_result:
            if tool_result.toolCallId not in pending:
                raise ValueError("Unknown or already completed tool call.")
            pending.remove(tool_result.toolCallId)
            content = {
                "decision": tool_result.decision,
                "result": tool_result.result,
                "error": tool_result.error,
            }
            history.append(
                ToolMessage(
                    content=json.dumps(content, ensure_ascii=False, default=str),
                    tool_call_id=tool_result.toolCallId,
                )
            )
        else:
            if pending:
                raise ValueError("A previous tool call is still pending.")
            history.append(HumanMessage(content=request.input))

        messages: list[BaseMessage] = [
            SystemMessage(
                content=(
                    "你是 PetDock 桌面助手。请使用与用户相同的语言，回答清晰、直接。"
                    "需要打开网页、应用或文件时，使用已提供的工具，不要声称执行了尚未完成的操作。"
                )
            ),
            *history[-24:],
        ]
        chunks: list[str] = []
        tool_fragments: dict[int, dict[str, str]] = {}

        async for chunk in self._model.astream(messages):
            text = _content_to_text(chunk.content)
            if text:
                chunks.append(text)
                yield text
            for fragment in getattr(chunk, "tool_call_chunks", []) or []:
                index = int(fragment.get("index", 0))
                current = tool_fragments.setdefault(index, {"id": "", "name": "", "args": ""})
                current["id"] += str(fragment.get("id") or "")
                current["name"] += str(fragment.get("name") or "")
                current["args"] += str(fragment.get("args") or "")

        if tool_fragments:
            calls: list[dict[str, object]] = []
            pending_calls: list[ToolCallRequest] = []
            for fragment in tool_fragments.values():
                try:
                    args = json.loads(fragment["args"] or "{}")
                except json.JSONDecodeError as error:
                    raise ValueError(f"模型返回了无效的工具参数：{error}") from error
                if not isinstance(args, dict):
                    raise ValueError("模型工具参数必须是对象。")
                call_id = fragment["id"] or f"call-{uuid4().hex}"
                name = fragment["name"]
                calls.append({"id": call_id, "name": name, "args": args})
                pending.add(call_id)
                pending_calls.append(
                    ToolCallRequest(
                        id=call_id,
                        name=name,
                        args=args,
                        preview=_tool_preview(name, args),
                    )
                )
            # 必须在 yield 工具请求前写入 assistant tool_calls 消息。
            # Service 会在收到第一个请求后暂停生成器，下一轮 tool 消息才能匹配它。
            history.append(AIMessage(content="".join(chunks), tool_calls=calls))
            for pending_call in pending_calls:
                yield pending_call
            return

        self._pending_tool_ids.pop(request.conversationId, None)
        history.append(AIMessage(content="".join(chunks)))


TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "open_url",
            "description": "在系统默认浏览器中打开一个 http 或 https 网页。",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string", "description": "网页地址"}},
                "required": ["url"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_app",
                "description": "打开 PetDock 白名单中的 Windows 应用，可用 ID：notepad、explorer、calculator。",
            "parameters": {
                "type": "object",
                "properties": {"appId": {"type": "string", "description": "应用 ID"}},
                "required": ["appId"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_file_or_folder",
            "description": "使用系统默认程序打开一个已经存在的文件或文件夹。",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "文件或文件夹路径"}},
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
]


def create_backend(config: RuntimeConfig) -> AssistantBackend:
    if config.resolved_backend == "langchain":
        return LangChainBackend(config)
    return MockBackend()


def _mock_tool_call(message: str) -> ToolCallRequest | None:
    """离线模式通过明确前缀模拟模型工具调用，避免误触发普通聊天。"""
    text = message.strip()
    patterns = [
        (r"^打开(?:网页|网站)\s+(.+)$", "open_url", "url"),
        (r"^打开应用\s+(.+)$", "open_app", "appId"),
        (r"^打开(?:文件|文件夹)\s+(.+)$", "open_file_or_folder", "path"),
    ]
    for pattern, name, argument in patterns:
        matched = re.match(pattern, text, re.IGNORECASE)
        if matched:
            value = matched.group(1).strip()
            if name == "open_app":
                value = _normalize_mock_app_id(value)
            return ToolCallRequest(
                id=f"mock_{uuid4().hex}",
                name=name,
                args={argument: value},
                preview=_tool_preview(name, {argument: value}),
            )
    return None


def _normalize_mock_app_id(value: str) -> str:
    aliases = {
        "记事本": "notepad",
        "资源管理器": "explorer",
        "文件资源管理器": "explorer",
        "计算器": "calculator",
    }
    return aliases.get(value.lower(), value.lower())


def _tool_preview(name: str, args: dict[str, object]) -> str:
    if name == "open_url":
        return f"打开网页：{args.get('url', '')}"
    if name == "open_app":
        return f"打开应用：{args.get('appId', '')}"
    if name == "open_file_or_folder":
        return f"打开路径：{args.get('path', '')}"
    return f"执行工具：{name}"


def _content_to_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    return ""
