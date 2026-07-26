from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit

"""RAG 检索路由、查询清洗和稳定词元提取。"""

RetrievalRoute = Literal["SKIP", "RETRIEVE", "BOTH", "CLARIFY"]

URL_PATTERN = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
WINDOWS_PATH_PATTERN = re.compile(r"(?:[a-zA-Z]:\\|\\\\)[^\r\n]+")
OPEN_ACTION_PATTERN = re.compile(
    r"^\s*(?:请|帮我|麻烦)?\s*(?:打开|访问|跳转到|启动|运行|关闭|退出|进入)",
    re.IGNORECASE,
)
KNOWLEDGE_DEPENDENCY_PATTERN = re.compile(
    r"(?:文档|资料|知识库|项目|笔记|说明|README|配置|源码|代码).{0,12}"
    r"(?:提到|记录|写着|里面|中的|里|对应|找到|查找)",
    re.IGNORECASE,
)
FOLLOWUP_TOOL_PATTERN = re.compile(r"(?:并|然后|再|随后)?\s*(?:打开|访问|启动|运行)\s*$")
RETRIEVAL_CUE_PATTERN = re.compile(
    r"(?:什么|为何|为什么|怎么|如何|哪里|哪一|是否|谁|多少|解释|说明|总结|概括|比较|"
    r"区别|查找|搜索|检索|定位|列出|依据|引用|文档|资料|知识库|项目里|代码中|配置中|报错|错误)",
    re.IGNORECASE,
)
GREETING_PATTERN = re.compile(
    r"^\s*(?:你好|您好|嗨|哈喽|hello|hi|谢谢|感谢|好的|好|明白了|知道了|收到|再见|拜拜)[！!。.\s]*$",
    re.IGNORECASE,
)
NON_RETRIEVAL_ACTION_PATTERN = re.compile(
    r"^\s*(?:写|生成|创作|翻译|改写|润色|计算|提醒|播放|暂停|继续|取消|确认)(?!.*(?:文档|资料|知识库|项目))",
    re.IGNORECASE,
)
LEADING_TOOL_WORDS = re.compile(
    r"^\s*(?:请|帮我|麻烦)?\s*(?:打开|访问|跳转到|启动|运行|进入|查找|搜索|检索|找到)\s*",
    re.IGNORECASE,
)
ASCII_TERM_PATTERN = re.compile(r"[a-zA-Z][a-zA-Z0-9_.:/#-]{1,}|\d+(?:\.\d+){0,3}")
CHINESE_PATTERN = re.compile(r"[\u4e00-\u9fff]+")
LOW_INFORMATION_TERMS = {
    "http", "https", "www", "com", "cn", "org", "net", "html",
    "打开", "网站", "网页", "请问", "一下", "这个", "那个", "什么", "怎么", "如何",
    "哪里", "是否", "项目", "文档", "资料", "知识库", "帮我", "麻烦",
}
QUERY_SYNONYMS = {
    "保存": ("写入", "存放", "目录"),
    "返回": ("发送", "流式"),
    "作用": ("指定", "负责"),
    "兜底": ("兼容", "fallback"),
}


@dataclass(frozen=True)
class RetrievalPlan:
    """描述单轮请求是否检索以及实际使用的查询。"""

    route: RetrievalRoute
    reason: str
    confidence: float
    original_query: str
    retrieval_query: str
    exact_terms: tuple[str, ...]
    library_ids: tuple[str, ...]


