# PetDock Managed Service Provider 与模型消费者盘点

本文档是 `P0-11` 的冻结交付物，用于约束 Phase 1 的抽象范围和回归范围。盘点基于提交 `e778eec8613dedbb892e3242628713fec1974394`。

## 1. 盘点结论

当前真正参与 AI 推理或搜索的消费者分为四类：

| 能力 | 所有进程 | 当前实现 | Phase 1 处理 |
| --- | --- | --- | --- |
| Chat | Python Runtime | `LangChainBackend`、`MemoryExtractor` 分别创建 `ChatOpenAI` | 建立统一 `ChatModelFactory`，覆盖两个消费者 |
| Embedding | Python Runtime | Hash、本地 ONNX、OpenAI-compatible Provider | 保留现有协议，只预留 Managed 装配点 |
| Vision | Python Runtime | `VisionAnalyzer` 直接调用 OpenAI-compatible HTTP 接口 | 保留探测、摘要和缓存，只在 Phase 4 抽离远程适配器 |
| Web Search | Electron Main | 火山引擎、Brave 和 Smoke Provider | 保留 Main 所有权，Phase 4 增加 Managed Provider |

不存在需要迁移到云端的本地 Agent、Memory、RAG、Skill、Artifact 或工具执行器。它们继续消费能力结果，不属于 Managed Provider。

## 2. Chat 消费者

### 2.1 主 Agent

- 入口：`python-runtime/petdock_runtime/agent/langchain_backend.py`
- 当前行为：构造 `ChatOpenAI` 后绑定固定工具，通过 `astream()` 执行最多六轮有限工具循环。
- 输入：系统 Prompt、本地会话历史、RAG 片段、附件上下文和 Skill 指令。
- 输出：文本、ToolCall、引用、Artifact 和 Skill 生命周期事件。
- 约束：Phase 1 只替换模型创建依赖，不改变工具循环、Prompt、历史格式和 SSE 事件。

### 2.2 后台记忆提取

- 入口：`python-runtime/petdock_runtime/memory/extractor.py`
- 当前行为：在线模式单独创建无流式 `ChatOpenAI`，主任务完成后异步提取待确认记忆；不可用时使用本地规则。
- 风险：如果只重构主 Agent，Managed Chat 会被后台 BYOK 调用绕过，或形成未计量的官方调用。
- 冻结处理：纳入同一 `ChatModelFactory`；Managed Chat MVP 中固定使用现有本地规则兜底，不产生隐式 Managed 用量。

### 2.3 装配位置

- `python-runtime/petdock_runtime/agent/factory.py` 当前根据 `RuntimeConfig.resolved_backend` 创建 `LangChainBackend` 或 `MockBackend`。
- `python-runtime/petdock_runtime/api/resources.py` 同时装配 Backend 和 `MemoryExtractor`，是注入统一 Chat Factory 的唯一首选位置。
- `python-runtime/petdock_runtime/config.py` 当前直接持有 BYOK Chat 地址、模型和密钥；Phase 1 后这些值只应由 BYOK Factory 消费。

## 3. Embedding Provider

入口：`python-runtime/petdock_runtime/providers/embeddings.py`。

现有稳定能力：

- `EmbeddingProvider` Protocol 已定义健康检查、文档/查询向量和 Token 计数。
- `EmbeddingDescriptor` 已包含模型、版本、维度、Tokenizer、Chunk 策略和检索阈值。
- `LocalHashEmbedding` 提供零下载离线降级。
- `OnnxLocalEmbeddingProvider` 提供白名单本地模型。
- `OpenAICompatibleEmbeddingProvider` 提供 BYOK 在线接口。
- `create_embedding_provider()` 已集中完成 Provider 装配和健康检查。
- `ChromaVectorStore` 已按 Descriptor Signature 隔离 Collection。
- `KnowledgeService` 已支持活动向量空间和 Hash 影子索引降级。

冻结处理：

- Phase 1 不新增第二套通用 Embedding 接口，不移动现有实现。
- Managed Embedding 必须实现现有 `EmbeddingProvider`。
- Managed Descriptor 的逻辑模型 ID、Revision、Dimensions 和 Tokenizer 变化必须产生新的 Signature。
- 不同 Signature 的向量禁止混写；切换后使用新 Collection 或显式重建。

## 4. Vision Provider

入口：`python-runtime/petdock_runtime/vision/analyzer.py`。

当前职责：

