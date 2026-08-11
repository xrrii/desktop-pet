from __future__ import annotations

import asyncio
import json
import os
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from petdock_runtime.config import RuntimeConfig
from petdock_runtime.agent.langchain_backend import LangChainBackend
from petdock_runtime.providers.embeddings import LocalHashEmbedding
from petdock_runtime.knowledge.service import KnowledgeService
from petdock_runtime.knowledge.store import KnowledgeStore
from petdock_runtime.memory.store import MemoryStore
from petdock_runtime.protocol import AssistantRequest
from petdock_runtime.api.server import create_app
from petdock_runtime.agent.service import AssistantService
from petdock_runtime.rag.vector_store import ChromaVectorStore
from petdock_runtime.skills.installer import SkillInstaller, _parse_github_url, _safe_extract_zip
from petdock_runtime.skills.manifest import (
    SkillManifestError,
    load_skill_instructions,
    parse_skill_metadata,
)
from petdock_runtime.skills.registry import SkillRegistry
from petdock_runtime.skills.store import SkillStore

TOKEN = "s" * 64


def _write_skill(root: Path, name: str = "weekly-report", with_script: bool = False) -> Path:
    """创建用于 Runtime 测试的最小 Agent Skill。"""
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        "---\n"
        f"name: {name}\n"
        "description: 根据工作记录整理结构化周报。\n"
        "---\n\n"
        "# 周报\n\n读取 references/format.md 后整理用户输入。\n",
        encoding="utf-8",
    )
    references = root / "references"
    references.mkdir()
    (references / "format.md").write_text("完成事项、风险、下周计划", encoding="utf-8")
    if with_script:
        scripts = root / "scripts"
        scripts.mkdir()
        (scripts / "run.py").write_text("print('不能自动执行')", encoding="utf-8")
    return root


def test_metadata_scan_does_not_read_skill_body(tmp_path: Path) -> None:
    """启动元数据扫描不能因为正文无效字节而读取整个文件。"""
    skill = tmp_path / "skill"
    skill.mkdir()
    path = skill / "SKILL.md"
    path.write_bytes(
        b"---\nname: safe-skill\ndescription: metadata only\n---\n\n" + b"\xff" * 100
    )
    metadata = parse_skill_metadata(path)
    assert metadata.name == "safe-skill"
    with pytest.raises(SkillManifestError) as error:
        load_skill_instructions(metadata)
    assert error.value.code == "skill_invalid_manifest"


def test_registry_progressively_loads_instructions_and_resources(tmp_path: Path) -> None:
    """注册表仅披露元数据，激活后才读取正文和目标资源。"""
    packages = tmp_path / "packages"
    _write_skill(packages / "weekly-report")
    store = SkillStore(str(tmp_path / "skills.db"))
    registry = SkillRegistry(str(packages), store)
    snapshot = registry.snapshot()
    assert snapshot["skills"][0]["description"] == "根据工作记录整理结构化周报。"
    assert "# 周报" not in json.dumps(snapshot, ensure_ascii=False)
    activation = registry.activate("weekly-report")
    assert "# 周报" in activation.instructions
    assert registry.read_resource("weekly-report", "references/format.md") == "完成事项、风险、下周计划"
    with pytest.raises(SkillManifestError) as error:
        registry.read_resource("weekly-report", "../secret.txt")
    assert error.value.code == "skill_resource_denied"
    assert registry.set_enabled("weekly-report", False)
    with pytest.raises(SkillManifestError) as disabled:
        registry.activate("weekly-report")
    assert disabled.value.code == "skill_disabled"
    registry.close()


def test_local_installer_previews_installs_and_uninstalls(tmp_path: Path) -> None:
    """本地安装必须经过预览、摘要复核、原子复制和热刷新。"""
    source = _write_skill(tmp_path / "source", with_script=True)
    packages = tmp_path / "managed" / "packages"
    store = SkillStore(str(tmp_path / "skills.db"))
    registry = SkillRegistry(str(packages), store)
    installer = SkillInstaller(str(packages), registry)
    preview = installer.preview_local(str(source))
    assert preview["candidates"][0]["compatibility"] == "instruction-only"
    result = installer.install(str(preview["previewToken"]), ["weekly-report"])
    assert result["installed"] == ["weekly-report"]
    assert (packages / "weekly-report" / "SKILL.md").exists()
    assert registry.snapshot()["skills"][0]["sourceType"] == "local"
    assert "# 周报" in registry.activate("weekly-report").instructions
    assert installer.uninstall("weekly-report")
    assert registry.snapshot()["skills"] == []
    registry.close()


