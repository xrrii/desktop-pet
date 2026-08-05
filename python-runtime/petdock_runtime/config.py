from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

"""Runtime 启动配置及环境变量解析。"""

BackendName = Literal["mock", "langchain"]
EmbeddingProviderName = Literal["hash", "local", "online"]


@dataclass(frozen=True)
class RuntimeConfig:
    """保存 Runtime 运行所需的鉴权、模型和本地存储配置。"""
    token: str
    resolved_backend: BackendName
    api_key: str | None
    base_url: str | None
    model: str
    memory_db_path: str = ":memory:"
    knowledge_db_path: str = ":memory:"
    chroma_path: str = ":memory:"
    skills_db_path: str = ":memory:"
    skills_root: str = "skills"
    embedding_provider: EmbeddingProviderName = "hash"
    embedding_model_dir: str | None = None
    embedding_descriptor_json: str | None = None
    embedding_api_key: str | None = None
    embedding_base_url: str | None = None
    embedding_model: str | None = None
    embedding_dimensions: int | None = None
    attachment_root: str = "attachments"
    artifact_root: str = "artifacts"
    vision_api_key: str | None = None
    vision_base_url: str | None = None
    vision_model: str | None = None
    vision_source: Literal["inherited", "custom"] = "inherited"

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
        knowledge_db_path = os.environ.get("PETDOCK_KNOWLEDGE_DB_PATH", "").strip() or os.path.join(
            os.getcwd(), "knowledge.db"
        )
        chroma_path = os.environ.get("PETDOCK_CHROMA_PATH", "").strip() or os.path.join(
            os.getcwd(), "rag", "chroma"
        )
        skills_db_path = os.environ.get("PETDOCK_SKILLS_DB_PATH", "").strip() or os.path.join(
            os.getcwd(), "skills.db"
        )
        skills_root = os.environ.get("PETDOCK_SKILLS_ROOT", "").strip() or os.path.join(
            os.getcwd(), "skills", "packages"
        )
        attachment_root = os.environ.get("PETDOCK_ATTACHMENT_ROOT", "").strip() or os.path.join(
            os.getcwd(), "assistant", "attachments"
        )
        artifact_root = os.environ.get("PETDOCK_ARTIFACT_ROOT", "").strip() or os.path.join(
            os.getcwd(), "assistant", "artifacts"
        )
        embedding_provider = os.environ.get("PETDOCK_EMBEDDING_PROVIDER", "hash").strip().lower()
        if embedding_provider not in {"hash", "local", "online"}:
            raise ValueError("PETDOCK_EMBEDDING_PROVIDER must be hash, local, or online.")
        embedding_model_dir = os.environ.get("PETDOCK_EMBEDDING_MODEL_DIR", "").strip() or None
        embedding_descriptor_json = (
            os.environ.get("PETDOCK_EMBEDDING_DESCRIPTOR_JSON", "").strip() or None
        )
        embedding_api_key = os.environ.get("PETDOCK_EMBEDDING_API_KEY", "").strip() or None
        embedding_base_url = os.environ.get("PETDOCK_EMBEDDING_BASE_URL", "").strip() or None
        embedding_model = os.environ.get("PETDOCK_EMBEDDING_MODEL", "").strip() or None
        raw_dimensions = os.environ.get("PETDOCK_EMBEDDING_DIMENSIONS", "").strip()
        embedding_dimensions = int(raw_dimensions) if raw_dimensions else None
        custom_vision = any(
            os.environ.get(name, "").strip()
            for name in ("PETDOCK_VISION_API_KEY", "PETDOCK_VISION_BASE_URL", "PETDOCK_VISION_MODEL")
        )
        vision_api_key = os.environ.get("PETDOCK_VISION_API_KEY", "").strip() or api_key
        vision_base_url = (
            os.environ.get("PETDOCK_VISION_BASE_URL", "").strip()
            or base_url
            or ("https://api.openai.com/v1" if api_key else None)
        )
        vision_model = os.environ.get("PETDOCK_VISION_MODEL", "").strip() or model

        if embedding_provider == "local" and not (
            embedding_model_dir and embedding_descriptor_json
        ):
            raise ValueError("本地 Embedding 需要模型目录和 descriptor JSON。")
        if embedding_provider == "online" and not all(
            (embedding_api_key, embedding_base_url, embedding_model, embedding_dimensions)
        ):
            raise ValueError("在线 Embedding 配置不完整。")

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
            knowledge_db_path=knowledge_db_path,
            chroma_path=chroma_path,
            skills_db_path=skills_db_path,
            skills_root=skills_root,
            attachment_root=attachment_root,
            artifact_root=artifact_root,
            embedding_provider=embedding_provider,  # type: ignore[arg-type]
            embedding_model_dir=embedding_model_dir,
            embedding_descriptor_json=embedding_descriptor_json,
            embedding_api_key=embedding_api_key,
            embedding_base_url=embedding_base_url,
            embedding_model=embedding_model,
            embedding_dimensions=embedding_dimensions,
            vision_api_key=vision_api_key,
            vision_base_url=vision_base_url,
            vision_model=vision_model,
            vision_source="custom" if custom_vision else "inherited",
        )
