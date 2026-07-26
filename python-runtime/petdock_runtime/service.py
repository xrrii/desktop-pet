from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from .backends import AssistantBackend, RetrievalContext, ToolCallRequest
from .memory_extractor import MemoryExtractor
from .protocol import AssistantRequest, ToolResultRequest

"""Runtime 任务生命周期、SSE 事件和工具结果等待逻辑。"""


@dataclass
class TaskSession:
    """保存单个任务的事件队列、取消状态和待处理工具结果。"""
    queue: asyncio.Queue[dict[str, Any] | None] = field(default_factory=asyncio.Queue)
    task: asyncio.Task[None] | None = None
    consumed: bool = False
    pending_tool_call_id: str | None = None
    pending_tool_result: asyncio.Future[ToolResultRequest] | None = None


class AssistantService:
    """编排后端流式输出，并在外部工具调用时暂停等待 Main。"""

    def __init__(self, backend: AssistantBackend, extractor: MemoryExtractor | None = None) -> None:
        """绑定模型后端和可选的异步记忆分析器。"""
        self._backend = backend
        self._extractor = extractor
        self._sessions: dict[str, TaskSession] = {}

    def start(self, request: AssistantRequest) -> None:
        """创建任务会话并启动后台执行协程。"""
        if request.taskId in self._sessions:
            raise ValueError("Task already exists.")
        session = TaskSession()
        self._sessions[request.taskId] = session
        session.task = asyncio.create_task(self._run(request, session))

    async def events(self, task_id: str):
        """消费指定任务的单次 SSE 事件流，并在结束后释放会话。"""
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
        """取消仍在运行的任务，返回是否成功找到可取消任务。"""
        session = self._sessions.get(task_id)
        if not session or not session.task or session.task.done():
            return False
        session.task.cancel()
        return True

    def submit_tool_result(self, request: ToolResultRequest) -> bool:
        """把 Electron Main 的执行结果交给正在等待的 Agent 任务。"""
        session = self._sessions.get(request.taskId)
        if not session or session.pending_tool_call_id != request.toolCallId:
            return False
        future = session.pending_tool_result
        if not future or future.done():
            return False
        future.set_result(request)
        return True

    async def _run(self, request: AssistantRequest, session: TaskSession) -> None:
        """转发后端输出、暂停外部工具调用并最终发送 done/error 事件。"""
        sequence = 0
        tool_result: ToolResultRequest | None = None
        assistant_text_parts: list[str] = []
        completed = False

        async def emit(event_type: str, payload: dict[str, Any]) -> None:
            """为事件分配单调序号并写入任务队列。"""
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
            while True:
                waiting_for_tool = False
                async for output in self._backend.stream(request, tool_result):
                    tool_result = None
                    if isinstance(output, str):
                        assistant_text_parts.append(output)
                        await emit("message_delta", {"delta": output})
                        continue

                    if isinstance(output, RetrievalContext):
                        await emit(
                            "retrieval_sources",
                            {"sources": [source.public() for source in output.sources]},
                        )
                        continue

                    if not isinstance(output, ToolCallRequest):
                        raise TypeError("Assistant backend returned an unsupported output.")
                    if waiting_for_tool:
                        raise ValueError("Multiple simultaneous tool calls are not supported.")

                    waiting_for_tool = True
                    await emit(
                        "tool_call",
                        {
                            "id": output.id,
                            "name": output.name,
                            "args": output.args,
                            "risk": "confirm",
                            "preview": output.preview,
                        },
                    )
                    session.pending_tool_call_id = output.id
                    session.pending_tool_result = asyncio.get_running_loop().create_future()
                    try:
                        tool_result = await asyncio.wait_for(
                            session.pending_tool_result, timeout=120
                        )
                    finally:
                        session.pending_tool_call_id = None
                        session.pending_tool_result = None
                    break

                if not waiting_for_tool:
                    break
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
            completed = True
        finally:
            if completed and self._extractor:
                self._extractor.schedule(request, "".join(assistant_text_parts))
            if session.pending_tool_result and not session.pending_tool_result.done():
                session.pending_tool_result.cancel()
            await session.queue.put(None)
