from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class AssistantContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    activePetId: str = Field(min_length=1, max_length=128)
    locale: str = Field(min_length=1, max_length=64)
    timezone: str = Field(min_length=1, max_length=128)


class AssistantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocolVersion: Literal[1]
    taskId: str = Field(min_length=1, max_length=128)
    conversationId: str = Field(min_length=1, max_length=128)
    input: str = Field(min_length=1, max_length=12_000)
    source: Literal["pet", "assistant-window", "shortcut"]
    context: AssistantContext
