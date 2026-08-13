# PetDock 官方托管服务进度与交接记录

本文档用于跨会话、跨开发者和跨智能体持续跟踪 BYOK 与官方托管服务双模式建设。它是快速交接入口，不替代架构和契约文档。

最后更新时间：2026-08-13

## 1. 新会话快速开始

按以下顺序获取上下文：

1. 阅读本文档，确认当前阶段、下一工作项和阻塞项。
2. 阅读 `docs/architecture/MANAGED_SERVICE_IMPLEMENTATION_PLAN.md`，以其中冻结的架构、安全和阶段要求为准。
3. 阅读 `docs/architecture/AI_ASSISTANT_ARCHITECTURE.md`，理解现有 Electron Main、Renderer 和 Python Runtime 边界。
4. 根据本次工作项阅读对应代码和专项文档，不要在当前桌面仓库创建官网或云端服务代码。
5. 执行 `git status --short`，区分已有用户改动和本次改动。
6. 开发结束后更新本文档的阶段状态、验证记录、阻塞项和变更记录。

文档优先级：

```text
已冻结架构与安全规则
  docs/architecture/MANAGED_SERVICE_IMPLEMENTATION_PLAN.md

当前状态、下一步和验证事实
  docs/roadmap/MANAGED_SERVICE_PROGRESS.md

现有本地 Assistant 设计
  docs/architecture/AI_ASSISTANT_ARCHITECTURE.md
```

发生冲突时，不得通过进度文档修改冻结规则；应先完成架构评审并更新实施方案，再同步本进度文档。

## 2. 状态约定

| 状态 | 含义 |
| --- | --- |
| `Not Started` | 尚未开始 |
| `Decision Frozen` | 设计口径已冻结，但契约、代码或验收尚未完成 |
| `In Progress` | 正在实现或补齐交付物 |
| `Blocked` | 存在明确阻塞，必须记录解除条件 |
| `Done` | 交付物和验收均已完成 |
| `Deferred` | 已评审并明确延后 |

只有代码、契约、测试和要求的跨端验收全部完成后，工作项才能标记为 `Done`。文档中已有决定不代表对应功能已经实现。

## 3. 当前总览

```text
总体状态：In Progress
当前阶段：Phase 0 契约与基线冻结
架构对齐：Decision Frozen
桌面端 Managed 实现：Not Started
独立官网前端：Not Started（不在当前仓库）
Spring Boot 控制面：Not Started（不在当前仓库）
FastAPI AI 数据面：Not Started（不在当前仓库）
当前阻塞：无；部分 Phase 0 产品和基础设施参数待确认
下一建议工作项：P0-03 跨端契约骨架，或在仅有桌面仓库时执行 P0-04 BYOK 基线留档
```

当前只完成方案审阅和冻结规则对齐，尚未实现登录、设备、Runtime Token、Managed Provider、配额或官网功能。

## 4. 产品与仓库边界

| 产品 | 建议仓库 | 部署方式 | 职责 | 当前仓库是否包含 |
| --- | --- | --- | --- | --- |
| PetDock Desktop | `desktop-pet` | 用户 Windows 设备 | Electron、本地 Runtime、BYOK、Managed 客户端 | 是 |
| PetDock Web | `petdock-web` | 独立服务器 | 登录、充值、套餐、订单、设备和完整用量看板 | 否 |
| PetDock Cloud | `petdock-cloud` | 独立服务器 | Spring Boot 控制面、FastAPI 数据面、契约和基础设施 | 否 |

禁止事项：

- 不在 `desktop-pet` 中创建官网前端、Spring Boot 或云端 FastAPI 服务实现。
- 不把官网 Cookie 复制给 Electron，也不把桌面 Refresh Token 下发给官网前端。
- 不让官网前端直接调用 AI 数据面。
- 不让任何客户端获得官方上游 Provider Key。

## 5. 当前桌面代码基线

