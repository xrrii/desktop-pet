from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal

"""解析 Electron Main 下发的脱敏能力来源快照。"""

ChatSource = Literal["byok", "managed", "disabled", "mock"]
EmbeddingSource = Literal["byok", "managed", "local"]
VisionSource = Literal["byok", "managed", "disabled"]
RerankSource = Literal["managed", "disabled"]
WebSearchSource = Literal["byok", "managed", "disabled"]


@dataclass(frozen=True)
class RuntimeCapabilitySettings:
    """保存 Runtime 实际使用的能力来源，不包含凭据和用户选择历史。"""

    chat: ChatSource
    embedding: EmbeddingSource
    vision: VisionSource
    rerank: RerankSource
    web_search: WebSearchSource


def parse_runtime_capabilities(
    raw: str | None,
    *,
    requested_backend: str,
    has_chat_api_key: bool,
    embedding_provider: str,
    has_vision_configuration: bool,
) -> RuntimeCapabilitySettings:
    """解析版本化能力快照；缺失时保留旧环境变量的兼容行为。"""
    if requested_backend not in {"auto", "mock", "langchain"}:
        raise ValueError("PETDOCK_ASSISTANT_BACKEND 必须是 auto、mock 或 langchain。")
    if not raw:
        return _legacy_capabilities(
            requested_backend=requested_backend,
            has_chat_api_key=has_chat_api_key,
            embedding_provider=embedding_provider,
            has_vision_configuration=has_vision_configuration,
        )

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("PETDOCK_RUNTIME_CAPABILITIES_JSON 不是有效 JSON。") from error
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise ValueError("Runtime 能力配置版本无效。")
    capabilities = payload.get("capabilities")
    if not isinstance(capabilities, dict):
        raise ValueError("Runtime 能力配置缺少 capabilities。")

    chat = _effective_source(capabilities, "chat", {"byok", "managed", "disabled", "mock"})
    embedding = _effective_source(capabilities, "embedding", {"byok", "managed", "local"})
    vision = _effective_source(capabilities, "vision", {"byok", "managed", "disabled"})
    rerank = _effective_source(capabilities, "rerank", {"managed", "disabled"})
    web_search = _effective_source(
        capabilities,
        "web_search",
        {"byok", "managed", "disabled"},
    )
    return RuntimeCapabilitySettings(
        chat=chat,  # type: ignore[arg-type]
        embedding=embedding,  # type: ignore[arg-type]
        vision=vision,  # type: ignore[arg-type]
        rerank=rerank,  # type: ignore[arg-type]
        web_search=web_search,  # type: ignore[arg-type]
    )


def resolve_backend(source: ChatSource, has_chat_api_key: bool) -> Literal["mock", "langchain"]:
    """把 Chat 有效来源映射为现有 Runtime 技术后端。"""
    if source == "mock":
        return "mock"
    if source == "byok":
        if not has_chat_api_key:
            raise ValueError("Chat 来源为 BYOK，但没有可用 API Key。")
        return "langchain"
    if source == "managed":
        return "langchain"
    raise ValueError("当前 Chat 能力已关闭，Runtime 不应启动模型后端。")


def validate_embedding_source(source: EmbeddingSource, provider: str) -> None:
    """校验 Main 下发的有效来源与现有 Embedding Provider 一致。"""
    if source == "managed":
        raise ValueError("Phase 1 尚未启用 Managed Embedding 网络适配器。")
    if source == "byok" and provider != "online":
        raise ValueError("Embedding 来源为 BYOK，但 Runtime Provider 不是 online。")
    if source == "local" and provider == "online":
        raise ValueError("Embedding 来源为 local，但 Runtime Provider 仍为 online。")


def _effective_source(
    capabilities: dict[str, object],
    name: str,
    allowed: set[str],
) -> str:
    """读取单项能力的 effectiveSource 并执行严格白名单校验。"""
    value = capabilities.get(name)
    if not isinstance(value, dict):
        raise ValueError(f"Runtime 能力配置缺少 {name}。")
    source = value.get("effectiveSource")
    if not isinstance(source, str) or source not in allowed:
        raise ValueError(f"Runtime 能力 {name} 的 effectiveSource 无效。")
    return source


def _legacy_capabilities(
    *,
    requested_backend: str,
    has_chat_api_key: bool,
    embedding_provider: str,
    has_vision_configuration: bool,
) -> RuntimeCapabilitySettings:
    """新配置缺失时复现 Phase 1 之前的启动选择。"""
    if requested_backend == "auto":
        chat: ChatSource = "byok" if has_chat_api_key else "mock"
    elif requested_backend == "langchain":
        chat = "byok"
    elif requested_backend == "mock":
        chat = "mock"
    else:
        raise ValueError("PETDOCK_ASSISTANT_BACKEND 必须是 auto、mock 或 langchain。")

    embedding: EmbeddingSource = "byok" if embedding_provider == "online" else "local"
    return RuntimeCapabilitySettings(
        chat=chat,
        embedding=embedding,
        vision="byok" if has_vision_configuration else "disabled",
        rerank="disabled",
        web_search="disabled",
    )
