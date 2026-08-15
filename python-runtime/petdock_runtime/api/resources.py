from __future__ import annotations

import logging
from dataclasses import dataclass

from ..agent.factory import create_backend
from ..agent.service import AssistantService
from ..artifacts.store import ArtifactStore
from ..attachments.analysis import AttachmentAnalysisService
from ..attachments.index_store import AttachmentIndexStore
from ..attachments.store import AttachmentStore
from ..config import RuntimeConfig
from ..documents.parser import DocumentParserRegistry
from ..knowledge.service import KnowledgeService
from ..knowledge.store import KnowledgeStore
from ..memory.extractor import create_memory_extractor
from ..memory.store import MemoryStore
from ..protocol import AssistantRequest
from ..providers.chat import ChatModelFactory
from ..providers.embeddings import EmbeddingProvider, LocalHashEmbedding, create_embedding_provider
from ..rag.vector_store import ChromaVectorStore
from ..skills.installer import SkillInstaller
from ..skills.registry import SkillRegistry
from ..skills.store import SkillStore
from ..vision.analyzer import VisionAnalyzer, VisionConfiguration, VisionRequestError

"""Runtime 服务资源的创建、依赖装配和关闭顺序。"""

LOGGER = logging.getLogger("petdock.api.resources")


@dataclass
class RuntimeResources:
    """集中持有 API 路由使用的长生命周期服务。"""

    memory: MemoryStore
    attachments: AttachmentStore
    vision: VisionAnalyzer
    artifacts: ArtifactStore
    knowledge_store: KnowledgeStore
    embedding: EmbeddingProvider
    attachment_index: AttachmentIndexStore
    knowledge: KnowledgeService
    skills: SkillRegistry
    skill_installer: SkillInstaller
    assistant: AssistantService

    async def close(self) -> None:
        """按依赖顺序关闭后台任务、索引和数据库连接。"""
        LOGGER.info("开始关闭 Runtime 服务资源")
        await self.knowledge.close()
        self.vision.close()
        self.skills.close()
        self.attachments.cleanup_drafts()
        self.attachment_index.close()
        self.attachments.close()
        self.artifacts.close()
        self.memory.close()
        LOGGER.info("Runtime 服务资源已关闭")


def create_runtime_resources(config: RuntimeConfig) -> RuntimeResources:
    """创建 Runtime 领域服务，并在此处完成唯一一次依赖装配。"""
    memory = MemoryStore(config.memory_db_path)
    parser_registry = DocumentParserRegistry()
    attachments = AttachmentStore(config.memory_db_path, config.attachment_root, parser_registry)
    vision = VisionAnalyzer(
        VisionConfiguration(
            config.vision_base_url,
            config.vision_api_key,
            config.vision_model,
            config.vision_source,
        ),
        config.memory_db_path,
    )
    artifacts = ArtifactStore(config.memory_db_path, config.artifact_root)
    knowledge_store = KnowledgeStore(config.knowledge_db_path)
    embedding = create_embedding_provider(config)
    attachment_index = AttachmentIndexStore(config.attachment_index_root, embedding)
    attachment_index.reconcile(attachments.conversation_ids())
    attachment_analysis = AttachmentAnalysisService(attachments, attachment_index, embedding)
    fallback_vectors = (
        ChromaVectorStore(config.chroma_path, LocalHashEmbedding())
        if embedding.descriptor.id != LocalHashEmbedding.name
        else None
    )
    knowledge = KnowledgeService(
        knowledge_store,
        ChromaVectorStore(config.chroma_path, embedding),
        fallback_vectors,
        parser_registry,
    )
    skill_store = SkillStore(config.skills_db_path)
    skills = SkillRegistry(config.skills_root, skill_store)
    skill_installer = SkillInstaller(config.skills_root, skills)
    chat_models = ChatModelFactory(
        config.chat_source or ("byok" if config.resolved_backend == "langchain" else "mock"),
        api_key=config.api_key,
        base_url=config.base_url,
        model=config.model,
    )

    async def prepare_attachments(request: AssistantRequest) -> None:
        """发送任务开始后生成图片视觉摘要，登记阶段不调用外部视觉端点。"""
        records = attachments.validate_for_request(request.attachmentIds, request.conversationId)
        for record in records:
            if record.parser_id != "image-metadata-v1":
                continue
            if vision.status != "supported":
                raise VisionRequestError(vision.status, _vision_status_code(vision.status))
            source, derived = attachments.vision_source(record.id)
            summary = await vision.analyze(f"{request.taskId}:{record.id}", source, derived)
            attachments.apply_vision_summary(record.id, summary.as_dict())

    assistant = AssistantService(
        create_backend(
            chat_models,
            memory,
            knowledge,
            skills,
            attachments,
            artifacts,
            attachment_analysis,
        ),
        create_memory_extractor(chat_models, memory),
        prepare_attachments,
    )
    LOGGER.info(
        "Runtime 服务资源已创建 backend=%s embedding=%s",
        config.resolved_backend,
        embedding.descriptor.id,
    )
    return RuntimeResources(
        memory=memory,
        attachments=attachments,
        vision=vision,
        artifacts=artifacts,
        knowledge_store=knowledge_store,
        embedding=embedding,
        attachment_index=attachment_index,
        knowledge=knowledge,
        skills=skills,
        skill_installer=skill_installer,
        assistant=assistant,
    )


def _vision_status_code(status: str) -> str:
    """把发送阶段的视觉状态转换为稳定错误码。"""
    return {
        "unconfigured": "vision_not_configured",
        "untested": "vision_capability_untested",
        "unsupported": "vision_model_unsupported",
        "unavailable": "vision_provider_unavailable",
        "invalid-credentials": "vision_invalid_credentials",
    }.get(status, "vision_summary_failed")
