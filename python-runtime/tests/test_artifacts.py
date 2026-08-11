from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from petdock_runtime.artifacts.store import ArtifactStore, MAX_ARTIFACT_BYTES
from petdock_runtime.config import RuntimeConfig
from petdock_runtime.api.server import create_app

TOKEN = "c" * 64


def test_artifact_store_validates_name_format_size_and_ownership(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证文件名清理、五类以上文本格式、大小限制和会话隔离。"""
    root = tmp_path / "artifacts"
    store = ArtifactStore(str(tmp_path / "assistant.db"), str(root))
    formats = ("txt", "md", "json", "jsonl", "yaml", "csv", "tsv")
    records = [
        store.create("conversation-1", f"message-{item}", f"task-{item}", f"报告.{item}", item, "内容")
        for item in formats
    ]
    assert all(record.status == "ready" for record in records)
    assert records[5].preview_kind == "table"

    sanitized = store.create(
        "conversation-1",
        "message-safe",
        "task-safe",
        "../CON.txt",
        "txt",
        "安全内容",
    )
    assert "/" not in sanitized.name and "\\" not in sanitized.name
    assert sanitized.name.upper() != "CON.TXT"
    assert store.preview(sanitized.id, "conversation-1", 0, 2)["content"] == "安全"
    windows_chars = store.create(
        "conversation-1",
        "message-chars",
        "task-chars",
        'CON.extra<>:"|?*.txt',
        "txt",
        "安全内容",
    )
    assert not any(character in windows_chars.name for character in '<>:"|?*')
    assert windows_chars.name.startswith("_CON.extra")
    with pytest.raises(ValueError, match="artifact_not_found"):
        store.preview(sanitized.id, "conversation-2", 0, 10)

    unsupported = store.create(
        "conversation-1", "message-exe", "task-exe", "payload.exe", "exe", "x"
    )
    assert unsupported.status == "error"
    assert unsupported.error == "artifact_format_unsupported"
    malformed = store.create(
        "conversation-1", "message-malformed", "task-malformed", "payload", "../EXE\n", "x"
    )
    assert malformed.status == "error"
    assert malformed.format == "invalid"
    assert malformed.name == "payload.txt"
    oversized = store.create(
        "conversation-1",
        "message-large",
        "task-large",
        "large.txt",
        "txt",
        "x" * (MAX_ARTIFACT_BYTES + 1),
    )
    assert oversized.status == "error"
    assert oversized.error == "artifact_too_large"

    retained = store.create(
        "conversation-1", "message-retained", "task-retained", "retained.txt", "txt", "保留"
    )
    monkeypatch.setattr(store, "_delete_directory", lambda _artifact_id: False)
    assert store.delete(retained.id, "conversation-1") is False
    assert store.get(retained.id, "conversation-1").id == retained.id
    store.close()


def test_artifact_api_generation_preview_save_and_cleanup(tmp_path: Path) -> None:
    """验证 Mock 生成事件、历史卡片、内容读取、保存标记和会话清理闭环。"""
    artifact_root = tmp_path / "artifacts"
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
        attachment_root=str(tmp_path / "attachments"),
        artifact_root=str(artifact_root),
    )
    app = create_app(config)

    async def scenario() -> tuple[list[dict[str, object]], dict[str, object], bytes, dict[str, object]]:
        transport = ASGITransport(app=app)
        headers = {"Authorization": f"Bearer {TOKEN}"}
        async with AsyncClient(transport=transport, base_url="http://runtime.test") as client:
            request = {
                "protocolVersion": 1,
                "taskId": "artifact-task",
                "conversationId": "artifact-conversation",
                "input": "生成文件 | 文件名=report.md | 格式=md | 内容=# C2\n\n生成口令：银色灯塔。",
                "source": "assistant-window",
                "context": {"activePetId": "pet", "locale": "zh-CN", "timezone": "Asia/Shanghai"},
                "knowledgeLibraryIds": [],
                "attachmentIds": [],
            }
            assert (await client.post("/v1/chat", headers=headers, json=request)).status_code == 200
            response = await client.get("/v1/events/artifact-task", headers=headers)
            events = [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]
            created = next(event for event in events if event["type"] == "artifact_created")
            artifact = created["payload"]["artifact"]
            artifact_id = str(artifact["id"])
            preview = await client.post(
                f"/v1/artifacts/{artifact_id}/preview",
                headers=headers,
                json={"conversationId": "artifact-conversation", "offset": 0, "limit": 10},
            )
            assert preview.status_code == 200
            denied = await client.get(
                f"/v1/artifacts/{artifact_id}?conversationId=other-conversation",
                headers=headers,
            )
            assert denied.status_code == 404
            content = await client.get(
                f"/v1/artifacts/{artifact_id}/content?conversationId=artifact-conversation",
                headers=headers,
            )
            saved = await client.post(
                f"/v1/artifacts/{artifact_id}/saved",
                headers=headers,
                json={"conversationId": "artifact-conversation"},
            )
            history = await client.get(
                "/v1/memory/conversation/artifact-conversation",
                headers=headers,
            )
            deleted = await client.request(
                "DELETE",
                "/v1/memory/item",
                headers=headers,
                json={"kind": "conversation", "id": "artifact-conversation"},
            )
            assert deleted.json()["deleted"] is True
            return events, history.json(), content.content, saved.json()

    events, history, content, saved = asyncio.run(scenario())
    artifact = next(event for event in events if event["type"] == "artifact_created")["payload"]["artifact"]
    assert artifact["status"] == "ready"
    assert artifact["messageId"] == "artifact-task"
    assert "银色灯塔" in content.decode("utf-8")
    assert saved["saved"] is True
    assert history["messages"][-1]["artifacts"][0]["saved"] is True
    assert not (artifact_root / str(artifact["id"])).exists()
