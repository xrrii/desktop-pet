from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

BackendName = Literal["mock", "langchain"]


@dataclass(frozen=True)
class RuntimeConfig:
    token: str
    resolved_backend: BackendName
    api_key: str | None
    base_url: str | None
    model: str

    @classmethod
    def from_environment(cls) -> "RuntimeConfig":
        token = os.environ.get("PETDOCK_RUNTIME_TOKEN", "").strip()
        if len(token) < 32:
            raise ValueError("PETDOCK_RUNTIME_TOKEN must contain at least 32 characters.")

        requested_backend = os.environ.get("PETDOCK_ASSISTANT_BACKEND", "auto").strip().lower()
        api_key = os.environ.get("PETDOCK_LLM_API_KEY", "").strip() or None
        model = os.environ.get("PETDOCK_LLM_MODEL", "gpt-4o-mini").strip()
        base_url = os.environ.get("PETDOCK_LLM_BASE_URL", "").strip() or None

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
        )
