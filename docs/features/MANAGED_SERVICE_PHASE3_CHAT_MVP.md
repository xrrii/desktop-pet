# PetDock Managed Service Phase 3 Chat MVP 开发方案

- 最后更新：2026-08-20
- 状态：`Decision Frozen`（实现尚未开始）
- 适用仓库：`petdock-cloud`、`desktop-pet`、`petdock-web`
- 权威契约：`petdock-cloud/contracts/managed-service/v1`
- 前置条件：Phase 0、Phase 1、Phase 2 均为 `Done`

## 1. 目标

Phase 3 打通第一条真实 Managed AI 流量，只开放 Chat。用户继续在本地 Runtime 中使用现有 Agent、Memory、RAG、附件、Skill 和工具循环；官方云端只负责模型调用、授权、Beta 配额与用量事实，不复制本地 Agent，也不获得本地工具执行权限。

本阶段完成后应满足：

1. 已登录且获得白名单 Beta 授权的桌面用户可以显式选择“官方 Chat”。
2. Python Runtime 使用 Main 注入的短期 Runtime Token 调用 FastAPI 数据面。
3. Chat 支持流式文本、结构化 ToolCall、多轮工具调用、取消和稳定错误映射。
4. Spring Boot 对每个逻辑请求执行幂等预占、结算或释放，并提供真实用量摘要。
5. BYOK 与 Managed 彼此隔离；Managed 故障、关闭或额度耗尽时不自动使用用户的 BYOK Key。
6. Prompt、回答、附件正文、知识片段和工具结果正文不进入默认日志或服务端持久化。
7. 通过 Docker 受限线上门禁后才允许白名单 Beta 流量；普通用户不因代码部署自动获得 Managed Chat。

## 2. 当前基线

Phase 3 直接复用以下既有实现，不重新设计：

- Desktop 已具备 OAuth PKCE、loopback、Refresh Token `safeStorage`、UserInfo、设备同步、撤销和账号切换。
- Electron Main 已具备 Runtime Token Broker、三分钟提前刷新、本地 Session Bridge、任务内认证刷新协调、离线退避和并发刷新保护。
- Main 已是能力来源设置的唯一持久化所有者，现有枚举已经包含 `chat=managed`。
- Python Runtime 已保留 `ChatModelFactory`、本地 Agent、工具循环和 SSE 协议，Managed 来源目前明确失败关闭。
- Cloud 已签发 RS256 Runtime Token，并具备 JWKS、Runtime Session、Entitlement、设备撤销和 Redis 撤销投影。
- v1 已定义 `/ai/v1/chat/completions`、请求链路标识、Chat SSE 事件、Usage Event、错误码和 `/api/v1/usage/summary` 草案。
- Web 已有稳定 `/account/usage` 路由，在真实 Usage Summary 接入前不展示假数字。

当前缺口是：FastAPI 数据面尚未建立；数据面到控制面的内部配额协议尚未冻结；Managed Chat 独立 Feature Flag 尚未进入契约；桌面 Runtime 尚无 Managed Chat Provider；用量表、预占状态机和真实摘要尚未实现。

## 3. 范围边界

### 3.1 本期实现

| 领域 | 交付 |
| --- | --- |
| 契约 | Chat 请求、SSE 顺序、链路 ID、Managed Chat 开关、内部预占/结算协议和真实 Usage Summary |
| FastAPI | Runtime Token/JWKS/撤销校验、Chat 流式代理、单一 Provider Adapter、取消、超时和错误归一化 |
| Spring Boot | Chat Entitlement、Beta 配额预占/结算/释放、追加写 Usage Event、桌面与 Web 用量摘要 |
| Desktop Runtime | `ManagedChatProvider`、SSE 解析、ToolCall 映射、任务内认证刷新、取消和错误映射 |
| Electron Main/UI | Managed Chat 开关、来源选择、状态、额度摘要、官网管理入口和手动切回 BYOK |
| Web | `/account/usage` 接入真实控制面摘要；不调用 AI 数据面 |
| 部署 | 独立 `ai-gateway` Docker 容器、精确 Nginx 路由、健康检查、受限白名单和回滚开关 |

