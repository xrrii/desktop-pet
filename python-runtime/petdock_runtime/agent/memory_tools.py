from __future__ import annotations

from ..memory.store import MemoryStore

"""Runtime 内部长期记忆工具的执行逻辑。"""


def execute_memory_tool(store: MemoryStore, name: str, args: dict[str, object]) -> str:
    """执行内部记忆工具，不经过 Electron OS 权限边界。"""
    if name == "remember_preference":
        value = args.get("content")
        if not isinstance(value, str) or not value.strip():
            return "未保存：记忆内容为空。"
        saved = store.remember_preference(value, source="assistant-tool")
        return f"已记住：{value.strip()[:500]}" if saved else "未保存：内容为空或包含敏感信息。"
    if name == "forget_memory":
        memory_id = args.get("memoryId")
        if not isinstance(memory_id, str) or not memory_id.isdigit():
            return "未删除：记忆 ID 无效。"
        return "已删除这条记忆。" if store.delete_item("memory", memory_id) else "未找到这条记忆。"
    memories = store.snapshot()["memories"]
    if not memories:
        return "当前没有已确认的长期偏好。"
    return "当前长期偏好：" + "；".join(f"#{item['id']} {item['value']}" for item in memories[:20])