def plan_retrieval(
    query: str,
    library_ids: list[str],
    *,
    has_tool_result: bool = False,
) -> RetrievalPlan:
    """使用确定性规则生成检索计划，明确工具请求优先跳过知识库。"""
    original = query.strip()
    selected_ids = tuple(dict.fromkeys(library_ids[:20]))
    if has_tool_result:
        return _plan("SKIP", "工具结果续轮不重复检索", 1.0, original, selected_ids)
    if not selected_ids:
        return _plan("SKIP", "没有选择知识库", 1.0, original, selected_ids)
    if GREETING_PATTERN.fullmatch(original):
        return _plan("SKIP", "寒暄或确认消息", 0.99, original, selected_ids)

    contains_url = bool(URL_PATTERN.search(original))
    contains_path = bool(WINDOWS_PATH_PATTERN.search(original))
    tool_action = bool(OPEN_ACTION_PATTERN.search(original))
    knowledge_dependent = bool(KNOWLEDGE_DEPENDENCY_PATTERN.search(original))
    if knowledge_dependent and (tool_action or FOLLOWUP_TOOL_PATTERN.search(original)):
        return _plan("BOTH", "工具参数需要先从知识库确定", 0.96, original, selected_ids)
    if tool_action and (contains_url or contains_path or _looks_like_direct_target(original)):
        return _plan("SKIP", "包含明确目标的桌面工具请求", 0.99, original, selected_ids)
    if tool_action:
        return _plan("CLARIFY", "桌面工具请求缺少明确目标", 0.94, original, selected_ids)
    if NON_RETRIEVAL_ACTION_PATTERN.search(original):
        return _plan("SKIP", "不依赖知识库的生成或控制请求", 0.92, original, selected_ids)
    if RETRIEVAL_CUE_PATTERN.search(original) or original.endswith(("?", "？")):
        return _plan("RETRIEVE", "问题需要知识库依据", 0.9, original, selected_ids)
    return _plan("SKIP", "没有检测到知识库依赖", 0.72, original, selected_ids)


def clean_retrieval_query(query: str) -> str:
    """删除纯工具表达并规范 URL，同时保留域名、路径和代码标识符。"""
    cleaned = LEADING_TOOL_WORDS.sub("", query.strip())

    def replace_url(match: re.Match[str]) -> str:
        """把 URL 转成仍可检索的主机名和路径。"""
        parsed = urlsplit(match.group(0).rstrip("。！!?？,，"))
        return " ".join(part for part in (parsed.hostname or "", parsed.path) if part)

    cleaned = URL_PATTERN.sub(replace_url, cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ，,。；;：:")
    return cleaned or query.strip()


def retrieval_terms(text: str, *, max_terms: int = 24) -> list[str]:
    """提取英文标识符、数字、中文短语和中文二元组，用于混合检索。"""
    lowered = text.casefold()
    terms: list[str] = []
    terms.extend(match.group(0).strip("./:#-") for match in ASCII_TERM_PATTERN.finditer(lowered))
    for sequence in CHINESE_PATTERN.findall(lowered):
        if 2 <= len(sequence) <= 8:
            terms.append(sequence)
        terms.extend(sequence[index : index + 2] for index in range(max(0, len(sequence) - 1)))
    unique: list[str] = []
    for term in terms:
        if len(term) < 2 or term in LOW_INFORMATION_TERMS or term in unique:
            continue
        unique.append(term)
        if len(unique) >= max_terms:
            break
    return unique


def retrieval_query_terms(text: str, *, max_terms: int = 24) -> list[str]:
    """为查询补充少量经过评测的确定性同义词，不改写标识符和否定词。"""
    terms = retrieval_terms(text, max_terms=max_terms)
    expanded = list(terms)
    for cue, synonyms in QUERY_SYNONYMS.items():
        if cue not in text:
            continue
        for synonym in synonyms:
            if synonym not in expanded:
                expanded.append(synonym)
            if len(expanded) >= max_terms:
                return expanded
    return expanded


def _plan(
    route: RetrievalRoute,
    reason: str,
    confidence: float,
    original: str,
    library_ids: tuple[str, ...],
) -> RetrievalPlan:
    """构造包含清洗查询和精确词元的不可变检索计划。"""
    cleaned = clean_retrieval_query(original)
    exact_terms = tuple(
        term for term in retrieval_terms(cleaned) if ASCII_TERM_PATTERN.fullmatch(term)
    )
    return RetrievalPlan(route, reason, confidence, original, cleaned, exact_terms, library_ids)


def _looks_like_direct_target(query: str) -> bool:
    """判断工具动词后是否已经给出应用或普通文件目标。"""
    remainder = OPEN_ACTION_PATTERN.sub("", query, count=1).strip()
    if not remainder or remainder in {"一下", "网站", "网页", "应用", "文件", "文件夹", "目录"}:
        return False
    return not RETRIEVAL_CUE_PATTERN.search(remainder)