### 3.2 明确不做

- 不实现 Managed Embedding、Vision、Rerank 或 Web Search。
- 不把本地 Agent、工具执行、Memory、RAG、附件库、Skill 包或会话数据库迁移到云端。
- 不持久化 Prompt、回答、工具参数、工具结果、附件正文或知识片段正文。
- 不实现充值、订单、退款、发票、正式按量计费、正式收费账本或生产级成本对账。
- 不实现跨 Provider 自动切换、自动容灾、应用集群或跨区域部署。
- 不在官网浏览器调用 FastAPI，也不向 Renderer 暴露 Runtime Token、Provider 名称、内部模型名或额度配置细节。
- 不自动从 Managed 回退到 BYOK，也不自动消耗用户的 BYOK Key。

## 4. 冻结决策

### 4.1 调用与所有权

```text
Renderer
  -> Electron Main
  -> 本地 Python Runtime（本地启动 Token）
  -> FastAPI AI Data Plane（官方 Runtime Token）
  -> 官方上游 Provider

FastAPI
  -> Spring Boot 内部配额接口（容器内网 + 服务身份）
  -> Redis 撤销投影（失败关闭）
  -> JWKS（只读公钥）
```

- Electron Main 继续持有 Refresh Token，并只把短期 Runtime Token 注入 Python 内存。
- Python Runtime 直接调用 AI 数据面；Spring Boot 不代理 SSE，不进入 Token 流式热路径。
- FastAPI 在调用 Provider 前向 Spring Boot 预占，结束后结算、释放或标记失败。
- Spring Boot/PostgreSQL 是 Entitlement、配额和 Usage 的事实源；Redis 只保存限流与可重建撤销缓存。
- 数据面到控制面的内部接口不经公网 Nginx 暴露，使用独立服务身份；服务凭据只通过 Docker Secret 或受控环境注入。

### 4.2 首批能力

- Capability 固定为 `chat`。
- 逻辑模型固定为 `chat-standard`。
- 只接入一个服务端 Provider Adapter，不自动切换备用 Provider。
- 实际 Provider、模型、上游地址、凭据、上下文窗口、单请求输出上限和 Beta 月额度只存在于服务端安全配置，不进入公开契约、客户端响应或日志。
- 当前只允许白名单免费 `Beta` 套餐和 `subscription` 配额模式；`pay_as_you_go` 不开放。

### 4.3 Feature Flag

`GET /api/v1/features` 在 v1 中增加可选响应字段 `managed_chat_enabled`：

- 旧客户端忽略未知字段，现有 `managed_login_enabled` 语义不变。
- 新客户端将字段缺失、类型错误、请求失败或版本不兼容统一按 `false` 处理。
- `managed_login_enabled=true` 不代表 Chat 可用；Chat 必须同时满足登录、`managed_chat_enabled`、Entitlement、客户端支持和数据面实时可用。
- 服务端和 Desktop 都保留独立紧急关闭开关。关闭 Chat 不清除登录态、BYOK 配置或本地会话。

### 4.4 链路标识

| 标识 | 生命周期 | 生成方 | 幂等用途 |
| --- | --- | --- | --- |
| `trace_id` | 一次本地用户任务，跨多轮工具调用 | Python Runtime | 串联同一任务的模型调用 |
| `request_id` | 一次逻辑模型调用；每轮工具续推使用新值 | Python Runtime | 配额预占与最终状态唯一键 |
| `attempt_id` | 一次 HTTP/Provider 尝试 | Python Runtime；重试时更新 | 区分认证重试和传输尝试 |
| `usage_event_id` | 一条追加写 Usage Event | Spring Boot | Usage Event 去重 |

任务内 Token 刷新只允许在尚未输出文本或 ToolCall 时发生一次：保持原 `request_id`，生成新 `attempt_id`。其他 Provider、限流、超时或断流错误在 Phase 3 不自动重试；用户重新发送时生成新的 `request_id`。

### 4.5 SSE 协议

