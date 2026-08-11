from __future__ import annotations

from .planner import retrieval_terms

"""知识库和附件检索共用的基础评分函数。"""


def normalized_similarity(similarity: float, minimum: float) -> float:
    """把不同模型的候选门槛映射到 0-1 区间。"""
    if similarity <= minimum:
        return 0.0
    return min(1.0, (similarity - minimum) / max(1e-6, 1.0 - minimum))


def content_similarity(left: str, right: str) -> float:
    """用稳定词元 Jaccard 判断相邻或模板 Chunk 是否重复。"""
    left_terms = set(retrieval_terms(left, max_terms=128))
    right_terms = set(retrieval_terms(right, max_terms=128))
    if not left_terms or not right_terms:
        return 0.0
    return len(left_terms & right_terms) / len(left_terms | right_terms)