def test_install_preview_detects_source_changes(tmp_path: Path) -> None:
    """用户确认前来源发生变化时必须拒绝安装。"""
    source = _write_skill(tmp_path / "source")
    packages = tmp_path / "managed" / "packages"
    registry = SkillRegistry(str(packages), SkillStore(str(tmp_path / "skills.db")))
    installer = SkillInstaller(str(packages), registry)
    preview = installer.preview_local(str(source))
    (source / "references" / "format.md").write_text("已被修改", encoding="utf-8")
    with pytest.raises(SkillManifestError) as error:
        installer.install(str(preview["previewToken"]), ["weekly-report"])
    assert error.value.code == "skill_content_changed"
    registry.close()


def test_multi_skill_install_preflights_all_candidates(tmp_path: Path) -> None:
    """多候选必须全部通过摘要复核后才能写入第一个正式包。"""
    source = tmp_path / "source"
    _write_skill(source / "a-skill", name="a-skill")
    changed = _write_skill(source / "z-skill", name="z-skill")
    packages = tmp_path / "managed" / "packages"
    registry = SkillRegistry(str(packages), SkillStore(str(tmp_path / "skills.db")))
    installer = SkillInstaller(str(packages), registry)
    preview = installer.preview_local(str(source))
    (changed / "references" / "format.md").write_text("确认前已变化", encoding="utf-8")

    with pytest.raises(SkillManifestError) as error:
        installer.install(str(preview["previewToken"]), ["a-skill", "z-skill"])

    assert error.value.code == "skill_content_changed"
    assert not (packages / "a-skill").exists()
    registry.close()


def test_multi_skill_install_rolls_back_replaced_packages(tmp_path: Path, monkeypatch) -> None:
    """批量替换中途出现文件系统错误时必须删除本批次已落盘内容。"""
    source = tmp_path / "source"
    _write_skill(source / "a-skill", name="a-skill")
    _write_skill(source / "z-skill", name="z-skill")
    packages = tmp_path / "managed" / "packages"
    registry = SkillRegistry(str(packages), SkillStore(str(tmp_path / "skills.db")))
    installer = SkillInstaller(str(packages), registry)
    preview = installer.preview_local(str(source))
    original_replace = os.replace
    failed = False

    def fail_second_package(source_path, target_path) -> None:
        """只让第二个暂存包的首次交换失败，允许安装器执行回滚。"""
        nonlocal failed
        if Path(source_path).name == "z-skill" and not failed:
            failed = True
            raise OSError("模拟批量安装中断")
        original_replace(source_path, target_path)

    monkeypatch.setattr("petdock_runtime.skills.installer.os.replace", fail_second_package)
    with pytest.raises(OSError, match="模拟批量安装中断"):
        installer.install(str(preview["previewToken"]), ["a-skill", "z-skill"])

    assert not (packages / "a-skill").exists()
    assert not (packages / "z-skill").exists()
    registry.close()


def test_github_url_and_zip_security(tmp_path: Path) -> None:
    """GitHub URL 和 ZIP 条目不能携带凭据或路径穿越。"""
    assert _parse_github_url("https://github.com/example/skills") == (
        "example",
        "skills",
        "",
        "",
    )
    assert _parse_github_url("https://github.com/example/skills/tree/main/docs") == (
        "example",
        "skills",
        "main",
        "docs",
    )
    with pytest.raises(SkillManifestError):
        _parse_github_url("https://user:token@github.com/example/skills")
    archive = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("../escape.txt", "bad")
    with pytest.raises(SkillManifestError) as error:
        _safe_extract_zip(archive, tmp_path / "extract")
    assert error.value.code == "github_archive_invalid"
    assert not (tmp_path / "escape.txt").exists()
    windows_archive = tmp_path / "unsafe-windows.zip"
    with zipfile.ZipFile(windows_archive, "w") as output:
        output.writestr("repository\\..\\escape.txt", "bad")
    with pytest.raises(SkillManifestError):
        _safe_extract_zip(windows_archive, tmp_path / "extract-windows")


