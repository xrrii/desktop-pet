from __future__ import annotations

import logging

from ..artifacts.store import ArtifactStore
from ..attachments.analysis import AttachmentAnalysisService
from ..attachments.store import AttachmentStore
from ..config import RuntimeConfig
from ..knowledge.service import KnowledgeService
from ..memory.store import MemoryStore
from ..skills.registry import SkillRegistry
from .contracts import AssistantBackend
from .langchain_backend import LangChainBackend
from .mock_backend import MockBackend

"""根据运行配置选择具体的模型后端适配器。"""

LOGGER = logging.getLogger("petdock.agent.factory")


def create_backend(
    config: RuntimeConfig,
    store: MemoryStore,
    knowledge: KnowledgeService,
    skills: SkillRegistry,
    attachments: AttachmentStore,
    artifacts: ArtifactStore,
    attachment_analysis: AttachmentAnalysisService,
) -> AssistantBackend:
    """创建在线 LangChain 或离线 Mock 后端，并记录最终选择。"""
    backend_name = config.resolved_backend
    LOGGER.info("创建 Agent 后端 backend=%s", backend_name)
    if backend_name == "langchain":
        return LangChainBackend(
            config,
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