| 领域 | 当前事实 | 主要入口 |
| --- | --- | --- |
| Chat | `LangChainBackend` 和 `MemoryExtractor` 分别直接创建 `ChatOpenAI`，尚无统一 `ChatModelFactory` | `python-runtime/petdock_runtime/agent/langchain_backend.py`、`python-runtime/petdock_runtime/memory/extractor.py` |
| Agent 编排 | 本地 Runtime 负责任务、SSE、工具循环、Memory、RAG 和 Skill | `python-runtime/petdock_runtime/agent/service.py` |
| Runtime 装配 | 长生命周期资源集中创建，适合作为 Provider 注入点 | `python-runtime/petdock_runtime/api/resources.py` |
| 本地鉴权 | Main 每次启动生成 `PETDOCK_RUNTIME_TOKEN`，与未来官方 Runtime Token 属于不同信任域 | `src/main/assistant/runtimeProcess.ts`、`python-runtime/petdock_runtime/api/server.py` |
| BYOK 密钥 | 主模型、Embedding、Vision、Web Search 密钥由 Main 使用 `safeStorage` 管理 | `src/main/assistant/*SettingsManager.ts` |
| Embedding | 已有 Provider、Descriptor、Signature、Hash/ONNX/在线实现，不应在 Phase 1 重写 | `python-runtime/petdock_runtime/providers/embeddings.py` |
| 向量空间 | Chroma 已按 Embedding Signature 隔离 Collection | `python-runtime/petdock_runtime/rag/vector_store.py` |
| Vision | 已有独立分析器、探测、摘要和缓存流程 | `python-runtime/petdock_runtime/vision/analyzer.py` |
| Web Search | Provider、SSRF、DNS、重定向和正文抓取位于 Electron Main | `src/main/assistant/webSearchService.ts`、`src/main/assistant/webNetworkPolicy.ts` |
| 共享协议 | Runtime 状态、设置快照和 SSE 事件类型集中定义 | `src/shared/assistant.ts` |

## 6. 已冻结决策摘要

- 保留一套本地 Assistant Core，云端初期只提供 AI 能力数据面。
- Electron Main 是能力来源配置的唯一持久化所有者。
- Runtime 只选择 Chat、Embedding 和 Vision 等自身负责的 Provider；Web Search 由 Main 选择。
- 第一版桌面登录固定使用系统浏览器 OAuth 2.1/OIDC Authorization Code + PKCE 和 `127.0.0.1` loopback redirect。
- 官方 Runtime Token 有效期 15 分钟，剩余不足 3 分钟时由 Main 提前刷新。
- 只有尚未产生文本或 ToolCall 时才允许认证刷新后安全重试一次；已经输出时返回稳定错误，不静默重放。
- Managed 故障不得自动使用用户 BYOK Key，第一版只允许用户手动切换来源。
- Managed Web Search 只返回搜索候选；网页正文继续由 Main 按现有 SSRF 规则抓取。
- Embedding 复用现有 Provider、Descriptor Signature 和 Collection 隔离机制。
- `trace_id` 贯穿一次用户请求，`request_id` 标识一次逻辑远程调用，`attempt_id` 标识上游尝试，`usage_event_id` 用于用量幂等。

完整规则以实施方案为准，本节只用于快速恢复上下文。

## 7. Phase 0 工作项状态

| 工作项 | 状态 | 当前结果 | 下一动作 |
| --- | --- | --- | --- |
| `P0-01` Capability 与来源规则 | `Decision Frozen` | 允许来源、有效来源和 Main 所有权已写入实施方案 | 形成 JSON Schema 和跨端样例 |
| `P0-02` Runtime Token Claims 与吊销 | `Decision Frozen` | TTL、Claims、撤销时效和失败关闭已冻结 | 形成 Claims Schema、签名和撤销契约测试 |
| `P0-03` OpenAPI、错误码与兼容规则 | `Not Started` | 实施方案中只有接口草案 | 在 `petdock-cloud/contracts` 建立版本化契约源 |
| `P0-04` BYOK 基线和端到端结果 | `Not Started` | 现有项目有测试命令，尚未为本计划重新留档 | 在干净基线上执行最低验证并记录日期、提交和结果 |
| `P0-05` 数据、日志与保留策略 | `Decision Frozen` | 默认禁止记录正文和敏感凭据 | 确认部署区域、保留期限及隐私文本 |
| `P0-06` 身份、域名和证书 | `In Progress` | PKCE + loopback 已冻结 | 确认身份服务、正式域名和证书策略 |
| `P0-07` 产品、仓库与部署职责 | `Decision Frozen` | Desktop、Web、Cloud 已明确独立 | 创建外部仓库时登记实际地址和负责人 |
| `P0-08` 链路标识和幂等 | `Decision Frozen` | 四类 ID 的语义已冻结 | 写入 Header、SSE 和 Usage Schema 测试 |
| `P0-09` Token 刷新与任务恢复 | `Decision Frozen` | 本地接口、事件和重试边界已冻结 | 形成时序契约及 TypeScript/Python 样例 |
| `P0-10` Web Search/Fetch 边界 | `Decision Frozen` | 云端搜索、Main 抓取已冻结 | 在数据面 OpenAPI 中禁止 `/web/fetch` |
| `P0-11` 模型消费者与 Provider 盘点 | `In Progress` | 已确认主要代码入口和已有 Embedding 基线 | 开工前再用代码搜索形成正式清单和回归范围 |