- HTTP Header 发送前的校验失败使用现有 `ErrorEnvelope`。
- HTTP 200 建立后，所有业务结果只通过版本化 SSE 事件返回。
- `sequence` 从 1 开始严格递增；`traceId` 和 `requestId` 必须与请求一致。
- 流中可以有多个 `delta`，也可以返回一个或多个 `tool_call`。
- 若 Provider 给出可靠用量，发送一个 `usage` 事件。
- 每条流必须且只能有一个终止事件：`completed` 或 `error`；终止后不得继续发送事件。
- `completed.finishReason` 只使用 `stop`、`tool_calls` 或 `cancelled`。
- 已发送任意 `delta` 或 `tool_call` 后禁止静默从头重放。
- 客户端断开连接必须取消 Provider 任务；取消结果仍按是否调用过上游进入对应用量终态。

### 4.6 工具边界

- Runtime 只向数据面提交现有固定工具定义的模型可见 Schema。
- 数据面只把工具定义传给 Provider，并返回结构化 ToolCall；不执行任何工具。
- Runtime 继续校验工具名、参数对象和大小；Electron Main 继续执行风险分级、用户确认和本地工具调用。
- 每轮工具结果回传会形成新的逻辑模型调用和新的 `request_id`，但复用同一 `trace_id`。

## 5. `P3-00` 契约闭合门禁

任何业务实现开始前，先在 Cloud 权威源完成以下兼容性修改，并整体同步 Desktop 消费快照：

1. 在 `DECISION_REGISTER.md` 增加 Phase 3 调用拓扑、Feature Flag、幂等配额、失败结算和日志边界决定。
2. 完善 `ai-data-plane.yaml`：Phase 3 只开放 Chat、Capabilities 和 Health；严格定义工具 Schema、SSE 终止规则、请求体预算和错误映射。
3. 在 `control-plane.yaml` 为 `FeatureFlagSnapshot` 增加可选 `managed_chat_enabled`，并保持 `version=1` 与旧客户端兼容。
4. 新增仅容器内网使用的内部控制面 OpenAPI，冻结预占、结算、释放、失败和幂等冲突语义。
5. 为 Web 增加真实 `/api/v1/web/usage/summary` 契约；响应只包含用户可理解的周期、已用、剩余和单位。
6. 加强 Chat SSE、Usage Event、Request Context 固定样例和 Python/TypeScript/Spring 跨语言测试。
7. 更新错误码，明确流前 HTTP 错误、流内错误和未知错误降级行为。
8. 契约版本仍为 v1；只增加可选响应字段和新接口，不改变已发布字段语义。

`P3-00` 完成标准：Cloud 契约测试、Spring 固定样例测试、Desktop 契约测试和逐文件 SHA-256 比对全部通过，三仓生成类型一致。

## 6. 配额与 Usage 状态机

### 6.1 数据模型

Spring Boot 至少新增：

- `usage_reservations`：每个 `request_id` 一条当前状态，保存用户、设备、Runtime Session、能力、逻辑模型、请求指纹、预占单位和终态。
- `usage_events`：追加写原始事件，字段与 `usage-event.schema.json` 对齐。
- 月度摘要查询所需索引；不建立正式金额账本、价格表或支付流水。

请求正文和 Token 不进入上述表。用户、设备和 Session 使用内部 ID；日志只使用不可逆哈希或链路 ID。

### 6.2 状态转换

```text
不存在 -> reserved
reserved -> settled
reserved -> released
reserved -> failed
```

- `reserved`：完成 Token、设备、Session、Entitlement、版本和额度校验后原子预占。
- `settled`：Provider 返回可靠 input/output Token，用实际值结算并释放未使用的预占量。
- `released`：明确证明尚未调用 Provider，例如鉴权、请求校验或连接准备失败。
- `failed`：已经调用 Provider，但无法获得可靠实际用量；Beta 阶段保守保留预占量，防止故障被用于超额调用。Phase 5 再实现自动补偿和人工修复流程。

### 6.3 幂等规则

