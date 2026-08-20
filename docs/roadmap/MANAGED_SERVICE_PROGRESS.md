# PetDock 官方托管服务进度与交接记录

本文档用于跨会话、跨开发者和跨智能体持续跟踪 BYOK 与官方托管服务双模式建设。它是快速交接入口，不替代架构和契约文档。

最后更新时间：2026-08-20

## 1. 新会话快速开始

按以下顺序获取上下文：

1. 阅读本文档，确认当前阶段、下一工作项和阻塞项。
2. 阅读 `docs/architecture/MANAGED_SERVICE_IMPLEMENTATION_PLAN.md`，以其中冻结的架构、安全和阶段要求为准。
3. 进入 Phase 2 时阅读 `docs/features/MANAGED_SERVICE_PHASE2_IDENTITY_AND_SESSION.md`，确认开发环境、身份、设备和 Token 细节。
4. 正式部署或线上联调时阅读 `petdock-cloud/docs/guides/PRODUCTION_DEPLOYMENT_AND_ONLINE_INTEGRATION.md`。
5. 阅读 `docs/architecture/AI_ASSISTANT_ARCHITECTURE.md`，理解现有 Electron Main、Renderer 和 Python Runtime 边界。
6. 根据本次工作项阅读对应代码和专项文档，不要在当前桌面仓库创建官网或云端服务代码。
7. 执行 `git status --short`，区分已有用户改动和本次改动。
8. 开发结束后更新本文档的阶段状态、验证记录、阻塞项和变更记录。

文档优先级：

```text
已冻结架构与安全规则
  docs/architecture/MANAGED_SERVICE_IMPLEMENTATION_PLAN.md

当前状态、下一步和验证事实
  docs/roadmap/MANAGED_SERVICE_PROGRESS.md

Phase 2 详细开发方案
  docs/features/MANAGED_SERVICE_PHASE2_IDENTITY_AND_SESSION.md

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
当前阶段：Phase 2 P2-W04 Done，准备进入 Desktop P2-11
架构对齐：Decision Frozen
桌面端 Managed 实现：P2-06、P2-07、P2-08、P2-09、P2-10 Done（Main 已接入 PKCE、loopback、Refresh Token safeStorage、轮换恢复、UserInfo、设备同步、退出、当前设备撤销、Runtime Token Broker、本地 Session Bridge、时钟偏差校正、离线退避和并发刷新协调）
独立官网前端：`petdock-web` P2-W01、P2-W02、P2-W03、P2-W04 Done；P2-W04 已完成调用边界与路由收口（独立仓库）
Spring Boot 控制面：P2-01、P2-02、P2-04、P2-05、P2-08、P2-09、P2-W01、P2-W02、P2-W03 Done；P2-06 loopback 兼容已实现（位于独立 `petdock-cloud`）
FastAPI AI 数据面：Not Started（不在当前仓库）
云端基础设施：服务器、ICP 备案、正式 DNS 和 TLS 条件已就绪，受限线上门禁已完成
共享开发依赖：PostgreSQL、Redis 和控制面已通过服务器内部网络/SSH 隧道完成开发验收
当前阻塞：P2-W04 自动门禁无代码阻塞；本机 Docker 不可用导致 Cloud 5 项 Testcontainers 集成测试跳过；普通用户公网流量仍按生产策略受控
下一建议工作项：输出并实施 Desktop P2-11 官网管理入口
```

