from __future__ import annotations

from types import SimpleNamespace

import pytest

from petdock_runtime.providers.chat import ChatModelFactory
from petdock_runtime.providers.selector import (
    parse_runtime_capabilities,
    resolve_backend,
    validate_embedding_source,
)
from petdock_runtime.config import RuntimeConfig


def test_byok_factory_centralizes_agent_and_memory_model_creation(monkeypatch) -> None:
    """BYOK 主模型和后台模型必须由同一个 Factory 按用途创建。"""
    calls: list[dict[str, object]] = []

    class FakeChatOpenAI:
        """记录构造参数并模拟 LangChain 的工具绑定接口。"""

        def __init__(self, **kwargs) -> None:
            calls.append(kwargs)

        def bind_tools(self, tools):
            calls[-1]["tools"] = tools
            return SimpleNamespace(astream=lambda _messages: None)

    monkeypatch.setattr("petdock_runtime.providers.chat.ChatOpenAI", FakeChatOpenAI)
    factory = ChatModelFactory(
        "byok",
        api_key="test-key",
        base_url="https://example.test/v1",
        model="test-model",
    )

    agent = factory.create_agent_model([{"name": "demo"}])
    memory = factory.create_text_model("memory")

    assert agent is not None
    assert memory is not None
    assert factory.backend_name == "langchain"
    assert calls == [
        {
            "api_key": "test-key",
            "base_url": "https://example.test/v1",
            "model": "test-model",
            "temperature": 0.2,
            "streaming": True,
            "tools": [{"name": "demo"}],
        },
        {
            "api_key": "test-key",
            "base_url": "https://example.test/v1",
            "model": "test-model",
            "temperature": 0,
            "streaming": False,
        },
    ]


def test_mock_and_managed_sources_never_create_background_network_model() -> None:
    """Mock 和 Managed 后台分析固定使用本地规则，避免隐式用量。"""
    mock = ChatModelFactory("mock", api_key=None, base_url=None, model="unused")
    managed = ChatModelFactory("managed", api_key="must-not-use", base_url=None, model="unused")

    assert mock.backend_name == "mock"
    assert mock.create_text_model("memory") is None
    assert managed.create_text_model("memory") is None
    assert managed.backend_name == "langchain"


def test_runtime_capability_selector_parses_effective_sources() -> None:
    """Runtime 只消费 Main 已计算的 effectiveSource。"""
    settings = parse_runtime_capabilities(
        """{
          "version": 1,
          "capabilities": {
            "chat": {"effectiveSource": "byok"},
            "embedding": {"effectiveSource": "local"},
            "vision": {"effectiveSource": "disabled"},
            "rerank": {"effectiveSource": "disabled"},
            "web_search": {"effectiveSource": "disabled"}
          }
        }""",
        requested_backend="mock",
        has_chat_api_key=True,
        embedding_provider="hash",
        has_vision_configuration=False,
    )

    assert settings.chat == "byok"
    assert settings.embedding == "local"
    assert resolve_backend(settings.chat, True) == "langchain"
    validate_embedding_source(settings.embedding, "hash")


def test_runtime_capability_selector_keeps_legacy_auto_behavior() -> None:
    """没有新快照时继续按旧 auto 规则选择 BYOK 或 Mock。"""
    offline = parse_runtime_capabilities(
        None,
        requested_backend="auto",
        has_chat_api_key=False,
        embedding_provider="hash",
        has_vision_configuration=False,
    )
    online = parse_runtime_capabilities(
        None,
        requested_backend="auto",
        has_chat_api_key=True,
        embedding_provider="online",
        has_vision_configuration=True,
    )

    assert offline.chat == "mock"
    assert offline.embedding == "local"
    assert online.chat == "byok"
    assert online.embedding == "byok"
    assert online.vision == "byok"


def test_runtime_capability_selector_rejects_managed_and_mismatched_embedding() -> None:
    """Wave D 对 Managed 使用独立网络适配器，来源错配仍必须失败关闭。"""
    assert resolve_backend("managed", False) == "langchain"
    with pytest.raises(ValueError, match="不是 online"):
        validate_embedding_source("byok", "hash")
    with pytest.raises(ValueError, match="仍为 online"):
        validate_embedding_source("local", "online")


