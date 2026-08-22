from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass

from ..artifacts.store import ArtifactRecord
from ..attachments.models import AttachmentDatasetContext
from ..knowledge.service import RetrievalSource
from ..protocol import AssistantRequest, ToolResultRequest

"""Agent 编排层与具体模型后端之间的稳定契约。"""


@dataclass(frozen=True)
class ToolCallRequest:
    """模型规划出的工具调用，实际执行永远交给 Electron Main。"""

    id: str
    name: str
    args: dict[str, object]
    preview: str


@dataclass(frozen=True)
class RetrievalContext:
    """把检索来源作为独立事件交给 Service，避免 UI 从模型文本猜引用。"""

    sources: list[RetrievalSource]


@dataclass(frozen=True)
class AttachmentContext:
    """把会话资料集模式、来源和覆盖状态交给 Service。"""

    dataset: AttachmentDatasetContext


@dataclass(frozen=True)
class WebSourcesContext:
    """把最终回答实际引用的网页来源交给 Service。"""

    sources: list[dict[str, object]]


@dataclass(frozen=True)
class ArtifactCreatedEvent:
    """把应用内生成文件作为结构化事件交给 Service。"""

    artifact: ArtifactRecord


@dataclass(frozen=True)
class SkillLifecycleEvent:
    """把 Skill 生命周期作为结构化事件交给 Service。"""

    type: str
    payload: dict[str, object]


@dataclass(frozen=True)
class ManagedAuthRefreshRequired:
    """通知 Electron Main 在流前刷新一次官方 Runtime Token。"""

    task_id: str
    trace_id: str
    request_id: str


BackendOutput = (
    str
    | ToolCallRequest
    | RetrievalContext
    | AttachmentContext
    | WebSourcesContext
    | ArtifactCreatedEvent
    | SkillLifecycleEvent
    | ManagedAuthRefreshRequired
)


class AssistantBackend(ABC):
    """统一封装流式模型后端，屏蔽在线模型与离线 Mock 的差异。"""

    @abstractmethod
    async def stream(
        self, request: AssistantRequest, tool_result: ToolResultRequest | None = None
    ) -> AsyncIterator[BackendOutput]:
        """流式返回文本或等待 Electron Main 执行的外部工具调用。"""
        raise NotImplementedError

    def finish_task(self, task_id: str) -> None:
        """释放任务级临时资源；无状态后端无需处理。"""
        return None
