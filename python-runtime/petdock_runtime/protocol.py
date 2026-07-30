from __future__ import annotations

from typing import Any, Literal
import re

from pydantic import BaseModel, ConfigDict, Field, model_validator

"""PetDock Assistant Runtime 的 HTTP 协议模型。

所有请求模型都禁止未知字段，避免 Renderer 或外部调用方悄悄扩展权限边界。
"""


class AssistantContext(BaseModel):
    """描述本次对话所处的桌宠、语言和时区上下文。"""
    model_config = ConfigDict(extra="forbid")

    activePetId: str = Field(min_length=1, max_length=128)
    locale: str = Field(min_length=1, max_length=64)
    timezone: str = Field(min_length=1, max_length=128)


class AssistantSkillInvocation(BaseModel):
    """描述用户通过 `$` 菜单显式选择的 Skill。"""

    model_config = ConfigDict(extra="forbid")

    skillId: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")


class AssistantRequest(BaseModel):
    """创建一个新的助手任务请求。"""
    model_config = ConfigDict(extra="forbid")

    protocolVersion: Literal[1]
    taskId: str = Field(min_length=1, max_length=128)
    conversationId: str = Field(min_length=1, max_length=128)
    input: str = Field(max_length=12_000)
    source: Literal["pet", "assistant-window", "shortcut"]
    context: AssistantContext
    knowledgeLibraryIds: list[str] = Field(default_factory=list, max_length=20)
    attachmentIds: list[str] = Field(default_factory=list, max_length=10)
    skillInvocation: AssistantSkillInvocation | None = None

    @model_validator(mode="after")
    def validate_input_and_attachments(self) -> "AssistantRequest":
        """要求文本或附件至少存在一项，并校验附件 ID 去重与格式。"""
        if not self.input.strip() and not self.attachmentIds:
            raise ValueError("消息和附件不能同时为空。")
        if len(set(self.attachmentIds)) != len(self.attachmentIds):
            raise ValueError("附件 ID 不能重复。")
        if any(not re.fullmatch(r"[a-f0-9]{32}", item) for item in self.attachmentIds):
            raise ValueError("附件 ID 无效。")
        return self


class AttachmentRegistrationItem(BaseModel):
    """描述 Main 已复制到受控目录的单个附件。"""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(min_length=1, max_length=255)
    relativePath: str = Field(min_length=1, max_length=1_024)
    sizeBytes: int = Field(ge=1, le=10 * 1024 * 1024)


class AttachmentRegisterRequest(BaseModel):
    """批量登记用户本轮明确投放的受控附件。"""

    model_config = ConfigDict(extra="forbid")

    attachments: list[AttachmentRegistrationItem] = Field(min_length=1, max_length=10)


class AttachmentPreviewRequest(BaseModel):
    """请求读取草稿或指定会话附件的一段已解析文本。"""

    model_config = ConfigDict(extra="forbid")

    conversationId: str | None = Field(default=None, min_length=1, max_length=128)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=65_536, ge=1, le=100_000)


class KnowledgeLibraryCreateRequest(BaseModel):
    """创建一个由 Electron 原生目录选择器明确授权的知识库。"""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    path: str = Field(min_length=1, max_length=2_048)


class ToolResultRequest(BaseModel):
    """Electron Main 回传的工具执行结果。"""

    model_config = ConfigDict(extra="forbid")

    protocolVersion: Literal[1]
    taskId: str = Field(min_length=1, max_length=128)
    toolCallId: str = Field(min_length=1, max_length=128)
    decision: Literal["approved", "denied", "cancelled"]
    result: Any | None = None
    error: str | None = Field(default=None, max_length=4_000)


class MemoryItemRequest(BaseModel):
    """删除单条记忆或索引记录。"""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["conversation", "memory", "app", "directory"]
    id: str = Field(min_length=1, max_length=512)


class MemoryClearRequest(BaseModel):
    """按范围清理本地助手数据。"""

    model_config = ConfigDict(extra="forbid")

    scope: Literal["all", "conversations", "memories", "tool_logs"]


class MemoryCandidateResolutionRequest(BaseModel):
    """用户确认或忽略后台分析出的记忆候选。"""

    model_config = ConfigDict(extra="forbid")

    decision: Literal["confirmed", "rejected"]


class ToolLogRequest(BaseModel):
    """Electron Main 回传已经过权限校验的工具审计记录。"""

    model_config = ConfigDict(extra="forbid")

    taskId: str = Field(min_length=1, max_length=128)
    toolCallId: str = Field(min_length=1, max_length=128)
    toolName: str = Field(min_length=1, max_length=64)
    args: Any = None
    risk: str = Field(min_length=1, max_length=32)
    policyDecision: str = Field(min_length=1, max_length=32)
    userDecision: str | None = Field(default=None, max_length=32)
    ok: bool | None = None
    error: str | None = Field(default=None, max_length=4_000)
    durationMs: int | None = Field(default=None, ge=0, le=86_400_000)


class SkillLocalPreviewRequest(BaseModel):
    """接收 Electron Main 原生目录选择器授权的 Skill 来源。"""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=2_048)


class SkillGithubPreviewRequest(BaseModel):
    """接收 Main 校验前的 GitHub 公共仓库 URL。"""

    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=20, max_length=2_048)


class SkillInstallRequest(BaseModel):
    """安装用户在预览中勾选的 Skill。"""

    model_config = ConfigDict(extra="forbid")

    previewToken: str = Field(pattern=r"^[a-f0-9]{32}$")
    skillIds: list[str] = Field(min_length=1, max_length=50)