当前已完成方案冻结、BYOK 基线、权威契约迁移和 Phase 1 本地来源抽象。`petdock-cloud`、`petdock-web` 已完成 P2-W01 至 P2-W03；Desktop 已完成 P2-06 至 P2-10，并补齐标准 `access_denied` 和设备撤销后更换本地 UUID 的恢复逻辑。Usage、支付/按量结算闭环和 FastAPI AI 数据面继续延后。正式域名受限线上门禁已完成，下一工作项为 P2-W04 调用边界与安全收口。

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
| Chat | `ChatModelFactory` 统一创建 BYOK Agent/后台模型；`LangChainBackend` 和记忆提取器只消费窄模型端口 | `python-runtime/petdock_runtime/providers/chat.py`、`python-runtime/petdock_runtime/providers/selector.py` |
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
| `P0-06` 身份、域名和证书 | `Done` | 自建 OIDC、30 天轮换 Refresh Token、退出语义及 `petdock.site` 备案、DNS、TLS 条件已就绪 | 按生产指南完成入口网关与受限线上门禁 |
| `P0-07` 产品、仓库与部署职责 | `Done` | Desktop、Web、Cloud 已明确为独立仓库；Cloud 仓库名为 `petdock-cloud` | 建立远程仓库时登记 URL 和负责人 |
| `P0-08` 链路标识和幂等 | `Done` | Header、SSE、Request Context 和 Usage Event Schema 及测试已完成 | 各端实现时消费同一契约 |
| `P0-09` Token 刷新与任务恢复 | `Done` | 本地 OpenAPI、刷新事件、结果 Schema 和重试边界已完成 | Phase 2/3 按契约实现 |
| `P0-10` Web Search/Fetch 边界 | `Done` | 数据面仅有 `/web/search`，测试禁止 `/web/fetch` | Phase 4 保留 Main 抓取路径 |
| `P0-11` 模型消费者与 Provider 盘点 | `Done` | 已形成 `MANAGED_SERVICE_PROVIDER_INVENTORY.md` | Phase 1 按清单实施和回归 |

Phase 0 的产品、基础设施、数据治理和跨语言契约交付物已经全部完成，Phase 1 本地 Chat 路由与能力配置抽象也已完成；下一阶段进入 Phase 2 身份与设备基础设施。

## 8. 后续阶段状态

| 阶段 | 状态 | 开始条件 | 首个桌面工作项 |
| --- | --- | --- | --- |
| Phase 1 Chat 路由与能力配置 | `Done` | Phase 0 的相关协议和 BYOK 基线可用 | Phase 2 `P2-06` PKCE + loopback 登录 |
| Phase 2 官网、身份、设备和会话 | `In Progress` | 服务器、备案、DNS、TLS 已就绪；生产隔离部署与线上门禁待完成 | `P2-02` 用户、设备、授权记录与持久化 |
| Phase 3 Managed Chat MVP | `Not Started` | Phase 1、2 完成 | `P3-10` `ManagedChatProvider` |
| Phase 4 其他 Managed 能力 | `Not Started` | Managed Chat 链路稳定 | 按 E/V/W/R 独立排期 |
| Phase 5 正式收费与可靠性 | `Not Started` | Beta 配额和各能力稳定 | 生产账本、支付和运营能力 |
| Phase 6 服务端 Agent | `Deferred` | Phase 5 后重新评审 | 不得提前复制本地 Agent |

## 9. 下一步建议

### 当前优先事项

Phase 2 云端用户、设备、授权、Runtime Session、撤销和安全审计基础已完成；桌面 P2-06 至 P2-10 已完成。`petdock-web` 与 Cloud 已完成 P2-W01 至 P2-W03，并通过真实 HTTPS、数据库/Redis 和设备撤销传播验收。正式域名受限线上门禁已通过，下一步完成 P2-W04 调用边界与安全收口；`P2-11` 仍排在 W01~W04 之后。

### `petdock-cloud` 契约同步规则

1. 权威源固定为 `petdock-cloud` 仓库内的 `contracts/managed-service/v1`。
2. 所有契约变更先在云端仓库修改和验证，再整体同步到桌面消费快照。
3. 使用云端 `tools/compare_contract_snapshot.py` 对两个 v1 目录做逐文件 SHA-256 校验。
4. 同步前在云端运行 Python、TypeScript、Spring/JUnit 测试，并生成和校验可追溯契约制品。
5. 建立发布流水线后，桌面仓库改为消费带版本、源提交和完整性信息的契约制品。

### Phase 1 验证结果

Phase 1 已完成本地 Chat 路由与能力来源抽象，未接入真实 Managed 网络流量。完成门禁使用以下命令：

```powershell
npm.cmd run check
npm.cmd run build:runtime
npm.cmd run test:runtime:packaged
npm.cmd run test:e2e:assistant:c3
npm.cmd run test:e2e:assistant:c5
```

基线详情见 `MANAGED_SERVICE_BYOK_BASELINE_2026-08-13.md`。

## 10. 当前待确认事项

服务器、`petdock.site` ICP 备案、正式 DNS 和 TLS 条件已经就绪。普通用户公网登录流量仍须等待生产 PostgreSQL/Redis/JWT 密钥隔离、Nginx 精确路由和来源 IP 白名单线上门禁通过；日常开发继续使用本地 Mock 或 `shared-dev`，数据库和中间件端口不得直接暴露公网。

