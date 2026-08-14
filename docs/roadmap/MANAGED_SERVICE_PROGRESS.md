# PetDock 官方托管服务进度与交接记录

本文档用于跨会话、跨开发者和跨智能体持续跟踪 BYOK 与官方托管服务双模式建设。它是快速交接入口，不替代架构和契约文档。

最后更新时间：2026-08-14

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
总体状态：Done
当前阶段：Phase 0 契约与基线冻结
架构对齐：Decision Frozen
桌面端 Managed 实现：Not Started
独立官网前端：Not Started（不在当前仓库）
Spring Boot 控制面：Not Started（不在当前仓库）
FastAPI AI 数据面：Not Started（不在当前仓库）
当前阻塞：无
下一建议工作项：进入 Phase 1 `P1-01`，建立本地 ChatModelFactory，不接入真实 Managed 网络流量
```

当前已完成方案冻结、BYOK 基线和权威契约迁移，尚未实现登录、设备、Runtime Token、Managed Provider、配额或官网功能。

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
| `P0-01` Capability 与来源规则 | `Done` | Schema、允许来源、快照样例和自动测试已完成 | Phase 1 生成或手写类型时保持一致 |
| `P0-02` Runtime Token Claims 与吊销 | `Done` | RS256、Claims、TTL、刷新、撤销、Issuer/JWKS 和轮换规则及测试已完成 | Phase 2 按契约实现 |
| `P0-03` OpenAPI、错误码与兼容规则 | `Done` | 云端权威源、桌面快照、Python/TypeScript/Spring 同样例测试、可追溯契约制品和 32 文件 SHA-256 比对均完成 | Phase 1 消费 v1 契约 |
| `P0-04` BYOK 基线和端到端结果 | `Done` | 完整验证通过，见 `MANAGED_SERVICE_BYOK_BASELINE_2026-08-13.md` | Phase 1 后使用同一门槛回归 |
| `P0-05` 数据、日志与保留策略 | `Done` | 中国大陆驻留、禁止跨境、正文不持久化及日志/用量保留期已冻结 | 实现时补自动化审计测试 |
| `P0-06` 身份、域名和证书 | `Done` | 自建 OIDC、30 天轮换 Refresh Token、退出语义和已购买的 `petdock.site` 正式入口已冻结 | 公网灰度前完成 DNS 解析和证书签发 |
| `P0-07` 产品、仓库与部署职责 | `Done` | Desktop、Web、Cloud 已明确为独立仓库；Cloud 仓库名为 `petdock-cloud` | 建立远程仓库时登记 URL 和负责人 |
| `P0-08` 链路标识和幂等 | `Done` | Header、SSE、Request Context 和 Usage Event Schema 及测试已完成 | 各端实现时消费同一契约 |
| `P0-09` Token 刷新与任务恢复 | `Done` | 本地 OpenAPI、刷新事件、结果 Schema 和重试边界已完成 | Phase 2/3 按契约实现 |
| `P0-10` Web Search/Fetch 边界 | `Done` | 数据面仅有 `/web/search`，测试禁止 `/web/fetch` | Phase 4 保留 Main 抓取路径 |
| `P0-11` 模型消费者与 Provider 盘点 | `Done` | 已形成 `MANAGED_SERVICE_PROVIDER_INVENTORY.md` | Phase 1 按清单实施和回归 |

Phase 0 的产品、基础设施、数据治理和跨语言契约交付物已经全部完成，整体状态为 `Done`；后续进入 Phase 1 本地 Chat 路由与能力配置抽象。

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

### 当前优先事项

进入 Phase 1 `P1-01`，在 `desktop-pet` 中建立本地 `ChatModelFactory` 和能力来源抽象，不接入真实 Managed 网络流量。

### `petdock-cloud` 契约同步规则

1. 权威源固定为 `petdock-cloud` 仓库内的 `contracts/managed-service/v1`。
2. 所有契约变更先在云端仓库修改和验证，再整体同步到桌面消费快照。
3. 使用云端 `tools/compare_contract_snapshot.py` 对两个 v1 目录做逐文件 SHA-256 校验。
4. 同步前在云端运行 Python、TypeScript、Spring/JUnit 测试，并生成和校验可追溯契约制品。
5. 建立发布流水线后，桌面仓库改为消费带版本、源提交和完整性信息的契约制品。

### Phase 1 准备

Phase 1 可以开始实施本地抽象，但不要接入真实 Managed 网络流量。Phase 1 完成后仍运行以下回归：

```powershell
npm.cmd run check
npm.cmd run build:runtime
npm.cmd run test:runtime:packaged
npm.cmd run test:e2e:assistant:c3
npm.cmd run test:e2e:assistant:c5
```

基线详情见 `MANAGED_SERVICE_BYOK_BASELINE_2026-08-13.md`。

## 10. 当前待确认事项

Phase 0 当前没有待确认的产品或基础设施决策。`petdock.site` 已完成购买；DNS 解析和证书签发、实际 Provider/模型安全配置，以及 Beta 免费额度数值属于后续上线配置前置条件，不改变已冻结契约。

## 11. 验证记录

| 日期 | 提交/工作区 | 范围 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| 2026-08-13 | `e778eec` + 文档改动 | `npm.cmd run check` | 通过 | TS 74 项、Python 74 项、检索六项指标 1.0、生产构建成功 |
| 2026-08-13 | `e778eec` + 文档改动 | `npm.cmd run build:runtime` | 通过 | Runtime 99,104,267 字节，PyInstaller 6.21.0 |
| 2026-08-13 | `e778eec` + 文档改动 | `test:runtime:packaged` | 通过 | 冷启动 6494 ms，`RUNTIME_SMOKE_OK` |
| 2026-08-13 | `e778eec` + 文档改动 | C3/C5 E2E | 通过 | `ASSISTANT_C3_SMOKE_OK`、`ASSISTANT_C5_SMOKE_OK` |
| 2026-08-13 | 当前工作区 | `npm.cmd run test:contracts` | 通过 | 10 项 Schema、样例、OpenAPI、安全与边界测试 |
| 2026-08-13 | 当前工作区 | 最终 `npm.cmd run check` | 通过 | TS 74、契约 10、Runtime 74、检索六项指标 1.0、生产构建成功 |
| 2026-08-13 | `petdock-cloud` 初始工作区 | Python 契约测试 | 通过 | 10 项测试通过，未创建业务服务 |
| 2026-08-13 | Desktop/Cloud v1 契约 | SHA-256 逐文件比对 | 通过 | 27 个受控文件一致 |
| 2026-08-13 | `petdock-cloud` 决策冻结工作区 | Python 契约测试 | 通过 | 12 项测试通过，覆盖域名一致性、D-P0-01 至 D-P0-16 和单机部署基线 |
| 2026-08-13 | Desktop/Cloud 决策冻结工作区 | SHA-256 逐文件比对 | 通过 | 28 个受控文件一致 |
| 2026-08-13 | 当前工作区 | 决策冻结后 `npm.cmd run check` | 通过 | TS 74、契约 12、Runtime 74、检索六项指标 1.0、生产构建成功 |
| 2026-08-14 | Desktop/Cloud 修复工作区 | Phase 0 退出门禁复验 | 通过 | 云端 Python 13 项、TypeScript 1 项、Spring/JUnit 1 项通过；含 Maven `target` 时制品仍为 32 个文件且校验通过；桌面快照 32 个文件一致 |
| 2026-08-14 | Desktop 修复工作区 | `npm.cmd run check` | 通过 | TS 74、契约 12、Runtime 74、检索六项指标 1.0、生产构建成功 |

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
- 完成 `P0-04` BYOK 完整基线，源码测试、检索评测、构建、Runtime 打包态和 C3/C5 冒烟全部通过。
- 完成 `P0-11` Provider 与模型消费者正式盘点，确认 Chat 的两个调用点及 Embedding、Vision、Web Search 的保留边界。
- 建立 Managed Service v1 契约快照，覆盖控制面、AI 数据面、本地 Session、Capability、JWT、OAuth、错误码、SSE、链路、用量、兼容与安全边界。
- 将 10 项契约自动测试接入 `npm.cmd run check`；当时尚待补齐的 Spring/TypeScript 同样例测试和可追溯契约制品已在 P0-03 收尾完成。
- 初始化独立 `petdock-cloud` Git 仓库，并将 Managed Service v1 迁移为权威契约源；桌面目录改为消费快照。
- 初始迁移时云端权威契约 10 项测试通过，云端与桌面 27 个受控文件 SHA-256 比对一致；随后已完成决策冻结和契约扩展。
- 冻结 D-P0-09 至 D-P0-15，并新增 D-P0-16：首期使用单台中国大陆云服务器，不建设集群和自动容灾，保留主机外备份与手工恢复底线。
- 决策冻结后云端与桌面契约各 12 项测试通过、28 个受控文件一致，桌面完整 `npm.cmd run check` 通过。
- 确认 `petdock.site` 已完成购买，公网启用前仍需完成 DNS 解析和 TLS 证书签发。

### 2026-08-13（Managed Phase 0 收尾）

- 同步云端权威 `contracts/managed-service/v1`，当前消费快照共 32 个受控文件。
- 云端已补齐 TypeScript 与 Spring/JUnit 同样例消费测试，并生成带 SHA-256 provenance 的 v1 契约制品。
- 云端 Python 12 项、TypeScript 1 项、Spring/JUnit 1 项契约测试及制品校验均通过；Desktop/Cloud 32 个文件 SHA-256 比对一致。
- Phase 0 已完成；桌面端下一工作项进入 Phase 1 `P1-01`，仅做本地 Chat Factory 和能力来源抽象，不接入真实 Managed 网络流量。

### 2026-08-14（Phase 0 门禁修复）

- 新增仓库级换行规则，确保 Windows 拉取后的桌面契约快照保持 LF，避免仅因 CRLF 造成 SHA-256 漂移。
- 云端契约制品收集器排除 Maven `target` 和 Python 缓存，并新增工具测试防止生成物进入发布制品。
- 在 Maven `target` 已存在的条件下完成 32 文件制品生成、离线校验和 Desktop/Cloud 快照比对；两项 Phase 0 收尾问题均已关闭。