def test_skill_api_and_explicit_mock_invocation(tmp_path: Path) -> None:
    """验证 Skill API 鉴权、启停和显式调用结构化事件。"""
    packages = tmp_path / "skills" / "packages"
    _write_skill(packages / "weekly-report")
    config = RuntimeConfig(
        token=TOKEN,
        resolved_backend="mock",
        api_key=None,
        base_url=None,
        model="unused",
        memory_db_path=str(tmp_path / "memory.db"),
        knowledge_db_path=str(tmp_path / "knowledge.db"),
        chroma_path=str(tmp_path / "chroma"),
        skills_db_path=str(tmp_path / "skills.db"),
        skills_root=str(packages),
    )

    async def scenario() -> tuple[int, list[dict[str, object]], bool]:
        transport = ASGITransport(app=create_app(config))
        headers = {"Authorization": f"Bearer {TOKEN}"}
        async with AsyncClient(transport=transport, base_url="http://runtime.test") as client:
            unauthorized = await client.get("/v1/skills")
            snapshot = await client.get("/v1/skills", headers=headers)
            assert snapshot.json()["skills"][0]["name"] == "weekly-report"
            request = AssistantRequest(
                protocolVersion=1,
                taskId="skill-task",
                conversationId="skill-conversation",
                input="整理这些工作记录",
                source="assistant-window",
                context={"activePetId": "pet", "locale": "zh-CN", "timezone": "Asia/Shanghai"},
                skillInvocation={"skillId": "weekly-report"},
            )
            await client.post("/v1/chat", headers=headers, json=request.model_dump())
            response = await client.get("/v1/events/skill-task", headers=headers)
            events = [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]
            disabled = await client.post("/v1/skills/weekly-report/disable", headers=headers)
            return unauthorized.status_code, events, disabled.json()["updated"]

    unauthorized, events, disabled = asyncio.run(scenario())
    assert unauthorized == 401
    assert disabled
    assert any(event["type"] == "skill_started" for event in events)
    assert any(event["type"] == "skill_completed" for event in events)


def test_langchain_progressive_disclosure_and_permission_denial(tmp_path: Path) -> None:
    """模型激活前只能看到元数据，激活后才看到正文且不能越权调用 OS 工具。"""
    packages = tmp_path / "skills" / "packages"
    _write_skill(packages / "weekly-report")
    registry = SkillRegistry(str(packages), SkillStore(str(tmp_path / "skills.db")))
    memory = MemoryStore(str(tmp_path / "memory.db"))
    knowledge = KnowledgeService(
        KnowledgeStore(str(tmp_path / "knowledge.db")),
        ChromaVectorStore(str(tmp_path / "chroma"), LocalHashEmbedding()),
    )
    config = RuntimeConfig(
        token=TOKEN,
        resolved_backend="langchain",
        api_key="test-key",
        base_url="http://127.0.0.1:1/v1",
        model="fake-model",
    )
    backend = LangChainBackend(config, memory, knowledge, registry)

    class FakeModel:
        """按激活、越权工具和最终回复三轮返回固定流片段。"""

        def __init__(self) -> None:
            self.messages: list[list[object]] = []

        async def astream(self, messages):
            self.messages.append(list(messages))
            round_index = len(self.messages)
            if round_index == 1:
                yield SimpleNamespace(
                    content="",
                    tool_call_chunks=[
                        {"index": 0, "id": "call-activate", "name": "activate_skill", "args": '{"name":"weekly-report"}'}
                    ],
                )
            elif round_index == 2:
                yield SimpleNamespace(
                    content="",
                    tool_call_chunks=[
                        {"index": 0, "id": "call-url", "name": "open_url", "args": '{"url":"https://example.com"}'}
                    ],
                )
            else:
                yield SimpleNamespace(content="权限已拒绝，已继续整理周报。", tool_call_chunks=[])

    fake_model = FakeModel()
    backend._model = fake_model  # type: ignore[assignment]  # 测试替换真实网络模型。
    request = AssistantRequest(
        protocolVersion=1,
        taskId="agent-skill-task",
        conversationId="agent-skill-conversation",
        input="请使用合适技能整理周报",
        source="assistant-window",
        context={"activePetId": "pet", "locale": "zh-CN", "timezone": "Asia/Shanghai"},
    )

    async def scenario() -> list[dict[str, object]]:
        service = AssistantService(backend)
        service.start(request)
        events = [event async for event in service.events(request.taskId)]
        await knowledge.close()
        return events

    events = asyncio.run(scenario())
    first_context = "\n".join(str(message.content) for message in fake_model.messages[0])
    second_context = "\n".join(str(message.content) for message in fake_model.messages[1])
    assert "weekly-report" in first_context
    assert "# 周报" not in first_context
    assert "# 周报" in second_context
    assert any(event["type"] == "skill_started" for event in events)
    assert not any(event["type"] == "tool_call" for event in events)
    assert any("权限已拒绝" in event["payload"].get("delta", "") for event in events)
    memory.close()
    registry.close()
