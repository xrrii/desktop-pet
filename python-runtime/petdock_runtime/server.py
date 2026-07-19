from __future__ import annotations

import json
import secrets
from collections.abc import Callable

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse

from .backends import create_backend
from .config import RuntimeConfig
from .protocol import AssistantRequest
from .service import AssistantService


def create_app(config: RuntimeConfig, request_shutdown: Callable[[], None] | None = None) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    service = AssistantService(create_backend(config))

    def authorize(authorization: str | None) -> None:
        expected = f"Bearer {config.token}"
        if authorization is None or not secrets.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="Unauthorized")

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {
            "status": "ok",
            "protocolVersion": 1,
            "backend": config.resolved_backend,
        }

    @app.post("/v1/chat")
    async def chat(
        request: AssistantRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, str]:
        authorize(authorization)
        try:
            service.start(request)
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {"taskId": request.taskId}

    @app.get("/v1/events/{task_id}")
    async def events(
        task_id: str,
        authorization: str | None = Header(default=None),
    ) -> StreamingResponse:
        authorize(authorization)
        try:
            event_stream = service.events(task_id)
        except (KeyError, ValueError) as error:
            raise HTTPException(status_code=404, detail="Task not found") from error

        async def encode_events():
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
        authorize(authorization)
        return {"cancelled": service.cancel(task_id)}

    @app.post("/v1/shutdown")
    async def shutdown(authorization: str | None = Header(default=None)) -> dict[str, bool]:
        authorize(authorization)
        if request_shutdown:
            request_shutdown()
        return {"accepted": True}

    return app