Phase 2 已确认 PostgreSQL 17、Redis 8.0、Flyway、Spring Authorization Server、Docker Compose、Nginx 和 SSH 隧道开发接入。UserInfo/账号快照、Refresh Token 主动撤销、Feature Flag 下发、开发环境端点覆盖、设备显示名、服务端时间、P2-10 生命周期边界和官网 Web API/Web Session 契约已由 `petdock-cloud` 及 Desktop 消费快照冻结；官网契约位于独立 `web-control-plane.yaml`，不改变桌面 Bearer API。实际 Provider/模型安全配置和 Beta 免费额度仍属于后续上线配置前置条件。

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
| 2026-08-15 | 当前工作区 | Phase 1 `P1-01` 至 `P1-08` 实现与 `npm.cmd run check` | 通过 | TS 80、契约 12、Runtime 82、检索六项指标 1.0、生产构建成功 |
| 2026-08-15 | 当前工作区 | `npm.cmd run build:runtime`、`test:runtime:packaged` | 通过 | PyInstaller Runtime 构建成功，`RUNTIME_SMOKE_OK` |
| 2026-08-15 | 当前工作区 | C3/C5 开发版与解包版 E2E | 通过 | `ASSISTANT_C3_SMOKE_OK`、`ASSISTANT_C5_SMOKE_OK` |
| 2026-08-15 | 当前工作区 | 提交前敏感数据与忽略规则检查 | 通过 | 复核 21 个待提交文件；规则命中均为合成占位符、保留测试域名、回环地址或拒绝测试，无真实凭据、个人绝对路径、用户正文和生产日志；构建产物、虚拟环境、Runtime 数据及临时目录保持忽略 |
| 2026-08-15 | `petdock-cloud` P2-00/P2-01 工作区 | 云端 Python 契约 14 项、TypeScript 1 项、Spring/JUnit 1 项、制品校验、Desktop/Cloud 快照比对 | 通过 | 新增身份与会话契约、Feature Flag 接口和 Spring Boot 控制面基础工程；消费快照共 33 个文件 |
| 2026-08-16 | `petdock-cloud` P2-04 工作区 | 控制面、三语言契约与快照比对 | 通过 | 控制面 44 项、Python 15 项、TypeScript 1 项、Spring 契约 1 项通过；33 个契约文件一致，Desktop 契约未变更 |
| 2026-08-16 | Desktop P2-04 文档同步工作区 | Desktop 回归 | 通过（使用隔离临时目录） | TypeScript 80 项、契约 14 项、Runtime 82 项、检索六项指标 1.0 和生产构建通过；统一 `npm run check` 在 Runtime 阶段受既有 `temp/pytest-runtime` ACL 阻断，已改用未占用的 ignored basetemp 复验 |
| 2026-08-16 | Desktop/Cloud P2-06 工作区 | Cloud Python 契约、Spring/JUnit、Desktop TypeScript、Mock OIDC、生产制品扫描和快照比对 | 通过 | Cloud 14 项契约测试、Spring 61 项测试通过；Desktop 92 项单元测试、14 项契约测试、类型检查和生产制品端点扫描通过；33 个契约文件一致；真实公网域名浏览器联调未运行（备案未完成） |
| 2026-08-16 | Desktop P2-07 工作区 | safeStorage 存储、Refresh Grant、启动恢复、轮换并发保护、类型检查、契约和生产构建 | 通过 | Desktop 108 项单元测试、14 项契约测试、类型检查、生产制品端点扫描和真实 Electron safeStorage 加解密往返自检通过；共享开发 OAuth 重启联调未运行 |
| 2026-08-16 | Desktop/Cloud P2-09 工作区 | Runtime Token Broker、Runtime Session Bridge、Cloud Runtime Session 回归和跨端门禁 | 通过 | Cloud JDK 21 Maven 66 项测试、Testcontainers PostgreSQL 17 迁移/持久化；Desktop TypeScript 134 项、契约 14 项、隔离 basetemp Runtime 86 项、检索六项指标 1.0、类型检查和生产构建；Cloud Python 契约 15 项、TypeScript 1 项、Spring 1 项、契约制品校验和 33 文件快照一致 |
| 2026-08-16 | Desktop P2-10 工作区 | Token 生命周期、时钟偏差、离线退避、Runtime 恢复和 Main-only 认证控制 | 通过 | Desktop `npm run typecheck`、149 项单测、87 项 Runtime 测试、14 项契约测试、检索评测六项指标 1.0、生产构建和端点扫描通过；Cloud Maven 因当前机器仅有 JDK 17 未运行，待 JDK 21 环境复验 |
| 2026-08-16 | `petdock-web` 初始化工作区 | `npm install`、`npm run typecheck`、`npm run build`、Vite HTTP 200 和 `npm audit` | 通过 | Vite 7、React 19、TypeScript 5.9 工程骨架可构建；npm audit 0 漏洞；业务页面和官网 API 尚未实现 |
| 2026-08-16 | Desktop/Cloud 官网契约同步工作区 | Web OpenAPI、Session/CSRF 文档、错误目录、样例和跨语言门禁 | 通过 | Cloud 契约 Python 15 项、全量 pytest 16 项、TypeScript 1 项、Spring/JUnit 1 项；契约制品 38 个文件；Desktop/Cloud 逐文件 SHA-256 38 个文件一致 |
| 2026-08-17 | Web/Cloud P2-W01 工作区 | Web/Cloud 自动门禁与真实 HTTPS Cookie/CSRF 联调 | 通过 | Web Vitest 11 项、Playwright Mock 3 项、类型检查和构建；Cloud JDK 21 Maven 82 项中 78 项通过、4 项 Docker 容器测试跳过；真实 PostgreSQL/Redis 双 Session 改密撤销通过 |
| 2026-08-17 | Desktop/Cloud P2-W02 契约工作区 | 标准 Consent、双主机 Session、OAuth 页面边界与快照比对 | 通过 | Cloud 与 Desktop 各 16 项契约测试通过；38 个受控文件 SHA-256 一致；业务实现尚未开始 |
| 2026-08-18 | Web/Cloud/Desktop P2-W02 实现与收尾工作区 | 标准 Consent、分离 Host HTTPS、真实 loopback/PKCE、设备同步、拒绝授权与提交后修复 | 通过 | Desktop 类型检查、155 项 Vitest、16 项契约、87 项 Runtime、检索评测、生产构建和生产依赖审计（0 漏洞）通过；Web 22 项 Vitest、Playwright Mock 6 项通过/1 项按环境跳过、生产构建和生产依赖审计（0 漏洞）通过；Cloud pytest 17 项、JDK 21 Maven 101 项全部通过，Testcontainers PostgreSQL/Redis 已实际运行；真实 HTTPS 跨端测试 2 项通过；Desktop/Cloud 38 个契约文件一致 |
| 2026-08-19 | Desktop/Cloud/Web P2-W03 契约工作区 | 服务方案三态、Web 设备管理、跨语言样例、快照与生成类型 | 通过 | Cloud 契约 Python 17 项、全量 pytest 18 项、TypeScript 1 项、Spring 1 项及 41 文件制品校验通过；Desktop 17 项契约测试和 SHA-256 比对通过；Web 类型生成、22 项测试和生产构建通过 |
| 2026-08-20 | Desktop/Cloud/Web P2-W04 实现与收尾工作区 | 调用边界、精确路由、生产端点和安全链 | 通过（Docker 集成项条件通过） | Desktop Vitest 159、契约 17、Runtime 87、检索评估、类型检查、生产构建和依赖审计 0 漏洞；Web Vitest 35、Playwright E2E 10 通过/1 跳过、生产构建、Nginx 精确路由和依赖审计 0 漏洞；Cloud pytest 18、JDK 21 Maven 120 中 115 通过/5 跳过且无失败；Testcontainers PostgreSQL/Redis 因本机无可用 Docker 未运行；41 个契约文件一致 |

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