Phase 0 总状态保持 `In Progress`。在 `P0-03`、`P0-04` 及必要契约测试完成前，不得标记为 `Done`。

## 8. 后续阶段状态

| 阶段 | 状态 | 开始条件 | 首个桌面工作项 |
| --- | --- | --- | --- |
| Phase 1 Chat 路由与能力配置 | `Not Started` | Phase 0 的相关协议和 BYOK 基线可用 | `P1-01` 定义 `ChatModelFactory` |
| Phase 2 官网、身份、设备和会话 | `Not Started` | 身份服务、域名、证书和 Token 契约确认 | `P2-06` PKCE + loopback 登录 |
| Phase 3 Managed Chat MVP | `Not Started` | Phase 1、2 完成 | `P3-10` `ManagedChatProvider` |
| Phase 4 其他 Managed 能力 | `Not Started` | Managed Chat 链路稳定 | 按 E/V/W/R 独立排期 |
| Phase 5 正式收费与可靠性 | `Not Started` | Beta 配额和各能力稳定 | 生产账本、支付和运营能力 |
| Phase 6 服务端 Agent | `Deferred` | Phase 5 后重新评审 | 不得提前复制本地 Agent |

## 9. 下一步建议

### 具备 `petdock-cloud` 仓库时

优先执行 `P0-03`：

1. 建立 `contracts/openapi`、`contracts/schemas` 和 `contracts/error-codes`。
2. 先定义 Capability、Runtime Token Claims、统一错误和链路 Header。
3. 再定义桌面 OAuth/设备/Entitlement/Runtime Session 及 Managed Chat 契约。
4. 为 TypeScript、Python 和 Spring 增加相同样例的序列化测试。

### 当前只有 `desktop-pet` 仓库时

优先执行 `P0-04`，不要在本仓库临时创建云端实现：

```powershell
npm.cmd run check
npm.cmd run build:runtime
npm.cmd run test:runtime:packaged
npm.cmd run test:e2e:assistant:c3
npm.cmd run test:e2e:assistant:c5
```

记录提交 SHA、Windows/Node/Python 版本、命令结果和失败日志位置。基线完成后可开始 `P1-01` 至 `P1-03`，但不得提前接入真实 Managed 网络流量。

## 10. 当前待确认事项

- 官网正式域名和 API 域名。
- OIDC/OAuth2 身份服务采用自建还是托管方案。
- 首批套餐、免费额度和能力授权规则。
- 首个官方模型 Provider 和逻辑模型档位。
- 官方服务部署区域和数据跨境要求。
- Prompt、图片、搜索词和用量日志的保留期限。
- 支付、退款、欠费和套餐降级规则。
- 最低支持桌面版本和服务端契约兼容周期。

这些事项不阻塞 BYOK 基线验证和 Phase 1 本地抽象，但会阻塞 Phase 2、3 的正式上线实现。

## 11. 验证记录

| 日期 | 提交/工作区 | 范围 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| 2026-08-13 | 当前工作区 | 文档一致性 | 通过 | `git diff --check` 通过；未运行代码测试 |

测试结果必须记录实际执行事实，不引用过期测试数量冒充本次验证。未执行的测试明确写“未运行”。

## 12. 每次交接必须更新

完成一个工作会话后，至少更新以下内容：

- “当前总览”中的当前阶段、总体状态、下一工作项和阻塞项。
- 对应工作项的状态、结果和下一动作。
- “验证记录”中的日期、提交或工作区、命令与结果。
- 新增或解除的“当前待确认事项”。
- 下方“变更记录”中的高层摘要。

状态更新模板：

```text
工作项：P?-??
状态：Not Started / Decision Frozen / In Progress / Blocked / Done / Deferred
本次完成：
修改文件：
验证命令与结果：
未运行验证：
阻塞与解除条件：
下一步：
```

不要在本进度文档中记录 API Key、Token、用户正文、附件内容、生产地址凭据或其他敏感数据。

## 13. 变更记录

### 2026-08-13

- 完成现有桌面项目与双模式实施方案审阅。
- 冻结独立 `petdock-web`、`desktop-pet` 和 `petdock-cloud` 的产品、仓库与部署边界。
- 将 Capability 所有权、旧配置迁移、Chat Factory、Token 刷新与吊销、Web Search 边界、链路标识和 Phase 3/5 配额职责对齐到实施方案。
- 新建本进度与交接文档；当前仍处于 Phase 0，尚无 Managed 功能代码实现。
