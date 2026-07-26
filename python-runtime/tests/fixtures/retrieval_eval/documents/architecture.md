# PetDock 助手架构

Electron Main 启动 Python Runtime。聊天接口通过 SSE 流式返回消息，Renderer 不直接访问 Runtime。

知识库原文和 FTS5 索引保存在 SQLite，派生向量持久化到 Chroma。切换向量模型时使用独立的 Index Signature 重建 collection。