### 2026-08-15（Phase 1 完成）

- 完成 `P1-01` 至 `P1-03`：新增 Python `ChatModelFactory` 与 Runtime Capability Selector，主 Agent 和后台记忆提取统一通过 Factory 创建 Chat 模型；Managed/Mock 后台记忆固定使用本地规则。
- 完成 `P1-04` 至 `P1-06`：新增 Electron Main `CapabilitySettingsManager`、版本化脱敏能力快照、旧配置迁移和原子写入；现有 `safeStorage` 密钥路径未改变。
- 完成 `P1-07` 至 `P1-08`：Embedding、Vision、Web Search 领域实现保持原边界，Runtime 只接收 Main 计算的有效来源；显式 Mock 后端优先于自动 BYOK 迁移，并补齐回滚与来源选择测试。
- 新增 8 项 Runtime Factory/Selector 测试和 6 项 Main 能力配置测试；最终 TypeScript 80 项、Runtime 82 项、Managed 契约 12 项通过。
- `test:runtime:packaged`、C3/C5 开发版和解包版冒烟均通过；Phase 1 未接入任何真实 Managed 网络流量。
- 已按开发指南完成提交前脱敏检查：待提交源码、测试和文档不含真实 API Key、Token、Cookie、私钥、证书、个人绝对路径、用户正文或生产 Provider 凭据；测试凭据均为明确合成占位符。

