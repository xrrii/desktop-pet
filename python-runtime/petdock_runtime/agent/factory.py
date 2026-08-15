from __future__ import annotations

import logging

from ..artifacts.store import ArtifactStore
from ..attachments.analysis import AttachmentAnalysisService
from ..attachments.store import AttachmentStore
from ..knowledge.service import KnowledgeService
from ..memory.store import MemoryStore
from ..providers.chat import ChatModelFactory
from ..skills.registry import SkillRegistry
from .contracts import AssistantBackend
from .langchain_backend import LangChainBackend
from .mock_backend import MockBackend
from .tool_catalog import TOOL_DEFINITIONS

"""根据运行配置选择具体的模型后端适配器。"""

LOGGER = logging.getLogger("petdock.agent.factory")


def create_backend(
    chat_models: ChatModelFactory,
    store: MemoryStore,
    knowledge: KnowledgeService,
    skills: SkillRegistry,
    attachments: AttachmentStore,
    artifacts: ArtifactStore,
    attachment_analysis: AttachmentAnalysisService,
) -> AssistantBackend:
    """创建在线 LangChain 或离线 Mock 后端，并记录最终选择。"""
    backend_name = chat_models.backend_name
    LOGGER.info("创建 Agent 后端 backend=%s source=%s", backend_name, chat_models.source)
    if backend_name == "langchain":
        return LangChainBackend(
            chat_models.create_agent_model(TOOL_DEFINITIONS),
            store,
            knowledge,
            skills,
            attachments,
            artifacts,
            attachment_analysis,
        )
    return MockBackend(
        store,
        knowledge,
        skills,
        attachments,
        artifacts,
        attachment_analysis,
    )
