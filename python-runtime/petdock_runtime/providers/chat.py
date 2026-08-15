from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Sequence
from typing import Any, Literal, Protocol

from langchain_openai import ChatOpenAI

from .selector import ChatSource

"""Chat 模型创建端口与 BYOK 适配器。"""

LOGGER = logging.getLogger("petdock.providers.chat")
ChatPurpose = Literal["agent", "memory"]


class AgentChatModel(Protocol):
    """主 Agent 需要的最小流式模型端口。"""

    def astream(self, input: Sequence[object]) -> AsyncIterator[Any]:
        """流式返回模型块；具体 SDK 类型只存在于适配器内部。"""


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
    ) -> None:
        """保存本次 Runtime 的只读装配参数。"""
        self.source = source
        self._api_key = api_key
        self._base_url = base_url
        self._model = model

    @property
    def backend_name(self) -> Literal["mock", "langchain"]:
        """返回与现有 Runtime 就绪协议兼容的技术后端名称。"""
        if self.source == "mock":
            return "mock"
        if self.source == "byok":
            self._require_byok_configuration()
            return "langchain"
        if self.source == "managed":
            raise ValueError("Phase 1 尚未启用 Managed Chat 网络适配器。")
        raise ValueError("Chat 能力已关闭，不能创建模型后端。")

    def create_agent_model(self, tools: list[dict[str, object]]) -> AgentChatModel:
        """创建主 Agent 的 BYOK 流式模型，并绑定固定工具定义。"""
        self._require_source("agent")
        LOGGER.info("创建 Chat 模型 source=%s purpose=agent model=%s", self.source, self._model)
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

    def _require_source(self, purpose: ChatPurpose) -> None:
        """拒绝 Phase 1 未启用的来源，确保不会发生隐式网络回退。"""
        if self.source != "byok":
            raise ValueError(f"Chat 来源 {self.source} 不能创建 {purpose} 模型。")
        self._require_byok_configuration()

    def _require_byok_configuration(self) -> None:
        """校验 BYOK 模型构造所需的最小配置。"""
        if not self._api_key:
            raise ValueError("BYOK Chat 缺少 API Key。")
        if not self._model:
            raise ValueError("BYOK Chat 缺少模型名称。")