### 2026-08-15（Phase 2 方案与环境同步）

- 新增 `docs/features/MANAGED_SERVICE_PHASE2_IDENTITY_AND_SESSION.md`，承载 Phase 2 身份、设备、会话、Token、共享开发环境和跨仓库实施细节。
- 服务器与域名已就绪，ICP 备案仍在审核中；备案只阻塞正式公网登录联调，不阻塞本地 Mock 和受控开发环境建设。
- 开发数据库和中间件优先部署在服务器内部网络，多台个人电脑通过 SSH 隧道或自建私网接入；不直接暴露数据库和中间件公网端口。
- 下一工作项调整为 `P2-00` 契约缺口与开发环境基线确认，完成后进入桌面端 `P2-06`。
- `P2-00` 数据组件选型确认使用 PostgreSQL 17、Redis 8.0、Flyway、Spring Authorization Server、Docker Compose 和 Nginx；开发机使用 SSH 隧道受控接入。
- 新增 `docs/guides/MANAGED_SERVICE_SHARED_DEV_DEPLOYMENT.md`，提供服务器安装、回环端口绑定、数据库角色、SSH 隧道、验证和备份指令。

### 2026-08-15（P2-00 契约冻结与 P2-01 云端基础工程）

- 在 `petdock-cloud` 权威契约中冻结 `D-P2-01` 至 `D-P2-08`，新增 OIDC/UserInfo/Token Response、RFC 7009 撤销、Feature Flag、端点覆盖、设备命名、HTTP `Date` 和环境隔离规则。
- `petdock-cloud` 新增 Spring Boot 控制面基础工程、开发配置模板、Flyway V1 迁移、Redis/PostgreSQL 连接和健康检查；正式用户、设备和 Runtime 业务仍未完成。
- 已将权威契约整体同步到桌面消费快照并完成 33 个文件 SHA-256 比对；下一工作项进入云端 P2-02，桌面 P2-06 等待控制面协议可联调后开始。

### 2026-08-16（云端 P2-02/P2-04 完成）

- `petdock-cloud` 已提交 P2-02 用户、设备、授权、Runtime Session、撤销和安全审计持久化，Desktop/Cloud 契约快照继续保持 33 个文件一致。
- 云端 P2-04 新增仓库外 PKCS#12 密钥环、稳定公钥指纹 `kid`、多公钥 JWKS、5 分钟缓存和分阶段轮换门禁，不改变桌面消费契约。
- Entitlement 管理 API 和 Usage API 按确认延后；备案仍只阻塞正式域名公网登录，桌面 P2-06 本地 Mock PKCE/loopback 开发不受影响。

### 2026-08-16（P2-06 实现工作区）

- Cloud 修正 `GET /api/v1/features` 为登录前匿名端点，并为 `petdock-desktop` 增加仅限 `127.0.0.1`、固定 `/oauth/callback`、显式随机端口和 `http` 协议的 redirect URI 校验；其他 Client 继续精确匹配。
- Desktop 新增 Main 侧端点策略、Feature Flag、openid-client Discovery/PKCE、一次性 loopback、登录状态机和受控 IPC；Token 只保存在 Main 内存，`safeStorage` 留给 P2-07。
- 生产制品扫描仅禁止静态开发服务端点，允许运行时生成 OAuth loopback 地址；应用版本同步到契约最低版本 `0.2.0`。

### 2026-08-16（P2-07 实现工作区）

