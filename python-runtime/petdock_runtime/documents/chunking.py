from __future__ import annotations

import re
from collections.abc import Callable

"""附件临时索引与长期知识库共用的文档分块策略。"""

CHUNK_STRATEGY_VERSION = "v2"
CHUNK_TARGET_TOKENS = 320
CHUNK_MAX_TOKENS = 448
CHUNK_OVERLAP_CHARACTERS = 96


def split_document(
    content: str,
    count_tokens: Callable[[str], int],
) -> list[tuple[str, int]]:
    """按逻辑块和模型 Token 上限切分文档，仅在超长块中保留重叠。"""
    normalized = content.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []
    blocks = _logical_blocks(normalized)
    chunks: list[tuple[str, int]] = []
    current = ""
    for block in blocks:
        block_tokens = count_tokens(block)
        if block_tokens > CHUNK_MAX_TOKENS:
            if current:
                chunks.append((current, count_tokens(current)))
                current = ""
            chunks.extend(_split_oversized_block(block, count_tokens))
            continue
        candidate = f"{current}\n\n{block}" if current else block
        if not current or count_tokens(candidate) <= CHUNK_TARGET_TOKENS:
            current = candidate
            continue
        chunks.append((current, count_tokens(current)))
        current = block
    if current:
        chunks.append((current, count_tokens(current)))
    return [(text, tokens) for text, tokens in chunks if text.strip()]


def _logical_blocks(content: str) -> list[str]:
    """保留 Markdown 标题和代码围栏，将普通内容按空行组织为逻辑块。"""
    blocks: list[str] = []
    buffer: list[str] = []
    in_fence = False
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            buffer.append(line)
            if not in_fence:
                blocks.append("\n".join(buffer).strip())
                buffer = []
            continue
        if not in_fence and re.match(r"^#{1,6}\s+", stripped):
            if buffer:
                blocks.append("\n".join(buffer).strip())
            buffer = [line]
            continue
        if not in_fence and not stripped:
            if buffer:
                blocks.append("\n".join(buffer).strip())
                buffer = []
            continue
        buffer.append(line)
    if buffer:
        blocks.append("\n".join(buffer).strip())
    return [block for block in blocks if block]


def _split_oversized_block(
    block: str,
    count_tokens: Callable[[str], int],
) -> list[tuple[str, int]]:
    """使用二分边界切分超长结构块，避免超过 Embedding 最大输入。"""
    chunks: list[tuple[str, int]] = []
    start = 0
    while start < len(block):
        low = start + 1
        high = len(block)
        best = low
        while low <= high:
            middle = (low + high) // 2
            if count_tokens(block[start:middle]) <= CHUNK_MAX_TOKENS:
                best = middle
                low = middle + 1
            else:
                high = middle - 1
        end = _prefer_boundary(block, start, best)
        text = block[start:end].strip()
        if text:
            chunks.append((text, count_tokens(text)))
        if end >= len(block):
            break
        start = max(end - CHUNK_OVERLAP_CHARACTERS, start + 1)
    return chunks


def _prefer_boundary(text: str, start: int, end: int) -> int:
    """在二分得到的安全范围内优先选择换行或句末。"""
    search_start = max(start + 1, end - 120)
    positions = [text.rfind(marker, search_start, end) for marker in ("\n", "。", "；", ";", ". ")]
    boundary = max(positions)
    return boundary + 1 if boundary >= search_start else end
