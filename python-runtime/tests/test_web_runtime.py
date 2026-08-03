from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

from petdock_runtime.backends import LangChainBackend
from petdock_runtime.config import RuntimeConfig
from petdock_runtime.embeddings import LocalHashEmbedding
from petdock_runtime.knowledge import ChromaVectorStore, KnowledgeService
from petdock_runtime.knowledge_store import KnowledgeStore
from petdock_runtime.memory_store import MemoryStore
from petdock_runtime.protocol import AssistantRequest, ToolResultRequest
from petdock_runtime.service import AssistantService
from petdock_runtime.skill_registry import SkillRegistry
from petdock_runtime.skill_store import SkillStore


TOKEN = "t" * 64


def test_web_provider_protocol_accepts_supported_providers() -> None:
    """Main 与 Runtime 必须同时接受默认火山 Provider 和兼容 Brave Provider。"""
    for provider in ("volcengine", "brave"):
        request = AssistantRequest(
            protocolVersion=1,
            taskId=f"provider-{provider}",
            conversationId="provider-conversation",
            input="测试联网 Provider",
            source="assistant-window",
            context={
                "activePetId": "pet",
                "locale": "zh-CN",
                "timezone": "Asia/Shanghai",
                "webSearchEnabled": True,
                "webSearchProvider": provider,
            },
        )
        assert request.context.webSearchProvider == provider


def test_web_tool_loop_emits_only_referenced_sources_without_persisting_page_body(
    tmp_path: Path,
) -> None:
    """完整网页正文只参与当前任务，历史消息仅保留最终实际引用的短来源。"""
    memory = MemoryStore(str(tmp_path / "memory.db"))
    knowledge = KnowledgeService(
        KnowledgeStore(str(tmp_path / "knowledge.db")),
        ChromaVectorStore(str(tmp_path / "chroma"), LocalHashEmbedding()),
    )
    skills = SkillRegistry(
        str(tmp_path / "skills" / "packages"),
        SkillStore(str(tmp_path / "skills.db")),
    )
    backend = LangChainBackend(
        RuntimeConfig(
            token=TOKEN,
            resolved_backend="langchain",
            api_key="test-key",
            base_url="http://127.0.0.1:1/v1",
            model="fake-model",
        ),
        memory,
        knowledge,
        skills,
    )

    class FakeModel:
        """在同一响应请求搜索和网页读取，再返回带单一引用的回答。"""

        def __init__(self) -> None:
            self.messages: list[list[object]] = []

        async def astream(self, messages):
            self.messages.append(list(messages))
            round_index = len(self.messages)
            if round_index == 1:
                yield SimpleNamespace(
                    content="",
                    tool_call_chunks=[
                        {
                            "index": 0,
                            "id": "call-search",
                            "name": "search_web",
                            "args": '{"query":"PetDock C3","maxResults":2}',
                        },
                        {
                            "index": 1,
                            "id": "call-fetch",
                            "name": "fetch_web_page",
                            "args": '{"url":"https://example.com/one"}',
                        },
                    ],
                )
            else:
                yield SimpleNamespace(
                    content="结论来自已读取页面。[网页1]",
                    tool_call_chunks=[],
                )

    fake_model = FakeModel()
    backend._model = fake_model  # type: ignore[assignment]  # 测试替换真实网络模型。
    request = AssistantRequest(
        protocolVersion=1,
        taskId="web-task",
        conversationId="web-conversation",
        input="搜索 PetDock C3 的资料",
        source="assistant-window",
        context={
            "activePetId": "pet",
            "locale": "zh-CN",
            "timezone": "Asia/Shanghai",
            "webSearchEnabled": True,
            "webSearchProvider": "volcengine",
        },
    )
    secret_body = "只允许存在于当前任务中的完整网页正文"

    async def scenario() -> list[dict[str, object]]:
        service = AssistantService(backend)
        service.start(request)
        events: list[dict[str, object]] = []
        async for event in service.events(request.taskId):
            events.append(event)
            if event["type"] != "tool_call":
                continue
            call = event["payload"]
            if call["name"] == "search_web":
                result = {
                    "type": "search_web",
                    "results": [
                        _source(1, "页面一", "https://example.com/one"),
                        _source(2, "页面二", "https://example.org/two"),
                    ],
                }
            else:
                result = {
                    "type": "fetch_web_page",
                    "source": {
                        **_source(1, "页面一正文", "https://example.com/one"),
                        "kind": "fetched-page",
                    },
                    "content": secret_body,
                }
            assert service.submit_tool_result(
                ToolResultRequest(
                    protocolVersion=1,
                    taskId=request.taskId,
                    toolCallId=call["id"],
                    decision="approved",
                    result=result,
                )
            )
        return events

    events = asyncio.run(scenario())
    tool_events = [event for event in events if event["type"] == "tool_call"]
    assert [event["payload"]["name"] for event in tool_events] == [
        "search_web",
        "fetch_web_page",
    ]
    assert len(fake_model.messages) == 2
    web_events = [event for event in events if event["type"] == "web_sources"]
    assert len(web_events) == 1
    assert [source["citationIndex"] for source in web_events[0]["payload"]["sources"]] == [1]
    assert web_events[0]["payload"]["sources"][0]["kind"] == "fetched-page"
    assert secret_body in "\n".join(str(message.content) for message in fake_model.messages[-1])

    stored = memory.load_messages(request.conversationId)
    assert secret_body not in str(stored)
    history = memory.conversation_messages(request.conversationId)
    assert history[-1]["webSources"][0]["citationIndex"] == 1
    assert "content" not in history[-1]["webSources"][0]

    asyncio.run(knowledge.close())
    memory.close()
    skills.close()


def _source(index: int, title: str, url: str) -> dict[str, object]:
    """生成符合 Main 工具结果协议的测试来源。"""
    domain = "example.com" if index == 1 else "example.org"
    return {
        "id": f"web-{index}",
        "citationIndex": index,
        "title": title,
        "url": url,
        "domain": domain,
        "excerpt": f"{title}的搜索摘要",
        "kind": "search-summary",
        "publishedAt": None,
    }