- Desktop 新增版本化 Refresh Token Store，使用 Electron `safeStorage` 加密，并通过同目录临时文件和原子替换保存；Access Token、ID Token 和完整 Token Response 不持久化。
- Main 新增 Refresh Token Grant、每次使用后的严格轮换校验、启动会话恢复和 single-flight 并发保护；临时网络故障保留旧密文，`invalid_grant` 才清理并要求重新登录。
- 服务端已轮换但本地保存失败时只在 Main 内存保留新 Token 并重试落盘，不再次提交已经使用过的旧 Token；Renderer 只接收脱敏状态事件。
- Desktop 108 项单元测试、14 项契约测试、类型检查、生产构建、端点扫描和真实 Electron `safeStorage` 加解密往返自检通过；未修改 Cloud、数据库、Redis 或 Managed Service v1 公共契约。

### 2026-08-16（P2-08 实现工作区）

- Desktop Main 新增 OIDC UserInfo 最小字段校验、账号脱敏快照、按 issuer+subject 隔离的本地设备 UUID 映射、设备注册/查询/撤销控制面客户端和统一 ErrorEnvelope 解析。
- Desktop 登录与启动恢复在 Refresh Token 持久化后同步 UserInfo 和当前设备；Renderer 只接收账号、设备显示状态和会话同步状态，不接收 Token、subject 或设备 ID。
- Desktop 新增 RFC 7009 Refresh Token 退出、当前设备撤销 IPC 和设置页入口；网络失败保留可用凭据，服务端确认撤销后清理本地凭据，撤销后删除本地设备映射。
- Cloud 接入 Spring Authorization Server UserInfo Mapper，仅返回 `sub`、`email`、`email_verified`、`preferred_username` 和 `name`，不新增数据库迁移、Redis Key 或公共契约字段。
- Desktop 123 项单元测试、14 项契约测试、类型检查、生产构建和生产端点扫描通过；Cloud JDK 21 Maven 62 项测试、Testcontainers PostgreSQL 17 迁移与持久化、Python 15 项、TypeScript 1 项、Spring 契约 1 项及 33 文件快照比对通过。

### 2026-08-16（P2-09 Runtime Token Broker 和 Runtime Session Bridge）

- Desktop Main 新增 Runtime Token Broker：只在 Main 内存持有 Runtime Lease，固定 15 分钟 TTL、剩余 3 分钟刷新、single-flight、Runtime 重启重新注入和退出时内存清理；Renderer 只接收脱敏状态。
- Desktop Main 与 Python Runtime 接入本地 `PUT/DELETE /v1/managed/session`、`GET /v1/managed/session/status` 和 `POST /v1/managed/auth-result`；Runtime Session Store 线程安全、纯内存且禁止通过状态或 repr 暴露 Token、Session ID、用户或设备标识。
- Cloud 复核 Runtime Session Controller 与应用服务回归覆盖：撤销返回 204、无 Entitlement、设备绑定不匹配和已撤销设备均拒绝签发；不新增 Flyway、Redis 或 v1 公共契约字段。
- P2-09 不接入 `managed_auth_refresh_required` SSE 到 Renderer，也不实现 Managed Provider、JWKS 数据面验签或 P2-10 的离线/时钟偏差/并发异常矩阵。
- 本轮完成 Desktop 134 项单元测试、14 项契约测试、86 项 Runtime 测试、检索评测和生产构建；Cloud 控制面 66 项 Maven 测试、契约 Python 15 项、TypeScript 1 项、Spring 1 项，契约制品和 33 文件快照校验均通过。

### 2026-08-16（P2-10 Token 生命周期、离线恢复和 Main-only 认证控制）

