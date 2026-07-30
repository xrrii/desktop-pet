from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from petdock_runtime.attachment_store import AttachmentStore
from petdock_runtime.config import RuntimeConfig
from petdock_runtime.protocol import AssistantRequest
from petdock_runtime.server import create_app

TOKEN = "a" * 64


def _write_managed_file(root: Path, attachment_id: str, name: str, content: bytes) -> dict[str, object]:
    """模拟 Main 复制文件到受控目录后的登记参数。"""
    directory = root / attachment_id
    directory.mkdir(parents=True)
    target = directory / name
    target.write_bytes(content)
    return {
        "id": attachment_id,
        "name": name,
        "relativePath": str(target.relative_to(root)),
        "sizeBytes": len(content),
    }


def test_attachment_store_parses_utf8_and_rejects_path_escape(tmp_path: Path) -> None:
    """验证严格 UTF-8 解析、错误状态和受控目录边界。"""
    root = tmp_path / "attachments"
    store = AttachmentStore(str(tmp_path / "assistant.db"), str(root))
    ready = _write_managed_file(root, "1" * 32, "notes.md", "你好，附件。".encode())
    invalid = _write_managed_file(root, "2" * 32, "legacy.txt", b"\xff\xfe\x00")
    (tmp_path / "outside.txt").write_text("x", encoding="utf-8")

    summaries = store.register_many([ready, invalid])

    assert summaries[0]["status"] == "ready"
    assert summaries[0]["parserId"] == "utf8-text-v1"
    assert summaries[1]["status"] == "error"
    assert summaries[1]["error"] == "attachment_decode_failed"
    first_page = store.preview("1" * 32, None, 0, 2)
    assert first_page["content"] == "你好"
    assert first_page["nextOffset"] == 2
    assert first_page["truncated"] is True
    second_page = store.preview("1" * 32, None, 2, 100)
    assert second_page["content"] == "，附件。"
    store.bind_for_request(["1" * 32], "preview-conversation")
    with pytest.raises(ValueError, match="无权预览"):
        store.preview("1" * 32, None, 0, 100)
    bound_preview = store.preview("1" * 32, "preview-conversation", 0, 100)
    assert bound_preview["content"] == "你好，附件。"
    with pytest.raises(ValueError, match="路径"):
        store.register_many(
            [{
                "id": "3" * 32,
                "name": "outside.txt",
                "relativePath": str(Path("..") / "outside.txt"),
                "sizeBytes": 1,
            }]
        )
    store.close()


def test_attachment_protocol_and_orphan_cleanup(tmp_path: Path) -> None:
    """验证空请求被拒绝，且只清理超过宽限期的合法孤立 ID 目录。"""
    with pytest.raises(ValueError, match="同时为空"):
        AssistantRequest(
            protocolVersion=1,
            taskId="empty-task",
            conversationId="empty-conversation",
            input="",
            source="assistant-window",
            context={"activePetId": "pet", "locale": "zh-CN", "timezone": "Asia/Shanghai"},
        )

    root = tmp_path / "attachments"
    old_orphan = root / ("5" * 32)
    recent_orphan = root / ("6" * 32)
    old_orphan.mkdir(parents=True)
    recent_orphan.mkdir()
    old_time = time.time() - 2 * 60 * 60
    os.utime(old_orphan, (old_time, old_time))

    store = AttachmentStore(str(tmp_path / "orphan.db"), str(root))

    assert not old_orphan.exists()
    assert recent_orphan.exists()
    store.close()


def test_attachment_api_emits_sources_and_cleans_conversation(tmp_path: Path) -> None:
    """验证登记、只附件对话、来源事件、历史摘要和会话文件清理闭环。"""
    attachment_root = tmp_path / "attachments"
    config = RuntimeConfig(
        token=TOKEN,
        resolved_backend="mock",
        api_key=None,
        base_url=None,
        model="unused",
        memory_db_path=str(tmp_path / "assistant.db"),
        knowledge_db_path=str(tmp_path / "knowledge.db"),
        chroma_path=str(tmp_path / "chroma"),
        skills_db_path=str(tmp_path / "skills.db"),
        skills_root=str(tmp_path / "skills"),
        attachment_root=str(attachment_root),
    )
    app = create_app(config)
    item = _write_managed_file(
        attachment_root,
        "4" * 32,
        "brief.md",
        "C1 附件测试口令：青色星光。".encode(),
    )

    async def scenario() -> tuple[list[dict[str, object]], dict[str, object], bool]:
        transport = ASGITransport(app=app)
        headers = {"Authorization": f"Bearer {TOKEN}"}
        async with AsyncClient(transport=transport, base_url="http://runtime.test") as client:
            registered = await client.post(
                "/v1/attachments",
                headers=headers,
                json={"attachments": [item]},
            )
            assert registered.status_code == 200
            request = {
                "protocolVersion": 1,
                "taskId": "attachment-task",
                "conversationId": "attachment-conversation",
                "input": "",
                "source": "assistant-window",
                "context": {
                    "activePetId": "pet",
                    "locale": "zh-CN",
                    "timezone": "Asia/Shanghai",
                },
                "knowledgeLibraryIds": [],
                "attachmentIds": [item["id"]],
            }
            created = await client.post("/v1/chat", headers=headers, json=request)
            assert created.status_code == 200
            response = await client.get("/v1/events/attachment-task", headers=headers)
            events = [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]
            history = await client.get(
                "/v1/memory/conversation/attachment-conversation",
                headers=headers,
            )
            deleted = await client.request(
                "DELETE",
                "/v1/memory/item",
                headers=headers,
                json={"kind": "conversation", "id": "attachment-conversation"},
            )
            return events, history.json(), deleted.json()["deleted"]

    events, history, deleted = asyncio.run(scenario())
    assert any(event["type"] == "attachment_sources" for event in events)
    response_text = "".join(
        str(event["payload"]["delta"])
        for event in events
        if event["type"] == "message_delta"
    )
    assert "brief.md" in response_text
    assert "青色星光" in response_text
    assert history["messages"][0]["attachments"][0]["name"] == "brief.md"
    assert deleted
    assert not (attachment_root / str(item["id"])).exists()
