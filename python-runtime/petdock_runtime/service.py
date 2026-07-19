from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from .backends import AssistantBackend
from .protocol import AssistantRequest


@dataclass
class TaskSession:
    queue: asyncio.Queue[dict[str, Any] | None] = field(default_factory=asyncio.Queue)
    task: asyncio.Task[None] | None = None
    consumed: bool = False


class AssistantService:
    def __init__(self, backend: AssistantBackend) -> None:
        self._backend = backend
        self._sessions: dict[str, TaskSession] = {}

    def start(self, request: AssistantRequest) -> None:
        if request.taskId in self._sessions:
            raise ValueError("Task already exists.")
        session = TaskSession()
        self._sessions[request.taskId] = session
        session.task = asyncio.create_task(self._run(request, session))

    async def events(self, task_id: str):
        session = self._sessions.get(task_id)
        if not session:
            raise KeyError(task_id)
        if session.consumed:
            raise ValueError("Task event stream was already consumed.")
        session.consumed = True

        try:
            while True:
                event = await session.queue.get()
                if event is None:
                    break
                yield event
        finally:
            self._sessions.pop(task_id, None)

    def cancel(self, task_id: str) -> bool:
        session = self._sessions.get(task_id)
        if not session or not session.task or session.task.done():
            return False
        session.task.cancel()
        return True

    async def _run(self, request: AssistantRequest, session: TaskSession) -> None:
        sequence = 0

        async def emit(event_type: str, payload: dict[str, Any]) -> None:
            nonlocal sequence
            sequence += 1
            await session.queue.put(
                {
                    "protocolVersion": 1,
                    "taskId": request.taskId,
                    "sequence": sequence,
                    "type": event_type,
                    "payload": payload,
                }
            )

        try:
            async for delta in self._backend.stream(request):
                await emit("message_delta", {"delta": delta})
        except asyncio.CancelledError:
            await emit("done", {"finishReason": "cancelled"})
        except Exception as error:
            await emit(
                "error",
                {
                    "code": "backend_error",
                    "message": str(error) or error.__class__.__name__,
                    "retryable": True,
                },
            )
            await emit("done", {"finishReason": "error"})
        else:
            await emit("done", {"finishReason": "stop"})
        finally:
            await session.queue.put(None)