- `request_id` 是预占唯一键。
- 同一 Runtime Session、同一请求指纹和同一 `request_id` 的重复预占返回既有结果，不重复扣减。
- 同一 `request_id` 携带不同用户、Session、逻辑模型或请求指纹时返回稳定幂等冲突，不调用 Provider。
- `settled`、`released`、`failed` 是互斥终态；重复提交同一终态幂等成功，不同终态冲突并产生脱敏告警。
- `attempt_id` 只区分尝试，不创建第二份预占。
- 每次状态变化生成新的 `usage_event_id` 并追加写事件；数据库唯一约束阻止重复事件。

### 6.4 预占计算

- FastAPI 在请求校验后，按服务端配置的输入估算和最大输出预算请求预占。
- Provider 调用必须设置与预占一致的最大输出限制，避免正常完成时超出预占。
- 具体 Beta 月额度、Tokenizer、上下文窗口和最大输出值是服务端配置，不写入公共契约。
- 配额不足返回 `quota_exhausted`，不得调用 Provider，也不得自动转用 BYOK。

## 7. FastAPI AI 数据面

### 7.1 工程边界

在 `petdock-cloud/services/ai-gateway` 建立独立 FastAPI 服务，建议模块：

```text
app/
  api/             Chat、Capabilities、Health
  auth/            JWT/JWKS、Claims、撤销检查
  control_plane/   内部预占与结算客户端
  providers/       单一 Chat Provider Adapter
  streaming/       SSE 编码、顺序和断连取消
  errors/          稳定错误映射
  observability/   脱敏日志和指标
```

- JWT/JWK/RS256 使用持续维护的 JOSE/密码库，不手写签名或 ASN.1 解析。
- Provider 调用优先使用官方 SDK；若 SDK 无法可靠处理取消和流式 ToolCall，则使用 `httpx` 的受控适配器。
- 请求和响应使用 Pydantic 严格模型；未知认证字段、未知逻辑模型和超预算请求直接拒绝。

### 7.2 Runtime Token 校验

依次校验：

1. Header `alg=RS256`、`typ=JWT`、非空 `kid`。
2. 签名、Issuer、Audience、`iat`、`exp` 与 60 秒最大时钟偏差。
3. `jti`、`sid`、`user_id`、`device_id`、`capabilities` 和 `entitlement_version`。
4. Capability 必须包含 `chat`，逻辑模型必须为 `chat-standard`。
5. Redis 撤销投影中的设备、Session、`sid` 和 `jti`；缓存不超过 30 秒。
6. 内部预占时由控制面再次验证 Runtime Session、当前 Entitlement 版本和额度。

未知 `kid` 只允许立即刷新 JWKS 一次；刷新后仍未知则拒绝。JWKS、Redis 或内部控制面不可用时 Managed 失败关闭，BYOK 不受影响。

### 7.3 超时和取消

- 首 Token 超时、流空闲超时和总超时均通过服务端配置设置，并受总时长不超过 5 分钟的契约上限约束。
- 客户端断连、Runtime 取消、本服务超时和容器关闭都必须取消上游任务。
- Provider 尚未调用时释放预占；已调用且有可靠用量时结算；已调用但用量未知时进入 `failed`。
- Phase 3 不做 Provider 自动重试或跨 Provider 切换。

### 7.4 日志和指标

允许记录：链路 ID、能力、逻辑模型、Provider 配置别名、耗时、首 Token 时间、Token 数、终态、稳定错误码和重试次数。

禁止记录：Authorization Header、Runtime Token、Cookie、Provider 凭据、Prompt、回答、工具参数、工具结果、附件正文、知识片段、完整请求体和完整上游响应。

## 8. Spring Boot 控制面

### 8.1 模块职责

- `entitlement`：确认白名单 Beta 套餐、Chat Capability 和当前版本。
- `quota`：原子预占、终态转换和额度拒绝。
- `usage`：追加写原始事件、桌面摘要和 Web 摘要。
- `session`：复核 Runtime Session、设备和撤销状态。
- `feature`：下发 `managed_chat_enabled`，默认关闭。
- `audit`：记录配额拒绝、幂等冲突和管理开关变更，不记录正文或凭据。

### 8.2 事务边界