- Desktop Main 新增服务端 HTTP `Date` 时钟偏差采样；可信偏差参与 Access Token、Runtime Lease 和临界刷新调度，超过 60 秒或缺失时不延长凭据寿命。
- 所有启动恢复、UserInfo/设备过期重试、Runtime Broker 和任务内认证刷新统一复用 Refresh Token single-flight，避免轮换 Refresh Token 并发复用；退出、设备撤销和 Runtime 生命周期按同一协调器串行化。
- Runtime Token Broker 增加网络/DNS/超时/5xx/限流指数退避与抖动、Lease 硬过期清理、设备撤销和认证终止联动；临时故障保留桌面 Refresh Token，Entitlement/版本错误只清理 Runtime Lease。
- Python Runtime 对过期 Managed Session 惰性清理，状态接口继续只返回脱敏字段；Main 将 `managed_auth_refresh_required` 从普通 Assistant SSE 分流，成功或失败通过现有 `/v1/managed/auth-result` 回传，不进入 Renderer。
- P2-10 不新增 Flyway、Redis Key、Managed Service v1 公共字段或 Provider 数据面；真实 Managed Provider 触发点仍留给 P3。
- 验证记录：Managed Service v1 契约未变，Desktop/Cloud 消费快照仍为 33 个文件；`npm run typecheck`、`npm test`（149 项）、Runtime pytest（87 项）、契约 pytest（14 项）、检索评测（六项指标 1.0）、`npm run build` 和生产端点扫描均通过。
- 未运行项：Cloud `services/control-plane/.\mvnw.cmd test` 在当前机器未执行成功，环境仅有 JDK 17，而既有测试类为 Java 21 class version 65；待切换 JDK 21 后重跑，未修改 Cloud 代码或数据库。
- 源提交：`f4a9f87`；现有工作区改动和忽略文件全部保留。

### 2026-08-16（petdock-web 工程骨架与官网阶段交接）

- 在独立 `petdock-web` 仓库创建 Vite 7、React 19、TypeScript 5.9 的可启动工程骨架，并补充独立 `AGENTS.md` 与 README。
- `P2-W01` 至 `P2-W04` 的业务页面尚未开始；官网 Web API/Web Session 契约已在 `petdock-cloud` 权威源冻结，后续实现不得复用桌面 Bearer API 或臆造接口。
- 官网只使用 HttpOnly Web Session，不接收桌面 Refresh Token、Runtime Token 或 Provider Key；Entitlement/Usage 管理 API、支付闭环和正式域名/TLS 联调继续按阶段延后。

### 2026-08-16（官网 Web API、Session 与 CSRF 契约冻结）

- Cloud 权威源新增独立 `web-control-plane.yaml`、`WEB_IDENTITY_AND_SESSION.md`、Session Schema、匿名/已登录样例和官网错误码；Desktop 已整体同步 38 个契约文件。
- 官网固定使用 `__Host-petdock_web_session` HttpOnly Cookie、`X-PetDock-CSRF`、精确生产 Origin 和 `Cache-Control: no-store`；官网 API 与桌面 Bearer API 分离。
- 当前只冻结注册、登录、退出、资料和密码修改；邮箱验证、密码找回、MFA、支付、Entitlement/Usage 和自定义 OAuth Consent 延后。

### 2026-08-17（P2-W01 subject 决定同步）

- Cloud 冻结 `D-P2-14`：官网注册用户使用独立、不可变的 `usr_<UUID v4>` subject，不复用用户表主键、username 或邮箱。
- Desktop 同步 `DECISION_REGISTER.md` 和 `WEB_IDENTITY_AND_SESSION.md` 两份消费快照；不改变桌面代码、OpenAPI、数据库或 Token 契约。

### 2026-08-17（P2-W02 契约冻结）

- Cloud 权威源冻结标准 Authorization Consent、账号主机独立 Host-only Session、固定 SavedRequest 恢复和桌面 Client 授权语义，不新增 JSON Consent API。
- Desktop 整体同步 38 个 v1 受控文件并通过 SHA-256 比对；本次未修改 Desktop 业务代码，P2-W02 实现仍由 Web/Cloud 下一阶段完成。

### 2026-08-18（P2-W02 完成）

- Web/Cloud 完成 OAuth 登录、注册、标准 Consent、固定 SavedRequest 恢复、账号主机独立 Session 和脱敏授权审计。
- Desktop 按 loopback 回调中的标准 `error=access_denied` 映射 `authorization_denied`，不再依赖第三方库异常消息。
- 使用 Desktop 真实 OIDC、loopback、控制面和设备身份模块通过受信本地 HTTPS 门禁，覆盖 Token 交换、UserInfo、设备同步、Consent 复用、双 Host-only Cookie、撤销与拒绝授权。
- 最终门禁结果：Desktop Vitest 155 项、契约 16 项、Runtime 87 项；Web Vitest 22 项、Playwright Mock 6 项通过且 1 项按环境跳过；Cloud pytest 17 项、JDK 21 Maven 101 项全部通过，Testcontainers PostgreSQL/Redis 已实际运行；真实 HTTPS 跨端测试 2 项通过，Desktop/Cloud 38 个契约文件一致，Desktop/Web 生产依赖审计均为 0 漏洞。
- 正式公网域名、生产证书和打包版 Desktop 验收等待备案，不把设备管理、订单或用量页面计入 P2-W02。