- 继承或读取独立 Vision 配置。
- 使用本地随机测试图片主动探测模型能力。
- 对用户明确加入会话的图片生成摘要。
- 按图片哈希、配置签名和 Prompt 版本缓存摘要。
- 分类处理无配置、未测试、不支持、不可用和凭据无效状态。
- 不保存图片 Base64。

冻结处理：

- `VisionAnalyzer` 继续拥有探测、状态、摘要缓存和取消语义。
- Phase 4 只把远程 HTTP 调用抽成 BYOK/Managed Adapter。
- Managed Adapter 不得获得工具、Memory、Skill 或本地路径权限。
- 切换来源后必须使配置签名变化，不能复用不兼容摘要缓存。

## 5. Web Search Provider

入口：

- `src/main/assistant/webSearchService.ts`
- `src/main/assistant/webNetworkPolicy.ts`
- `src/main/assistant/webSettingsManager.ts`

现有 Provider：

- `VolcengineSearchProvider`
- `BraveSearchProvider`
- 仅用于 C3 Smoke 的 `SmokeWebSearchProvider`

Main 继续负责：

- API Key 读取和脱敏配置。
- 每任务搜索/抓取次数限制。
- URL、协议、端口和凭据校验。
- DNS 解析和公网地址固定，防止 SSRF 与 DNS 重绑定。
- 逐次重定向、MIME、响应大小、超时和正文预算。
- 网页清洗、来源归属、工具审计和取消。

冻结处理：Managed Provider 第一版只调用 `/ai/v1/web/search` 获取候选。候选 URL 后续仍由 Main 使用现有网络策略抓取；不得增加云端 `/ai/v1/web/fetch`。

## 6. 凭据与配置注入

| 配置 | Main 所有者 | Runtime 环境变量 | 当前密钥存储 |
| --- | --- | --- | --- |
| Chat | `ModelSettingsManager` | `PETDOCK_LLM_*` | `safeStorage` 密文文件 |
| Embedding | `EmbeddingModelManager` | `PETDOCK_EMBEDDING_*` | 在线 Key 使用 `safeStorage` |
| Vision | `VisionSettingsManager` | `PETDOCK_VISION_*` | 独立 Key 使用 `safeStorage` |
| Web Search | `WebSettingsManager` | 不下发 Runtime | 每个 Provider 独立 `safeStorage` 密文文件 |

`AssistantManager` 当前在启动 Runtime 前合并 Chat、Embedding 和 Vision 环境覆盖。Phase 1 不改变现有密钥路径；新增 `CapabilitySettingsManager` 只保存来源和开关，不保存或复制密钥。

## 7. 非 Managed AI Provider 网络调用

`python-runtime/petdock_runtime/skills/installer.py` 使用 `httpx` 下载公开 GitHub Skill。它属于 Skill 安装网络能力，不是 Chat、Embedding、Vision、Rerank 或 Web Search Provider，本次不纳入 CapabilitySelector。

该网络路径继续遵守 Skill 安装来源和权限规则，不得因为 Managed Service 重构而改由官方 AI 数据面代理。

## 8. Phase 1 回归范围

### 单元测试

- `ModelSettingsManager` 的环境继承、覆盖、清除和密钥脱敏。
- `EmbeddingModelManager` 的 Hash/Local/Online 切换、Descriptor 和失败回滚。
- `VisionSettingsManager` 的继承、独立凭据和配置变化。
- `WebSettingsManager` 的多 Provider 密钥隔离和旧版 Brave 迁移。
- `WebSearchService` 的关闭、额度、来源归属和 Provider 错误映射。
- Runtime 的 Mock、LangChain 工具循环、Vision 状态和 Embedding Signature。
- 新增 Chat Factory、能力来源迁移和 Main/Runtime Selector 测试。

### 集成与冒烟

- `npm.cmd run check`
- `npm.cmd run test:runtime:packaged`
- `npm.cmd run test:e2e:assistant:c3`
- `npm.cmd run test:e2e:assistant:c5`
- Phase 1 完成后增加旧配置迁移和未登录启动的专用冒烟。

## 9. Phase 1 禁止事项

- 不重写 Embedding Provider、Descriptor 或向量存储。
- 不把 Web Search Selector 移入 Python Runtime。
- 不让 `LangChainBackend`、`MemoryExtractor` 或其他模块继续自行决定 Managed/BYOK 来源。
- 不迁移、复制或删除现有 API Key 文件。
- 不改变本地 Runtime HTTP/SSE 协议和 Electron Main 工具权限。
- 不在 Phase 1 接入真实 Managed 网络流量。
