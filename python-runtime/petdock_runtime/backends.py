from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from .config import RuntimeConfig
from .protocol import AssistantRequest


class AssistantBackend(ABC):
    @abstractmethod
    async def stream(self, request: AssistantRequest) -> AsyncIterator[str]:
        raise NotImplementedError


class MockBackend(AssistantBackend):
    async def stream(self, request: AssistantRequest) -> AsyncIterator[str]:
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
        )
        self._histories: dict[str, list[BaseMessage]] = {}

    async def stream(self, request: AssistantRequest) -> AsyncIterator[str]:
        history = self._histories.setdefault(request.conversationId, [])
        messages: list[BaseMessage] = [
            SystemMessage(
                content=(
                    "你是 PetDock 桌面助手。请使用与用户相同的语言，回答清晰、直接，"
                    "不要声称执行了尚未提供的本地工具操作。"
                )
            ),
            *history[-20:],
            HumanMessage(content=request.input),
        ]
        chunks: list[str] = []

        async for chunk in self._model.astream(messages):
            text = _content_to_text(chunk.content)
            if text:
                chunks.append(text)
                yield text

        history.extend([HumanMessage(content=request.input), AIMessage(content="".join(chunks))])


def create_backend(config: RuntimeConfig) -> AssistantBackend:
    if config.resolved_backend == "langchain":
        return LangChainBackend(config)
    return MockBackend()


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
