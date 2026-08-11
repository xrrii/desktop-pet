from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[1] / "python-runtime"
sys.path.insert(0, str(RUNTIME_ROOT))

from petdock_runtime.knowledge.service import KnowledgeService  # noqa: E402
from petdock_runtime.knowledge.store import KnowledgeStore  # noqa: E402
from petdock_runtime.providers.embeddings import LocalHashEmbedding  # noqa: E402
from petdock_runtime.rag.planner import plan_retrieval  # noqa: E402
from petdock_runtime.rag.vector_store import ChromaVectorStore  # noqa: E402


def parse_args() -> argparse.Namespace:
    """解析评测集和报告输出位置。"""
    default_dataset = RUNTIME_ROOT / "tests" / "fixtures" / "retrieval_eval"
    parser = argparse.ArgumentParser(description="评测 PetDock RAG 路由和最终召回。")
    parser.add_argument("--dataset", type=Path, default=default_dataset)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "outputs" / "rag-eval" / "rag-v2.json",
    )
    return parser.parse_args()


def load_queries(path: Path) -> list[dict[str, Any]]:
    """逐行读取 JSONL，数据错误时保留准确行号。"""
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"评测集第 {line_number} 行不是有效 JSON。") from error
        if not isinstance(value, dict):
            raise ValueError(f"评测集第 {line_number} 行必须是 JSON 对象。")
        rows.append(value)
    return rows


async def evaluate(dataset: Path) -> dict[str, Any]:
    """建立临时 Hash/FTS5 索引并计算确定性指标。"""
    queries = load_queries(dataset / "queries.jsonl")
    route_correct = 0
    tool_skip_total = 0
    tool_false_retrieval = 0
    zero_total = 0
    zero_correct = 0
    relevant_total = 0
    relevant_found = 0
    precision_sum = 0.0
    reciprocal_rank_sum = 0.0
    failures: list[dict[str, Any]] = []
    evaluations: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory(prefix="petdock-rag-eval-") as temporary:
        root = Path(temporary)
        store = KnowledgeStore(str(root / "knowledge.db"))
        service = KnowledgeService(
            store,
            ChromaVectorStore(":memory:", LocalHashEmbedding()),
        )
        library = await service.create_library("retrieval-eval", str(dataset / "documents"))
        library_id = str(library["id"])
        for _ in range(300):
            if store.get_library(library_id)["status"] != "indexing":
                break
            await asyncio.sleep(0.02)
        if store.get_library(library_id)["status"] != "ready":
            raise RuntimeError(f"评测知识库索引失败：{store.get_library(library_id)['error']}")

        for row in queries:
            query = str(row["query"])
            expected_route = str(row["expectedRoute"])
            plan = plan_retrieval(query, [library_id])
            if plan.route == expected_route:
                route_correct += 1
            else:
                failures.append(
                    {"id": row["id"], "kind": "route", "expected": expected_route, "actual": plan.route}
                )
            tags = set(row.get("tags", []))
            if "tool" in tags and expected_route in {"SKIP", "CLARIFY"}:
                tool_skip_total += 1
                if plan.route in {"RETRIEVE", "BOTH"}:
                    tool_false_retrieval += 1

            sources = []
            if plan.route in {"RETRIEVE", "BOTH"}:
                sources = await service.search(plan.retrieval_query, [library_id])
            actual_paths = [source.relative_path for source in sources]
            expected_paths = set(row.get("relevantDocumentPaths", []))
            evaluations.append(
                {
                    "id": row["id"],
                    "route": plan.route,
                    "expectedPaths": sorted(expected_paths),
                    "actualPaths": actual_paths,
                    "actualScores": [round(source.score, 6) for source in sources],
                }
            )
            if bool(row.get("noAnswer")) and expected_route in {"RETRIEVE", "BOTH"}:
                zero_total += 1
                if not sources:
                    zero_correct += 1
                else:
                    failures.append(
                        {"id": row["id"], "kind": "zero-result", "actual": actual_paths}
                    )
            if expected_paths:
                relevant_total += 1
                matched = [path for path in actual_paths if path in expected_paths]
                if matched:
                    relevant_found += 1
                    reciprocal_rank_sum += 1.0 / (actual_paths.index(matched[0]) + 1)
                precision_sum += len(matched) / max(1, len(actual_paths))
                if not matched:
                    failures.append(
                        {"id": row["id"], "kind": "recall", "expected": sorted(expected_paths), "actual": actual_paths}
                    )
        await service.close()

    count = len(queries)
    metrics = {
        "routeAccuracy": route_correct / max(1, count),
        "toolFalseRetrievalRate": tool_false_retrieval / max(1, tool_skip_total),
        "zeroResultAccuracy": zero_correct / max(1, zero_total),
        "finalDocumentRecall": relevant_found / max(1, relevant_total),
        "precisionAt3": precision_sum / max(1, relevant_total),
        "mrrAt3": reciprocal_rank_sum / max(1, relevant_total),
    }
    return {
        "pipelineVersion": "rag-v2",
        "embeddingProfile": LocalHashEmbedding.name,
        "queryCount": count,
        "metrics": metrics,
        "failures": failures,
        "evaluations": evaluations,
    }


def main() -> int:
    """执行评测、保存 UTF-8 报告并输出摘要。"""
    args = parse_args()
    report = asyncio.run(evaluate(args.dataset.resolve()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report["metrics"], ensure_ascii=False, indent=2))
    print(f"Report: {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
