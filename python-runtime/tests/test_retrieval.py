from __future__ import annotations

import asyncio
import sqlite3

import pytest

from petdock_runtime.embeddings import LocalHashEmbedding, descriptor_from_dict
from petdock_runtime.knowledge import ChromaVectorStore, KnowledgeService
from petdock_runtime.knowledge_store import KnowledgeStore
from petdock_runtime.retrieval import plan_retrieval, retrieval_query_terms, retrieval_terms


class ConstantSemanticEmbedding:
    """模拟余弦分数极高但不具备领域判别力的语义向量模型。"""

    def __init__(self) -> None:
        """创建与真实语义 Provider 阈值一致的测试描述。"""
        self.descriptor = descriptor_from_dict(
            {
                "id": "test-constant-semantic",
                "revision": "1",
                "dimensions": 64,
                "maxTokens": 512,
                "pooling": "mean",
                "normalize": True,
                "candidateMinSimilarity": 0.45,
                "finalMinSimilarity": 0.62,
            }
        )

    def health_check(self) -> None:
        """常量测试向量不依赖外部模型文件，无需额外健康检查。"""

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """让所有文档返回相同归一化向量，稳定复现高分误召回。"""
        return [self._vector() for _ in texts]

    def embed_query(self, text: str) -> list[float]:
        """让任意查询与文档的余弦相似度固定为 1。"""
        return self._vector()

    def count_tokens(self, text: str) -> int:
        """提供足够稳定的测试分块 Token 估算。"""
        return max(1, len(text))

    @staticmethod
    def _vector() -> list[float]:
        """返回 64 维单位向量。"""
        return [1.0] + [0.0] * 63


@pytest.mark.parametrize(
    ("query", "expected_route"),
    [
        ("打开网站 https://example.com", "SKIP"),
        ("你好", "SKIP"),
        ("发布口令是什么", "RETRIEVE"),
        ("打开项目文档里提到的网址", "BOTH"),
        ("打开网站", "CLARIFY"),
    ],
)
def test_retrieval_router_avoids_unnecessary_search(query: str, expected_route: str) -> None:
    """验证纯工具与寒暄不会检索，知识问题和依赖资料的工具请求正确分流。"""
    plan = plan_retrieval(query, ["library-1"])
    assert plan.route == expected_route


def test_retrieval_terms_keep_chinese_bigrams_and_code_identifiers() -> None:
    """验证中文短语和代码标识符可进入 FTS5 兼容词元。"""
    terms = retrieval_terms("查找 RuntimeConfig 中的 PETDOCK_CHROMA_PATH 配置")
    assert "runtimeconfig" in terms
    assert "petdock_chroma_path" in terms
    assert "配置" in terms
    assert {"写入", "目录"} <= set(retrieval_query_terms("产物保存在哪里"))


def test_no_answer_query_returns_zero_sources(tmp_path) -> None:
    """验证最终准入允许无答案问题返回零条来源。"""

    async def scenario() -> list[str]:
        source = tmp_path / "notes"
        source.mkdir()
        (source / "release.md").write_text("发布口令是蓝色月亮。", encoding="utf-8")
        store = KnowledgeStore(str(tmp_path / "knowledge.db"))
        service = KnowledgeService(
            store,
            ChromaVectorStore(str(tmp_path / "chroma"), LocalHashEmbedding()),
        )
        library = await service.create_library("发布资料", str(source))
        for _ in range(100):
            if store.get_library(str(library["id"]))["status"] != "indexing":
                break
            await asyncio.sleep(0.02)
        sources = await service.search("量子发动机维护周期是多少", [str(library["id"])])
        await service.close()
        return [item.content for item in sources]

    assert asyncio.run(scenario()) == []