- 预占、当前状态和 `reserved` Usage Event 在同一数据库事务中完成。
- 结算、释放或失败状态与对应 Usage Event 在同一事务中完成。
- 摘要只读取已提交事实，不从 Redis、日志或 Provider 响应临时拼装。
- Testcontainers PostgreSQL 必须覆盖 Flyway、唯一约束、并发预占、重复终态、额度耗尽和月度边界。

### 8.3 用量摘要

- Desktop `GET /api/v1/usage/summary` 使用 OAuth Access Token。
- Web `/api/v1/web/usage/summary` 使用现有 HttpOnly Session 与 CSRF 边界；只读 GET 不新增浏览器 Token。
- 摘要只展示当前周期、Chat 已用、剩余和 `tokens` 单位，不显示 Provider 成本、内部价格或虚构趋势。
- 无有效 Beta Entitlement 时返回稳定未授权状态，不展示全零假数据。

## 9. Desktop Runtime 与 Main

### 9.1 `ManagedChatProvider`

- 在现有 `ChatModelFactory` 下增加 Managed Adapter，不复制 `LangChainBackend` 的 Agent 与工具循环。
- Adapter 实现现有 `AgentChatModel.astream` 最小端口，将 LangChain 消息和固定工具定义转换为 v1 Chat 请求。
- 将 Managed `delta` 与 `tool_call` 转回现有模型块，使 `LangChainBackend` 继续负责本地历史、RAG、Skill、工具等待和持久化。
- Managed 首版后台 Memory 提取继续使用现有本地规则，不额外产生隐藏云端调用和用量。
- 严格解析 SSE：校验版本、序号、链路 ID、终止事件和大小预算；未知关键事件失败关闭。

### 9.2 Token 与认证刷新

- Provider 每次调用前从 `ManagedSessionStore` 读取当前内存 Lease，不缓存到磁盘或业务数据库。
- Main 在任务开始前保证 Lease 剩余不少于三分钟。
- 流前收到 `token_expired` 时，Runtime 发出既有 `managed_auth_refresh_required`，等待 Main 刷新后使用原 `request_id` 和新 `attempt_id` 重试一次。
- 已输出文本或 ToolCall 后收到认证错误，返回 `authentication_expired_during_stream`，不重放。
- 刷新失败不自动切换 BYOK。

### 9.3 Main 与 Renderer

- `CapabilitySettingsManager` 继续保存用户选择；Managed 实际来源由 Chat 开关、登录、Runtime Session、Entitlement 和数据面状态共同决定。
- Renderer 只接收脱敏的来源、状态、原因和用量摘要。
- 设置页提供 BYOK/官方 Chat 选择、登录状态、官方 Chat 状态、剩余额度、“前往官网管理”和“切回 BYOK”。
- 不展示实际 Provider、内部模型名、Provider Key、Runtime Token、Session ID、用户 ID 或设备 ID。
- 用户选择 Managed 但当前不可用时显示稳定原因，不静默修改用户选择；实际调用保持失败关闭。

## 10. Web

- 继续只调用 Spring Boot Web API，不调用 `ai.petdock.site`。
- `/account/usage` 接入真实 Usage Summary 后才展示周期、已用和剩余。
- 登录失效、未开通、额度耗尽和服务不可用分别显示真实状态，不使用 `0`、模拟图表或假账单。
- 不在 Phase 3 增加充值、订单、支付、退款、账单导出或按量开通操作。

## 11. Docker、Nginx 与发布

- 新增独立 `ai-gateway` 镜像和 Compose 服务；业务端口只暴露在容器网络。
- `ai.petdock.site` 只精确开放：
  - `POST /ai/v1/chat/completions`
  - `GET /ai/v1/capabilities`
  - `GET /ai/v1/health`
- Phase 4 端点和未知路径保持 `404`；不开放内部配额接口、文档 UI、调试端点或管理端点。
- Chat 路由关闭代理缓冲和缓存，保留流式连接；请求体、连接、首字节、空闲和总超时按数据面预算设置。
- 首次部署保持 `managed_chat_enabled=false`，先验证健康、JWKS、撤销、内部配额和假 Provider，再对白名单账号开启。
- 回滚时先关闭 Managed Chat 开关，再回滚数据面；登录、官网和 BYOK 保持可用。

