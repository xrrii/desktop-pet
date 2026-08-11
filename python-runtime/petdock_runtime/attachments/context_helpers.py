from __future__ import annotations

import hashlib
import json

from .store import AttachmentRecord

"""附件索引与资料集分析共用的结构位置辅助逻辑。"""


def record_blocks(record: AttachmentRecord) -> list[dict[str, object]]:
    """读取附件结构块，旧 C1 文本记录自动转换为单块。"""
    try:
        value = json.loads(record.blocks_json)
    except (TypeError, ValueError):
        value = []
    blocks: list[dict[str, object]] = []
    if isinstance(value, list):
        for item in value:
            if not isinstance(item, dict) or not isinstance(item.get("content"), str):
                continue
            location = item.get("location") if isinstance(item.get("location"), dict) else {}
            blocks.append({"content": item["content"], "location": dict(location)})
    if not blocks and record.text_content.strip():
        blocks.append(
            {
                "content": record.text_content,
                "location": {
                    "kind": "text",
                    "value": "document",
                    "page": None,
                    "headingPath": [],
                    "paragraph": None,
                    "sheet": None,
                    "cellRange": None,
                    "slide": None,
                },
            }
        )
    return blocks


def enrich_location(location: dict[str, object], block_index: int) -> dict[str, object]:
    """保留文档结构位置并增加可定位的块号。"""
    result = dict(location)
    result["block"] = block_index
    return result


def location_label(location: dict[str, object]) -> str:
    """把结构位置转换为模型引用使用的短标签。"""
    if isinstance(location.get("page"), int):
        return f"第 {location['page']} 页，块 {location.get('block', 1)}"
    sheet = location.get("sheet")
    if isinstance(sheet, str) and sheet:
        cell_range = location.get("cellRange")
        return f"工作表 {sheet}" + (
            f"，区域 {cell_range}" if isinstance(cell_range, str) and cell_range else ""
        )
    slide = location.get("slide")
    if isinstance(slide, int):
        return f"幻灯片 {slide}，块 {location.get('block', 1)}"
    heading_path = location.get("headingPath")
    paragraph = location.get("paragraph")
    heading = " / ".join(str(item) for item in heading_path) if isinstance(heading_path, list) else ""
    if heading and isinstance(paragraph, int):
        return f"{heading}，段落 {paragraph}，块 {location.get('block', 1)}"
    line_start = location.get("lineStart")
    line_end = location.get("lineEnd")
    if isinstance(line_start, int):
        return f"第 {line_start}-{line_end or line_start} 行"
    return f"块 {location.get('block', 1)}"


def short_hash(value: str) -> str:
    """生成日志可关联但不可逆的会话标识。"""
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:12]