def test_shared_generic_term_does_not_cross_retrieve_domains(tmp_path) -> None:
    """验证生活用品清洗问题不会因“清洗”一词命中数据清洗文档。"""

    async def scenario() -> list[str]:
        source = tmp_path / "data-docs"
        source.mkdir()
        (source / "cleaning.md").write_text(
            "# 清洗流与数据模型\n\n数据清洗用于字段标准化和空值处理，配置文档描述清洗任务。",
            encoding="utf-8",
        )
        store = KnowledgeStore(str(tmp_path / "domain.db"))
        service = KnowledgeService(
            store,
            ChromaVectorStore(str(tmp_path / "domain-chroma"), LocalHashEmbedding()),
        )
        library = await service.create_library("数据文档", str(source))
        for _ in range(100):
            if store.get_library(str(library["id"]))["status"] != "indexing":
                break
            await asyncio.sleep(0.02)
        sources = await service.search("洗衣机应该怎么清洗", [str(library["id"])])
        await service.close()
        return [item.content for item in sources]

    assert asyncio.run(scenario()) == []


def test_high_vector_similarity_without_query_anchor_is_rejected(tmp_path) -> None:
    """验证语义相似度再高，零查询锚点的跨领域文档也不能进入最终来源。"""

    async def scenario() -> tuple[list[str], int, int, dict[str, int]]:
        """建立只有无关短标题的知识库，并返回完整检索诊断。"""
        source = tmp_path / "release-docs"
        source.mkdir()
        (source / "04-release.md").write_text("# 发布、代码生成与部署", encoding="utf-8")
        store = KnowledgeStore(str(tmp_path / "semantic.db"))
        vectors = ChromaVectorStore(
            str(tmp_path / "semantic-chroma"),
            ConstantSemanticEmbedding(),
        )
        service = KnowledgeService(store, vectors)
        library = await service.create_library("dataflow-web-docs", str(source))
        for _ in range(100):
            if store.get_library(str(library["id"]))["status"] != "indexing":
                break
            await asyncio.sleep(0.02)

        result = await service.search_with_trace("洗衣机改如何清洗", [str(library["id"])])
        await service.close()
        return (
            [item.content for item in result.sources],
            result.trace.vector_candidates,
            result.trace.lexical_candidates,
            result.trace.rejection_counts,
        )

    sources, vector_candidates, lexical_candidates, rejection_counts = asyncio.run(scenario())
    assert sources == []
    assert vector_candidates == 1
    assert lexical_candidates == 0
    assert rejection_counts == {"零查询锚点": 1}


def test_semantic_candidate_with_enough_query_anchors_is_accepted(tmp_path) -> None:
    """验证收紧向量准入后，具备足够查询锚点的真实相关资料仍能召回。"""

    async def scenario() -> list[str]:
        """建立洗衣机清洗资料并执行一次混合检索。"""
        source = tmp_path / "laundry-docs"
        source.mkdir()
        (source / "washing-machine.md").write_text(
            "# 洗衣机清洗\n\n洗衣机内筒可以使用专用清洁剂定期清洗。",
            encoding="utf-8",
        )
        store = KnowledgeStore(str(tmp_path / "laundry.db"))
        service = KnowledgeService(
            store,
            ChromaVectorStore(str(tmp_path / "laundry-chroma"), ConstantSemanticEmbedding()),
        )
        library = await service.create_library("家电资料", str(source))
        for _ in range(100):
            if store.get_library(str(library["id"]))["status"] != "indexing":
                break
            await asyncio.sleep(0.02)

        sources = await service.search("洗衣机应该如何清洗", [str(library["id"])])
        await service.close()
        return [item.content for item in sources]

    contents = asyncio.run(scenario())
    assert len(contents) == 1
    assert "洗衣机内筒" in contents[0]