## 12. 实施顺序

### 门禁 A：`P3-00` 契约闭合

完成第 5 节全部契约、样例、错误和跨语言快照；未通过前不创建生产数据库迁移或真实 Provider 调用。

### 波次 B：Cloud 安全与事实源

1. `P3-01`：FastAPI Runtime Token、JWKS、撤销和失败关闭。
2. `P3-07`：Chat Entitlement 和白名单 Beta 授权。
3. `P3-08`：预占、结算、释放、失败与追加写 Usage Event。
4. `P3-09`：Desktop/Web 真实 Usage Summary。

### 波次 C：Cloud Chat 数据面

1. `P3-02`：Chat SSE 接口。
2. `P3-03`：`chat-standard` 和单一 Provider Adapter。
3. `P3-04`：取消、首 Token、空闲、总超时和断流。
4. `P3-05`：链路 ID、幂等 Usage 与稳定错误码。
5. `P3-06`：日志最小化、指标和敏感内容回归测试。

波次 B 与 C 可使用假 Provider 联调，但真实 Provider 调用必须等待预占事实源完成。

### 波次 D：Desktop Runtime

1. `P3-10`：`ManagedChatProvider`。
2. `P3-11`：复用现有 Agent、工具循环和本地 SSE。
3. `P3-12`：流前一次认证刷新与同请求重试。
4. `P3-13`：官方错误映射和取消传播。

### 波次 E：Desktop/Web 产品入口

1. `P3-14`：来源选择、登录、状态、额度摘要和官网管理入口。
2. `P3-15`：明确的手动切回 BYOK 操作。
3. `P3-16`：Provider 与内部模型信息隐藏。
4. Web `/account/usage` 接入真实摘要。

### 门禁 F：Docker 与受限线上 Beta

按第 14 节完成自动门禁、跨端联调、撤销传播、配额并发和回滚演练后，才可对白名单账号开启。

## 13. 测试矩阵

### 13.1 Cloud

- 契约：OpenAPI、JSON Schema、固定样例、错误码、跨语言生成类型和制品清单。
- FastAPI 单元测试：JWT Header、算法降级、未知 `kid`、时钟偏差、Claims、撤销缓存和失败关闭。
- FastAPI 流测试：delta、ToolCall、usage、终止顺序、断流、取消、超时和非法 SSE。
- Provider Adapter：使用仓库内假 Provider，不连接真实生产模型。
- Spring/JUnit：Entitlement、Feature Flag、摘要、错误映射和审计脱敏。
- Testcontainers PostgreSQL/Redis：Flyway、并发预占、幂等、互斥终态、额度耗尽、撤销传播和月度边界。
- Docker：ai-gateway 健康检查、只读文件系统、非 root、资源上限和精确网络边界。

### 13.2 Desktop

- Main：Feature Flag 缺失关闭、能力交集、Runtime Token 刷新、撤销、退出和切换来源。
- Runtime：Managed Chat 请求、SSE 解析、ToolCall、多轮工具、取消、流前认证刷新和流中认证失败。
- 回归：BYOK Chat、Memory、RAG、附件、Skill、文件生成和本地工具协议不变。
- 打包态：生产端点固定、开发覆盖拒绝、无 Token/Provider 凭据/内部模型名/Source Map。

### 13.3 Web

- Session 与 CSRF 无回归。
- Usage 页面只读取真实摘要，并正确显示未开通、可用、耗尽和服务失败。
- 浏览器不能访问内部配额接口，官网代码不引用 AI 数据面或 Desktop Token。

### 13.4 跨端与线上

- Feature Flag 关闭时 Managed Chat 不可选，BYOK 正常。
- 白名单用户登录后可选择 Managed，流式文本和多轮 ToolCall 正常。
- 取消能中断 Runtime、FastAPI 和 Provider，Usage 进入正确终态。
- 同一 `request_id` 并发或重试不重复预占；不同请求额度原子扣减。
- 流前 Token 过期只刷新重试一次；流中 Token 过期不重放。
- 额度耗尽、Provider 超时、无效响应、网络中断和断流映射稳定。
- 单设备、全部设备和 Runtime Session 撤销在最长 30 秒窗口内阻止新请求。
- Web 与 Desktop 用量摘要来自同一 PostgreSQL 事实。
- Nginx 未识别路径、错误方法、Phase 4 端点和内部接口均拒绝。
- 日志、审计、数据库和构建产物不包含 Token、Cookie、Provider 凭据或用户正文。

