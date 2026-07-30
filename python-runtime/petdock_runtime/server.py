from __future__ import annotations

import json
import secrets
from collections.abc import Callable

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse

from .attachment_store import AttachmentStore
from .backends import create_backend
from .config import RuntimeConfig
from .embeddings import LocalHashEmbedding, create_embedding_provider
from .knowledge import ChromaVectorStore, KnowledgeService
from .knowledge_store import KnowledgeStore
from .memory_store import MemoryStore
from .memory_extractor import create_memory_extractor
from .skill_registry import SkillRegistry
from .skill_store import SkillStore
from .skill_manifest import SkillManifestError
from .skill_installer import SkillInstaller
from .protocol import (
    AssistantRequest,
    AttachmentRegisterRequest,
    AttachmentPreviewRequest,
    MemoryClearRequest,
    MemoryCandidateResolutionRequest,
    MemoryItemRequest,
    KnowledgeLibraryCreateRequest,
    ToolLogRequest,
    ToolResultRequest,
    SkillGithubPreviewRequest,
    SkillInstallRequest,
    SkillLocalPreviewRequest,
)
from .service import AssistantService

"""FastAPI 路由层，只负责鉴权、协议校验和 Runtime 服务编排。"""


def create_app(config: RuntimeConfig, request_shutdown: Callable[[], None] | None = None) -> FastAPI:
    """创建带本地 SQLite、聊天、工具和记忆接口的 FastAPI 应用。"""
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    store = MemoryStore(config.memory_db_path)
    attachments = AttachmentStore(config.memory_db_path, config.attachment_root)
    knowledge_store = KnowledgeStore(config.knowledge_db_path)
    embedding = create_embedding_provider(config)
    fallback_vectors = (
        ChromaVectorStore(config.chroma_path, LocalHashEmbedding())
        if embedding.descriptor.id != LocalHashEmbedding.name
        else None
    )
    knowledge = KnowledgeService(
        knowledge_store,
        ChromaVectorStore(config.chroma_path, embedding),
        fallback_vectors,
    )
    skill_store = SkillStore(config.skills_db_path)
    skills = SkillRegistry(config.skills_root, skill_store)
    skill_installer = SkillInstaller(config.skills_root, skills)
    service = AssistantService(
        create_backend(config, store, knowledge, skills, attachments),
        create_memory_extractor(config, store),
    )

    def authorize(authorization: str | None) -> None:
        """校验除健康检查外所有接口使用的 Runtime 启动令牌。"""
        expected = f"Bearer {config.token}"
        if authorization is None or not secrets.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="Unauthorized")

    @app.get("/health")
    async def health() -> dict[str, object]:
        """返回无敏感信息的 Runtime 就绪状态。"""
        return {
            "status": "ok",
            "protocolVersion": 1,
            "backend": config.resolved_backend,
            "embeddingProvider": config.embedding_provider,
            "embeddingProfileId": embedding.descriptor.id,
            "indexSignature": embedding.descriptor.signature,
        }

    @app.post("/v1/chat")
    async def chat(
        request: AssistantRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, str]:
        """创建一个新的流式助手任务。"""
        authorize(authorization)
        try:
            service.start(request)
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {"taskId": request.taskId}

    @app.post("/v1/attachments")
    async def attachment_register(
        request: AttachmentRegisterRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """登记 Main 已复制到受控目录的附件并执行 UTF-8 解析。"""
        authorize(authorization)
        try:
            return {"attachments": attachments.register_many(request.model_dump()["attachments"])}
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except OSError as error:
            raise HTTPException(status_code=400, detail="附件读取失败。") from error

    @app.delete("/v1/attachments/{attachment_id}")
    async def attachment_delete(
        attachment_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """只删除尚未发送的草稿附件。"""
        authorize(authorization)
        if len(attachment_id) != 32 or any(character not in "0123456789abcdef" for character in attachment_id):
            raise HTTPException(status_code=400, detail="Invalid attachment id")
        return {"deleted": attachments.delete_draft(attachment_id)}

    @app.post("/v1/attachments/{attachment_id}/preview")
    async def attachment_preview(
        attachment_id: str,
        request: AttachmentPreviewRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """返回草稿或指定会话附件的分页文本预览。"""
        authorize(authorization)
        if len(attachment_id) != 32 or any(character not in "0123456789abcdef" for character in attachment_id):
            raise HTTPException(status_code=400, detail="Invalid attachment id")
        try:
            return attachments.preview(
                attachment_id,
                request.conversationId,
                request.offset,
                request.limit,
            )
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.get("/v1/events/{task_id}")
    async def events(
        task_id: str,
        authorization: str | None = Header(default=None),
    ) -> StreamingResponse:
        """以 text/event-stream 形式返回任务事件。"""
        authorize(authorization)
        try:
            event_stream = service.events(task_id)
        except (KeyError, ValueError) as error:
            raise HTTPException(status_code=404, detail="Task not found") from error

        async def encode_events():
            """把内部事件对象编码成 SSE data 帧。"""
            try:
                async for event in event_stream:
                    payload = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
                    yield f"data: {payload}\n\n"
            except (KeyError, ValueError) as error:
                raise HTTPException(status_code=404, detail="Task not found") from error

        return StreamingResponse(
            encode_events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @app.post("/v1/cancel/{task_id}")
    async def cancel(
        task_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """请求取消一个正在运行的助手任务。"""
        authorize(authorization)
        return {"cancelled": service.cancel(task_id)}

    @app.post("/v1/tool-result")
    async def tool_result(
        request: ToolResultRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """接收 Electron Main 完成外部工具后的结果。"""
        authorize(authorization)
        accepted = service.submit_tool_result(request)
        if not accepted:
            raise HTTPException(status_code=404, detail="Pending tool call not found")
        return {"accepted": True}

    @app.get("/v1/memory")
    async def memory_snapshot(authorization: str | None = Header(default=None)) -> dict[str, object]:
        """返回记忆管理界面需要的脱敏摘要。"""
        authorize(authorization)
        return store.snapshot()

    @app.get("/v1/memory/conversation/{conversation_id}")
    async def memory_conversation(
        conversation_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """返回指定会话的用户/助手消息，用于恢复聊天界面。"""
        authorize(authorization)
        return {"messages": store.conversation_messages(conversation_id)}

    @app.post("/v1/memory/tool-log")
    async def memory_tool_log(
        request: ToolLogRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """保存由 Electron Main 回传的工具审计记录。"""
        authorize(authorization)
        store.record_tool_log(request.model_dump())
        return {"accepted": True}

    @app.delete("/v1/memory/item")
    async def memory_delete(
        request: MemoryItemRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """删除一条记忆、会话或常用项。"""
        authorize(authorization)
        if request.kind == "conversation":
            attachments.delete_conversation(request.id)
        return {"deleted": store.delete_item(request.kind, request.id)}

    @app.post("/v1/memory/candidate/{candidate_id}")
    async def memory_candidate(
        candidate_id: int,
        request: MemoryCandidateResolutionRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """处理用户对后台记忆候选的确认或忽略。"""
        authorize(authorization)
        if candidate_id < 1:
            raise HTTPException(status_code=400, detail="Invalid candidate id")
        return {"accepted": store.resolve_candidate(candidate_id, request.decision)}

    @app.post("/v1/memory/clear")
    async def memory_clear(
        request: MemoryClearRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """按范围清理会话、长期记忆或工具日志。"""
        authorize(authorization)
        if request.scope in {"all", "conversations"}:
            attachments.clear_conversations()
        store.clear(request.scope)
        return {"cleared": True}

    @app.get("/v1/knowledge")
    async def knowledge_snapshot(
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """返回知识库、索引进度和可用于聊天的状态。"""
        authorize(authorization)
        return knowledge_store.snapshot()

    @app.get("/v1/skills")
    async def skill_snapshot(
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """返回 Skill 管理界面需要的脱敏元数据。"""
        authorize(authorization)
        return skills.snapshot()

    @app.post("/v1/skills/install/local/preview")
    async def skill_preview_local(
        request: SkillLocalPreviewRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """预览 Main 原生选择器授权的本地 Skill 目录。"""
        authorize(authorization)
        try:
            return skill_installer.preview_local(request.path)
        except (OSError, SkillManifestError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/v1/skills/install/github/preview")
    async def skill_preview_github(
        request: SkillGithubPreviewRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """下载固定 commit 并返回 GitHub Skill 候选。"""
        authorize(authorization)
        try:
            return await skill_installer.preview_github(request.url)
        except (OSError, httpx.HTTPError, SkillManifestError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/v1/skills/install")
    async def skill_install(
        request: SkillInstallRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """安装用户确认的预览候选并热刷新注册表。"""
        authorize(authorization)
        try:
            return skill_installer.install(request.previewToken, request.skillIds)
        except (OSError, SkillManifestError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/v1/skills/refresh")
    async def skill_refresh(
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """重新扫描 Skill frontmatter，不加载技能正文。"""
        authorize(authorization)
        return skills.refresh()

    @app.post("/v1/skills/{skill_id}/enable")
    async def skill_enable(
        skill_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """启用一个已安装 Skill。"""
        authorize(authorization)
        try:
            return {"updated": skills.set_enabled(skill_id, True)}
        except SkillManifestError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/v1/skills/{skill_id}/disable")
    async def skill_disable(
        skill_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """禁用一个已安装 Skill。"""
        authorize(authorization)
        try:
            return {"updated": skills.set_enabled(skill_id, False)}
        except SkillManifestError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get("/v1/skills/{skill_id}/runs")
    async def skill_runs(
        skill_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """返回指定 Skill 的最近运行日志。"""
        authorize(authorization)
        try:
            return {"runs": skills.recent_runs(skill_id)}
        except SkillManifestError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.delete("/v1/skills/{skill_id}")
    async def skill_uninstall(
        skill_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """卸载托管 Skill 包。"""
        authorize(authorization)
        try:
            return {"deleted": skill_installer.uninstall(skill_id)}
        except (OSError, SkillManifestError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/v1/knowledge/reindex-all")
    async def knowledge_reindex_all(
        authorization: str | None = Header(default=None),
    ) -> dict[str, int]:
        """模型切换后为全部已有知识库启动新签名索引。"""
        authorize(authorization)
        return {"started": await knowledge.start_all_indexes()}

    @app.post("/v1/knowledge/library")
    async def knowledge_create(
        request: KnowledgeLibraryCreateRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, object]:
        """创建经过 Electron Main 目录选择器授权的知识库。"""
        authorize(authorization)
        try:
            return {"library": await knowledge.create_library(request.name, request.path)}
        except (OSError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/v1/knowledge/library/{library_id}/index")
    async def knowledge_index(
        library_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """启动、恢复或手动刷新知识库索引。"""
        authorize(authorization)
        try:
            return {"started": await knowledge.start_index(library_id)}
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Knowledge library not found") from error

    @app.post("/v1/knowledge/library/{library_id}/pause")
    async def knowledge_pause(
        library_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """在当前文件完成后暂停索引。"""
        authorize(authorization)
        try:
            return {"paused": await knowledge.pause_index(library_id)}
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Knowledge library not found") from error

    @app.delete("/v1/knowledge/library/{library_id}")
    async def knowledge_delete(
        library_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        """删除索引数据，不删除用户来源目录中的文件。"""
        authorize(authorization)
        return {"deleted": await knowledge.delete_library(library_id)}

    @app.post("/v1/shutdown")
    async def shutdown(authorization: str | None = Header(default=None)) -> dict[str, bool]:
        """关闭 Runtime 服务并释放 SQLite 连接。"""
        authorize(authorization)
        await knowledge.close()
        skills.close()
        attachments.cleanup_drafts()
        attachments.close()
        store.close()
        if request_shutdown:
            request_shutdown()
        return {"accepted": True}

    return app
