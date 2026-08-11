from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

"""会话附件资料集对外使用的数据模型。"""

@dataclass(frozen=True)
class AttachmentDatasetContext:
    """承载本轮实际注入模型的附件资料、来源和覆盖状态。"""

    mode: Literal["none", "direct", "retrieval"]
    context_text: str
    sources: list[dict[str, object]]
    total_attachments: int
    total_tokens: int
    unmatched_attachments: list[dict[str, str]] = field(default_factory=list)
    warnings: list[dict[str, str]] = field(default_factory=list)

    def event_payload(self) -> dict[str, object]:
        """转换为 Renderer 可展示且不含完整正文的来源事件。"""
        return {
            "mode": self.mode,
            "sources": self.sources,
            "totalAttachments": self.total_attachments,
            "totalTokens": self.total_tokens,
            "unmatchedAttachments": self.unmatched_attachments,
            "warnings": self.warnings,
        }

