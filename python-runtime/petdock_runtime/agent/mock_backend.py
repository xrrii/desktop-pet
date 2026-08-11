from __future__ import annotations

import asyncio
import re
import time
from collections.abc import AsyncIterator
from uuid import uuid4

from ..artifacts.store import ArtifactStore
from ..attachments.analysis import AttachmentAnalysisService
from ..attachments.models import AttachmentDatasetContext
from ..attachments.store import AttachmentStore
from ..knowledge.service import KnowledgeService
from ..memory.store import MemoryStore
from ..protocol import AssistantRequest, ToolResultRequest
from ..skills.manifest import SkillManifestError
from ..skills.registry import SkillRegistry
from .context import (
    ActiveSkillRun,
    artifact_metadata,
    attachment_metadata,
    bind_attachments,
    build_attachment_context,
    retrieve_sources,
    tool_preview,
)
from .contracts import (
    AssistantBackend,
    ArtifactCreatedEvent,
    AttachmentContext,
    BackendOutput,
    RetrievalContext,
    SkillLifecycleEvent,
    ToolCallRequest,
)

"""不依赖在线模型的离线后端，用于降级和端到端测试。"""


class MockBackend(AssistantBackend):
    """离线模式支持普通聊天和用于冒烟测试的显式工具意图。"""

    def __init__(
        self,
        store: MemoryStore | None = None,
        knowledge: KnowledgeService | None = None,
        skills: SkillRegistry | None = None,
        attachments: AttachmentStore | None = None,
        artifacts: ArtifactStore | None = None,
        attachment_analysis: AttachmentAnalysisService | None = None,
    ) -> None:
        """初始化离线后端；未传存储时使用进程内临时数据库。"""
        self._store = store or MemoryStore(":memory:")
        self._knowledge = knowledge
        self._skills = skills
        self._attachments = attachments
        self._artifacts = artifacts
        self._attachment_analysis = attachment_analysis

    async def stream(
        self, request: AssistantRequest, tool_result: ToolResultRequest | None = None
    ) -> AsyncIterator[BackendOutput]:
        """按固定片段模拟流式回复，并支持冒烟测试用的工具意图。"""
        skill_run: ActiveSkillRun | None = None
        attachment_dataset = AttachmentDatasetContext("none", "", [], 0, 0)
        if tool_result:
            if tool_result.decision == "approved" and not tool_result.error:
                response = f"工具 {tool_result.toolCallId} 已执行完成。"
            elif tool_result.decision == "cancelled":
                response = "操作已取消。"
            else:
                response = f"操作未执行：{tool_result.error or '用户拒绝了这次操作。'}"
            self._store.append_message(
                request.conversationId,
                "tool",
                response,
                {"toolCallId": tool_result.toolCallId},
            )
        else:
            attachment_records = bind_attachments(self._attachments, request)
            self._store.append_message(
                request.conversationId,
                "user",
                request.input,
                attachment_metadata(attachment_records),
            )
            attachment_dataset = await build_attachment_context(self._attachment_analysis, request)
            if attachment_dataset.total_attachments:
                yield AttachmentContext(attachment_dataset)
            if request.skillInvocation and self._skills:
                try:
                    activation = self._skills.activate(request.skillInvocation.skillId)
                    run_id = self._skills.begin_run(
                        request.taskId,
                        request.conversationId,
                        activation.metadata.id,
                        "explicit-menu",
                    )
                    skill_run = ActiveSkillRun(activation, run_id, "explicit-menu", time.monotonic())
                    yield SkillLifecycleEvent(
                        "skill_started",
                        {
                            "skillId": activation.metadata.id,
                            "name": activation.metadata.name,
                            "trigger": "explicit-menu",
                        },
                    )
                except SkillManifestError as error:
                    yield SkillLifecycleEvent(
                        "skill_error",
                        {
                            "skillId": request.skillInvocation.skillId,
                            "code": error.code,
                            "message": str(error),
                        },
                    )
                    response = f"Skill 无法使用：{error}"
                    self._store.append_message(request.conversationId, "assistant", response)
                    yield response
                    return
            artifact_spec = _mock_artifact_spec(request.input)
            if artifact_spec and self._artifacts:
                artifact = self._artifacts.create(
                    request.conversationId,
                    request.taskId,
                    request.taskId,
                    artifact_spec[0],
                    artifact_spec[1],
                    artifact_spec[2],
                )
                yield ArtifactCreatedEvent(artifact)
                response = (
                    f"已生成文件：{artifact.name}。"
                    if artifact.status == "ready"
                    else f"文件生成失败：{artifact.error or 'artifact_write_failed'}。"
                )
            else:
                tool_call = _mock_tool_call(request.input)
                if tool_call:
                    self._store.append_message(
                        request.conversationId,
                        "assistant",
                        "",
                        {"toolCalls": [{"id": tool_call.id, "name": tool_call.name, "args": tool_call.args}]},
                    )
                    await asyncio.sleep(0.02)
                    yield tool_call
                    return
                skill_allows_knowledge = (
                    not skill_run or "knowledge.read" in skill_run.activation.metadata.permissions
                )
                sources = await retrieve_sources(
                    self._knowledge if skill_allows_knowledge else None,
                    request,
                    tool_result,
                )
                if attachment_dataset.total_attachments:
                    file_names = "、".join(str(source["name"]) for source in attachment_dataset.sources)
                    excerpts = "\n\n".join(
                        f"[{source['name']}] {source['excerpt']}"
                        for source in attachment_dataset.sources
                    )
                    if attachment_dataset.sources:
                        response = f"离线模式已准备会话附件：{file_names}。\n\n{excerpts}"
                    else:
                        response = "离线模式未从会话附件中找到与当前问题相关的片段。"
                    if request.input:
                        response += f"\n\n你的问题是：{request.input}"
                elif sources:
                    yield RetrievalContext(sources)
                    excerpts = "\n\n".join(
                        f"[{index}] {source.title}：{source.content[:360]}"
                        for index, source in enumerate(sources, start=1)
                    )
                    response = f"离线模式已从知识库找到以下相关内容：\n\n{excerpts}"
                else:
                    prefix = (
                        f"已按 Skill“{skill_run.activation.metadata.name}”接收任务。\n\n"
                        if skill_run
                        else ""
                    )
                    response = (
                        f"{prefix}我已经收到你的消息：{request.input}"
                        "\n\n当前没有配置模型服务，因此先以离线模式回应。"
                    )

        artifact_summary = artifact_metadata(
            self._artifacts.task_artifacts(request.taskId) if self._artifacts else []
        )
        self._store.append_message(request.conversationId, "assistant", response, artifact_summary)
        for index in range(0, len(response), 4):
            await asyncio.sleep(0.025)
            yield response[index : index + 4]
        if skill_run and self._skills:
            duration = int((time.monotonic() - skill_run.started_at) * 1000)
            self._skills.finish_run(skill_run.run_id, "completed", duration)
            yield SkillLifecycleEvent(
                "skill_completed",
                {
                    "skillId": skill_run.activation.metadata.id,
                    "name": skill_run.activation.metadata.name,
                    "durationMs": duration,
                },
            )


def _mock_artifact_spec(message: str) -> tuple[str, str, str] | None:
    """解析 E2E 使用的离线生成语法，保证 Mock 能验证完整 Artifact 链路。"""
    match = re.search(
        r"生成文件\s*\|\s*文件名=(?P<name>[^|]+)\|\s*格式=(?P<format>[^|]+)\|\s*内容=(?P<content>[\s\S]+)",
        message,
    )
    if not match:
        return None
    return (
        match.group("name").strip(),
        match.group("format").strip(),
        match.group("content"),
    )


def _mock_tool_call(message: str) -> ToolCallRequest | None:
    """通过明确前缀模拟模型工具调用，避免普通聊天误触发。"""
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
                preview=tool_preview(name, {argument: value}),
            )
    return None


def _normalize_mock_app_id(value: str) -> str:
    """把中文应用别名归一化为策略层使用的固定应用 ID。"""
    aliases = {
        "记事本": "notepad",
        "资源管理器": "explorer",
        "文件资源管理器": "explorer",
        "计算器": "calculator",
    }
    return aliases.get(value.lower(), value.lower())
