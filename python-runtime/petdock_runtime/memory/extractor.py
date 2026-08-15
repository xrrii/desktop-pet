from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from ..protocol import AssistantRequest
from ..providers.chat import ChatModelFactory, TextChatModel
from .store import MemoryStore

"""异步长期记忆候选分析器。

分析器只产生待确认候选，不直接把模型输出当作正式记忆。
"""


class MemoryExtractor:
    """在主任务结束后异步分析对话，只写入待确认候选。"""

    def __init__(self, store: MemoryStore, model: TextChatModel | None = None) -> None:
        """绑定 SQLite 存储和可选的在线分析模型。"""
        self._store = store
        self._model = model
        self._tasks: set[asyncio.Task[None]] = set()

    def schedule(self, request: AssistantRequest, assistant_text: str) -> None:
        """在后台调度分析任务，不阻塞主代理的事件流。"""
        task = asyncio.create_task(self._run(request, assistant_text))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run(self, request: AssistantRequest, assistant_text: str) -> None:
        """分析本轮对话并把合规结果写成待确认候选。"""
        if self._model is None:
            candidate = self._fallback_candidate(request.input)
            if candidate:
                self._store.add_candidate(request.conversationId, candidate, 0.86, "明确表达了记忆意图")
            return

        prompt = (
            "你是 PetDock 的后台记忆分析器。只分析用户是否表达了值得长期保存的稳定偏好。"
            "不要保存密码、账号、身份号码、财务、健康、位置或其他敏感信息。"
            "只输出 JSON 数组，不要 Markdown。每项字段为 content、confidence、reason、sensitivity。"
            "没有合适内容时输出空数组。confidence 必须是 0 到 1 的数字。\n\n"
            f"用户消息：{request.input}\n"
            f"助手回复：{assistant_text[:4_000]}"
        )
        try:
            response = await self._model.ainvoke(prompt)
            content = _content_to_text(getattr(response, "content", ""))
            for item in _parse_candidates(content):
                self._store.add_candidate(
                    request.conversationId,
                    item["content"],
                    item["confidence"],
                    item["reason"],
                    item["sensitivity"],
                )
        except Exception:
            # 后台分析失败不能影响已经完成的主任务。
            return


def create_memory_extractor(chat_models: ChatModelFactory, store: MemoryStore) -> MemoryExtractor:
    """通过统一 Factory 创建后台模型；不可用来源固定使用本地规则。"""
    return MemoryExtractor(store, chat_models.create_text_model("memory"))


def _fallback_candidate(text: str) -> str | None:
    """离线模式仅保留明确记忆表达，避免用规则替代在线分析器。"""
    patterns = (
        r"^(?:请)?记住(?:我)?(?:喜欢|偏好|习惯|称呼我为|叫我)\s*(.+)$",
        r"^以后(?:请|都)?(?:用|使用)\s*(.+)$",
    )
    for pattern in patterns:
        match = re.match(pattern, text.strip(), re.IGNORECASE)
        if match:
            value = match.group(1).strip()
            return value[:500] or None
    return None


def _parse_candidates(content: str) -> list[dict[str, Any]]:
    """解析模型返回的 JSON 数组，并丢弃格式不合法的候选项。"""
    text = content.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, list):
        return []
    result: list[dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict) or not isinstance(item.get("content"), str):
            continue
        try:
            confidence = float(item.get("confidence", 0))
        except (TypeError, ValueError):
            continue
        result.append(
            {
                "content": item["content"],
                "confidence": confidence,
                "reason": str(item.get("reason", "")),
                "sensitivity": str(item.get("sensitivity", "normal")),
            }
        )
    return result


def _content_to_text(content: object) -> str:
    """把模型可能返回的字符串或内容块列表转换为纯文本。"""
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