def test_runtime_capability_selector_preserves_invalid_legacy_backend_error() -> None:
    """新快照存在时也不能绕过旧环境变量的取值校验。"""
    with pytest.raises(ValueError, match="必须是 auto、mock 或 langchain"):
        parse_runtime_capabilities(
            '{"version": 1, "capabilities": {}}',
            requested_backend="invalid",
            has_chat_api_key=False,
            embedding_provider="hash",
            has_vision_configuration=False,
        )


def test_runtime_config_uses_main_snapshot_and_disables_vision(monkeypatch) -> None:
    """Runtime 后端和视觉配置必须以 Main 的 effectiveSource 为准。"""
    monkeypatch.setenv("PETDOCK_RUNTIME_TOKEN", "t" * 64)
    monkeypatch.setenv("PETDOCK_ASSISTANT_BACKEND", "auto")
    monkeypatch.setenv("PETDOCK_LLM_API_KEY", "host-process-key")
    monkeypatch.setenv(
        "PETDOCK_RUNTIME_CAPABILITIES_JSON",
        """{
          "version": 1,
          "capabilities": {
            "chat": {"effectiveSource": "mock"},
            "embedding": {"effectiveSource": "local"},
            "vision": {"effectiveSource": "disabled"},
            "rerank": {"effectiveSource": "disabled"},
            "web_search": {"effectiveSource": "disabled"}
          }
        }""",
    )
    monkeypatch.setenv("PETDOCK_EMBEDDING_PROVIDER", "hash")
    monkeypatch.setenv("PETDOCK_VISION_API_KEY", "vision-key-must-be-ignored")

    config = RuntimeConfig.from_environment()

    assert config.resolved_backend == "mock"
    assert config.chat_source == "mock"
    assert config.vision_api_key is None
    assert config.vision_model is None


def test_runtime_config_accepts_wave_d_managed_chat(monkeypatch) -> None:
    """Runtime 收到 Managed effectiveSource 时保留独立 Cloud 消费来源。"""
    monkeypatch.setenv("PETDOCK_RUNTIME_TOKEN", "t" * 64)
    monkeypatch.setenv("PETDOCK_LLM_API_KEY", "host-process-key")
    monkeypatch.setenv(
        "PETDOCK_RUNTIME_CAPABILITIES_JSON",
        """{
          "version": 1,
          "capabilities": {
            "chat": {"effectiveSource": "managed"},
            "embedding": {"effectiveSource": "local"},
            "vision": {"effectiveSource": "disabled"},
            "rerank": {"effectiveSource": "disabled"},
            "web_search": {"effectiveSource": "disabled"}
          }
        }""",
    )
    config = RuntimeConfig.from_environment()
    assert config.resolved_backend == "langchain"
    assert config.chat_source == "managed"


def test_runtime_config_rejects_invalid_managed_connection_settings(monkeypatch) -> None:
    """Managed 数据面地址、版本和设备标识不合规时必须启动失败。"""
    monkeypatch.setenv("PETDOCK_RUNTIME_TOKEN", "t" * 64)
    monkeypatch.setenv("PETDOCK_RUNTIME_CAPABILITIES_JSON", '{"version":1,"capabilities":{"chat":{"effectiveSource":"mock"},"embedding":{"effectiveSource":"local"},"vision":{"effectiveSource":"disabled"},"rerank":{"effectiveSource":"disabled"},"web_search":{"effectiveSource":"disabled"}}}')

    monkeypatch.setenv("PETDOCK_AI_BASE_URL", "ftp://invalid.example")
    with pytest.raises(ValueError, match=r"HTTP\(S\)"):
        RuntimeConfig.from_environment()

    monkeypatch.setenv("PETDOCK_AI_BASE_URL", "https://ai.example")
    monkeypatch.setenv("PETDOCK_CLIENT_VERSION", "dev")
    with pytest.raises(ValueError, match="格式无效"):
        RuntimeConfig.from_environment()

    monkeypatch.setenv("PETDOCK_CLIENT_VERSION", "0.2.0")
    monkeypatch.setenv("PETDOCK_MANAGED_DEVICE_ID", "invalid")
    with pytest.raises(ValueError, match="UUID"):
        RuntimeConfig.from_environment()