def test_stage4_database_migrates_embedding_and_fts_columns(tmp_path) -> None:
    """验证旧知识库补齐索引签名、Chunk 版本和加权 FTS5 字段。"""
    database = tmp_path / "legacy.db"
    connection = sqlite3.connect(database)
    connection.executescript(
        """
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE knowledge_libraries (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, source_path TEXT NOT NULL UNIQUE,
            display_path TEXT NOT NULL, status TEXT NOT NULL, document_count INTEGER NOT NULL DEFAULT 0,
            chunk_count INTEGER NOT NULL DEFAULT 0, processed_files INTEGER NOT NULL DEFAULT 0,
            total_files INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, last_indexed_at TEXT
        );
        CREATE TABLE documents (
            id TEXT PRIMARY KEY, library_id TEXT NOT NULL, relative_path TEXT NOT NULL,
            title TEXT NOT NULL, content_hash TEXT NOT NULL, modified_ns INTEGER NOT NULL,
            size_bytes INTEGER NOT NULL, embedding_state TEXT NOT NULL, indexed_at TEXT NOT NULL,
            UNIQUE(library_id, relative_path)
        );
        CREATE TABLE document_chunks (
            id TEXT PRIMARY KEY, document_id TEXT NOT NULL, library_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL, content TEXT NOT NULL, token_count INTEGER NOT NULL,
            UNIQUE(document_id, chunk_index)
        );
        CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
            chunk_id UNINDEXED, library_id UNINDEXED, content, tokenize='unicode61'
        );
        """
    )
    connection.close()

    store = KnowledgeStore(str(database))
    document_columns = {
        row["name"] for row in store._connection.execute("PRAGMA table_info(documents)").fetchall()
    }
    fts_columns = [
        row["name"]
        for row in store._connection.execute("PRAGMA table_info(document_chunks_fts)").fetchall()
    ]
    store.close()

    assert {"embedding_signature", "chunk_strategy_version"} <= document_columns
    assert fts_columns == [
        "chunk_id",
        "library_id",
        "title",
        "relative_path",
        "content",
        "search_tokens",
    ]


def test_index_signature_changes_with_tokenizer_and_chunk_strategy() -> None:
    """验证会改变向量或分块内容的配置不会错误复用同一 Chroma collection。"""
    base = {
        "id": "test-model",
        "revision": "revision-1",
        "dimensions": 384,
        "maxTokens": 512,
        "pooling": "mean",
        "normalize": True,
        "queryPrefix": "query: ",
        "documentPrefix": "passage: ",
        "tokenizerVersion": "tokenizer-1",
        "chunkStrategyVersion": "v2",
    }
    original = descriptor_from_dict(base)
    changed_tokenizer = descriptor_from_dict({**base, "tokenizerVersion": "tokenizer-2"})
    changed_chunk = descriptor_from_dict({**base, "chunkStrategyVersion": "v3"})
    changed_limit = descriptor_from_dict({**base, "maxTokens": 256})
    assert len({original.signature, changed_tokenizer.signature, changed_chunk.signature, changed_limit.signature}) == 4


def test_primary_index_failure_keeps_hash_fallback_searchable(tmp_path) -> None:
    """验证在线或本地 Provider 写入失败时，Hash 影子索引仍能完成并提供检索。"""

    async def scenario() -> tuple[str, list[str]]:
        source = tmp_path / "fallback-notes"
        source.mkdir()
        (source / "answer.md").write_text("故障降级口令是银色星光。", encoding="utf-8")
        store = KnowledgeStore(str(tmp_path / "fallback.db"))
        primary_embedding = LocalHashEmbedding()
        primary_embedding.descriptor = descriptor_from_dict(
            {
                "id": "test-semantic-provider",
                "revision": "1",
                "dimensions": 384,
                "maxTokens": 512,
                "pooling": "mean",
                "normalize": True,
                "candidateMinSimilarity": 0.16,
                "finalMinSimilarity": 0.24,
            }
        )
        primary = ChromaVectorStore(":memory:", primary_embedding, "test_primary_failure")
        fallback = ChromaVectorStore(":memory:", LocalHashEmbedding(), "test_hash_fallback")

        def fail_primary_upsert(_records) -> None:
            """模拟在线服务在建索引期间不可用。"""
            raise RuntimeError("primary unavailable")

        primary.upsert = fail_primary_upsert  # type: ignore[method-assign]
        service = KnowledgeService(store, primary, fallback)
        library = await service.create_library("降级资料", str(source))
        for _ in range(100):
            if store.get_library(str(library["id"]))["status"] != "indexing":
                break
            await asyncio.sleep(0.02)
        document = store.document_state(str(library["id"]), "answer.md")
        sources = await service.search("故障降级口令是什么", [str(library["id"])])
        await service.close()
        return str(document["embedding_signature"] if document else ""), [item.content for item in sources]

    signature, contents = asyncio.run(scenario())
    assert signature == LocalHashEmbedding().descriptor.signature
    assert "银色星光" in " ".join(contents)
