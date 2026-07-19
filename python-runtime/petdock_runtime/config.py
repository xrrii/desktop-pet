from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

"""Runtime 启动配置及环境变量解析。"""

BackendName = Literal["mock", "langchain"]


@dataclass(frozen=True)
class RuntimeConfig:
    """保存 Runtime 运行所需的鉴权、模型和本地存储配置。"""
    token: str
    resolved_backend: BackendName
    api_key: str | None
    base_url: str | None
    model: str
    memory_db_path: str = ":memory:"

    @classmethod
    def from_environment(cls) -> "RuntimeConfig":
        """从环境变量读取配置，并在启动前校验模型和令牌约束。"""
        token = os.environ.get("PETDOCK_RUNTIME_TOKEN", "").strip()
        if len(token) < 32:
            raise ValueError("PETDOCK_RUNTIME_TOKEN must contain at least 32 characters.")

        requested_backend = os.environ.get("PETDOCK_ASSISTANT_BACKEND", "auto").strip().lower()
        api_key = os.environ.get("PETDOCK_LLM_API_KEY", "").strip() or None
        model = os.environ.get("PETDOCK_LLM_MODEL", "gpt-4o-mini").strip()
        base_url = os.environ.get("PETDOCK_LLM_BASE_URL", "").strip() or None
        memory_db_path = os.environ.get("PETDOCK_MEMORY_DB_PATH", "").strip() or os.path.join(
            os.getcwd(), "assistant.db"
        )

        if requested_backend == "auto":
            backend: BackendName = "langchain" if api_key else "mock"
        elif requested_backend in {"mock", "langchain"}:
            backend = requested_backend  # type: ignore[assignment]
        else:
            raise ValueError("PETDOCK_ASSISTANT_BACKEND must be auto, mock, or langchain.")

        if backend == "langchain" and not api_key:
            raise ValueError("PETDOCK_LLM_API_KEY is required for the langchain backend.")
        if not model:
            raise ValueError("PETDOCK_LLM_MODEL cannot be empty.")

        return cls(
            token=token,
            resolved_backend=backend,
            api_key=api_key,
            base_url=base_url,
            model=model,
            memory_db_path=memory_db_path,
        )