## 14. 验证命令与门禁

### Desktop

```powershell
npm run typecheck
npm test
npm run test:contracts
npm run test:runtime
npm run test:retrieval
npm run build
npm audit --omit=dev --audit-level=high
```

打包验收继续执行 `npm run dist`，并扫描生产制品。

### Web

```powershell
npm test
npm run build
npm run test:e2e
npm run check:nginx
npm audit --omit=dev --audit-level=high
```

### Cloud

```powershell
python -m pytest
python tools/compare_contract_snapshot.py ..\..\desktop-pet
```

使用 JDK 21 在 `services/control-plane` 执行：

```powershell
.\mvnw.cmd -q test
.\mvnw.cmd -q -DskipTests package
```

ai-gateway 增加独立 pytest、类型检查、生产镜像构建和依赖审计命令。Docker 可用时，PostgreSQL/Redis Testcontainers 必须实际运行；否则该次不能记为完整 Phase 3 生产门禁。

三仓最终执行 `git diff --check`、`git status --short --ignored`、契约 SHA-256 比对和敏感内容扫描。禁止在记录中保存 Token、Cookie、密码、Provider 凭据、Prompt、回答、完整跳转地址、真实账号、生产日志或真实环境连接信息。

## 15. 完成定义

Phase 3 只有同时满足以下条件才可标记为 `Done`：

- `P3-00` 与 `P3-01` 至 `P3-16` 全部完成。
- Cloud 权威契约、Desktop 快照和 Web 生成类型一致。
- Runtime Token、JWKS、撤销、Entitlement、配额和 Usage 的失败关闭可由测试证明。
- 官方 Chat 支持流式文本、取消和多轮本地 ToolCall。
- BYOK 全量回归通过，Managed 失败不会修改或消耗 BYOK 配置。
- Web/Desktop 展示真实且一致的用量摘要，不展示假数据或 Provider 内部信息。
- Docker、Nginx、生产构建、依赖审计、日志脱敏和备份门禁通过。
- 使用合成账号完成受限正式 HTTPS 联调和回滚演练。
- Windows 安装制品通过生产端点、签名、安装/升级和打包态跨端验收。
- 普通用户流量仍由独立发布决定；完成代码和白名单 Beta 不等于正式收费上线。

## 16. 回滚

1. 将服务端 `managed_chat_enabled` 关闭，停止新 Managed Chat 请求。
2. 保留登录、设备、Entitlement、Usage 事实和 BYOK 配置，不删除用户本地数据。
3. 等待或主动取消现有数据面请求，再回滚 ai-gateway 镜像。
4. 数据库迁移只允许向后兼容 expand/contract；已写 Usage Event 不通过回滚删除。
5. 若控制面仍可用，Desktop 显示官方 Chat 暂不可用并提供手动切回 BYOK。
6. 回滚后复验 OAuth、官网、设备撤销、BYOK Chat 和未知路径拒绝。

## 17. 剩余发布配置

以下值不进入公共契约，必须在真实 Provider 联调或白名单放量前由项目负责人通过服务端安全配置提供：

- 实际 Chat Provider、模型、境内上游地址和凭据。
- `chat-standard` 的上下文窗口、Tokenizer 和最大输出预算。
- 首 Token、流空闲和总超时具体值，总时长不得超过 5 分钟。
- 白名单 Beta 月额度、白名单用户和放量比例。
- 服务间身份 Secret、Provider Secret 和主机外备份配置。

缺少上述真实值不阻塞契约、假 Provider、配额状态机和 Desktop Adapter 开发，但阻塞真实 Provider 调用与线上放量。任何值都不得写入仓库、镜像层、客户端响应或测试快照。
