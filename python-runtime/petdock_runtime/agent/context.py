from __future__ import annotations

import logging
from dataclasses import dataclass
from urllib.parse import urlparse

from ..artifacts.store import ArtifactRecord
from ..attachments.analysis import AttachmentAnalysisService
from ..attachments.models import AttachmentDatasetContext
from ..attachments.store import AttachmentRecord, AttachmentStore
from ..knowledge.service import KnowledgeService, RetrievalSource
from ..protocol import AssistantRequest, ToolResultRequest
from ..rag.planner import plan_retrieval
from ..skills.manifest import SkillActivation

"""模型后端共用的任务上下文组装与展示辅助逻辑。"""

LOGGER = logging.getLogger("petdock.agent.context")


@dataclass
class ActiveSkillRun:
    """保存跨外部 ToolCall 延续的 Skill 任务状态。"""

    activation: SkillActivation
    run_id: int
    trigger: str
    started_at: float


def artifact_metadata(records: list[ArtifactRecord]) -> dict[str, object]:
    """构造助手历史消息中的脱敏 Artifact 摘要。"""
    return {"artifacts": [record.summary() for record in records]} if records else {}


async def retrieve_sources(
    knowledge: KnowledgeService | None,
    request: AssistantRequest,
    tool_result: ToolResultRequest | None,
) -> list[RetrievalSource]:
    """统一执行检索路由，只把最终准入来源交给聊天后端。"""
    plan = plan_retrieval(
        request.input,
        request.knowledgeLibraryIds,
        has_tool_result=tool_result is not None,
    )
    LOGGER.info(
        "RAG 路由 route=%s reason=%s confidence=%.2f libraries=%s",
        plan.route,
        plan.reason,
        plan.confidence,
        len(plan.library_ids),
    )
    if knowledge is None or plan.route not in {"RETRIEVE", "BOTH"}:
        return []
    result = await knowledge.search_with_trace(plan.retrieval_query, list(plan.library_ids))
    return result.sources


def bind_attachments(
    attachments: AttachmentStore | None,
    request: AssistantRequest,
) -> list[AttachmentRecord]:
    """绑定本轮附件；无附件存储的独立单测后端仍可正常运行。"""
    if not request.attachmentIds:
        return []
    if attachments is None:
        raise ValueError("附件存储不可用。")
    return attachments.bind_for_request(request.attachmentIds, request.conversationId)


async def build_attachment_context(
    analysis: AttachmentAnalysisService | None,
    request: AssistantRequest,
) -> AttachmentDatasetContext:
    """构造会话级附件资料上下文，不向模型暴露受控文件路径。"""
    if analysis is None:
        return AttachmentDatasetContext("none", "", [], 0, 0)
    return await analysis.build_context(request.conversationId, request.input)


def attachment_metadata(records: list[AttachmentRecord]) -> dict[str, object] | None:
    """生成写入消息 metadata 的附件引用。"""
    if not records:
        return None
    return {"attachments": [record.message_ref() for record in records]}


def tool_preview(name: str, args: dict[str, object]) -> str:
    """生成工具展示摘要，权限判断仍由 Electron Main 负责。"""
    if name == "open_url":
        return f"打开网页：{args.get('url', '')}"
    if name == "open_app":
        return f"打开应用：{args.get('appId', '')}"
    if name == "open_file_or_folder":
        return f"打开路径：{args.get('path', '')}"
    if name == "search_web":
        return f"联网搜索：{args.get('query', '')}"
    if name == "fetch_web_page":
        value = str(args.get("url", ""))
        return f"读取网页：{urlparse(value).hostname or '未知域名'}"
    if name == "remember_preference":
        return f"记住偏好：{args.get('content', '')}"
    if name == "forget_memory":
        return f"删除记忆：{args.get('memoryId', '')}"
    if name == "list_memories":
        return "查看长期偏好"
    return f"执行工具：{name}"
