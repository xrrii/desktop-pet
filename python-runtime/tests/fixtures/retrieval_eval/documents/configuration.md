# Runtime 配置

PETDOCK_CHROMA_PATH 指定 Chroma 持久化目录，PETDOCK_KNOWLEDGE_DB_PATH 指定 SQLite 知识库文件。

RuntimeConfig.from_environment 负责读取环境变量。LocalHashEmbedding 是无模型下载时的兜底 Provider。