### 2026-08-19（P2-W03 产品/API 契约冻结）

- Cloud 权威源冻结 Web Session 下的服务方案、活动设备分页、单设备撤销和全部设备撤销接口，Desktop 整体同步 41 个 v1 受控文件。
- 服务快照区分 `inactive`、`subscription` 和 `pay_as_you_go`；用户显式选择订阅或按量且不自动切换，当前免费 Beta 只开放订阅模式。
- 按量模式不关联套餐或套餐有效期，`plan=null`、`expiresAt=null`、`remaining=null` 只表示按实际用量结算；价格、开通、支付、结算和账单继续留给 Phase 5。
- 三语言契约测试、41 文件制品校验、Desktop 快照比对和 Web 测试/生产构建通过；本次未修改 Desktop 业务代码，P2-W03 Cloud/Web 业务实现尚未开始。

### 2026-08-19（备案完成与正式域名联调准备）

- ICP 备案、正式 DNS 和 TLS 条件已具备，历史阶段当时的“等待备案”记录保持不变。
- Cloud 新增 `docs/guides/PRODUCTION_DEPLOYMENT_AND_ONLINE_INTEGRATION.md` 作为三仓正式部署、来源 IP 白名单线上联调、回滚和后续迭代的权威步骤。
- 日常开发继续使用本地 Mock/Testcontainers 和 `shared-dev`；当前 `staging` 仍固定正式端点，不能作为独立公网预发布环境。
- 普通用户流量仍未开放，待生产 PostgreSQL/Redis/JWT 密钥隔离、Nginx 精确路由及打包版 Desktop 门禁通过后再决定。

### 2026-08-20（正式域名受限线上门禁完成）

- 使用正式 HTTPS 域名完成受限线上联调；普通用户公网流量的生产策略保持不变。
- Desktop 真实 OAuth Authorization Code + PKCE、loopback 回调、Consent 同意/拒绝、Refresh、UserInfo、设备同步、退出后重新登录和账号切换均通过。
- 官网真实登录、账号主机独立 Session、OAuth 登录恢复、服务快照、设备分页、单设备撤销和全部设备撤销均通过；撤销传播后的 Desktop 重新认证行为正常。
- 线上 PostgreSQL/Redis 事实与撤销投影链路已完成验证；记录未包含 Token、Cookie、密码、授权参数、生产日志或真实账号信息。
- 正式域名受限线上门禁由“待完成”更新为“通过”；下一工作项仍为 P2-W04，完成后再实施 Desktop P2-11。

### 2026-08-20（P2-W04 方案冻结）

- 三仓 P2-W04 方案已输出于 `petdock-web/docs/plans/P2_W04_DEVELOPMENT_PLAN.md`，Desktop 本期只复核生产端点固定、Main-only Token 边界和发布制品扫描，不实现 P2-11。
- P2-W04 实现与自动门禁已完成；Desktop P2-11 等待正式评审后立项。

### 2026-08-20（P2-W04 实现与收尾完成）

- Desktop 打包构建强制 production 端点；Cloud 分离 Desktop/API Bearer、官网 Web Session 和 OAuth `/oauth/resume` 安全链，并增加 Web Session 越界访问 Desktop API 的回归测试。
- Web 请求层仅允许官网 Web API 相对路径，生产 Origin 固定为官方控制面/账号主机；Nginx 与 Vite 代理改为 OAuth、Discovery、JWKS、userinfo 和账号 Session 的精确路径与方法限制，未知路径保持 `404`。
- 自动门禁已按本次实际结果记录：Desktop 159/17/87，Web 35、E2E 10 通过/1 跳过，Cloud pytest 18、Maven 120 中 115 通过/5 跳过、41 个契约文件一致；5 项 Cloud Testcontainers 集成测试因本机无可用 Docker 跳过。
- 本轮未在本机重新部署正式域名；线上结果沿用 2026-08-20 已完成的受限门禁，新版本上线后需按生产指南重跑 Desktop PKCE、账号切换、撤销和未知路径 `404` 冒烟。
- P2-W04 标记为 `Done`；P2-11、Usage、支付和 FastAPI AI 数据面继续延后，普通用户公网流量保持受控。
