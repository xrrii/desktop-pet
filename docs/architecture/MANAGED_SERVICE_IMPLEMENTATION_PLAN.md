# PetDock BYOK 与官方服务双模式实施方案

## 1. 文档状态

- 状态：实施基线
- 适用范围：PetDock Desktop、官网账号系统、Spring Boot 控制面、FastAPI AI 数据面
- 当前基线：桌面端使用 Electron Main + Python Runtime，本地 Runtime 已按 `api`、`agent`、`providers`、`rag` 等领域拆分
- 目标：在不破坏现有 BYOK 能力的前提下，增加官网登录和官方托管模型能力

本文档用于指导后续设计、拆分任务、接口评审、实现、测试和上线。除非经过新的架构评审，不应在开发过程中绕过本文档定义的信任边界和依赖方向。

## 2. 背景与目标

当前 PetDock 主要采用 BYOK（Bring Your Own Key）模式：用户自行配置主模型、在线 Embedding、视觉模型和联网搜索等能力。该模式具有成本透明、供应商自由和数据路径明确等优点，但配置门槛较高。

后续需要增加官方服务模式：

1. 用户通过 PetDock 官网账号登录桌面端。
2. 桌面端获得设备级凭据和短期 Runtime Token。
3. Chat、Embedding、Vision、Web Search 等被启用的能力通过 PetDock 官方后端调用。
4. 用户可以关闭未授权或不希望使用的官方能力。
5. 现有 BYOK 用户可以继续使用原有配置，不被强制迁移。
6. 本地附件、知识库、记忆、Skill 和系统工具仍由本地 Runtime 与 Electron Main 管理。

成功标准不是简单增加一个远程接口，而是形成一套可长期演进、可审计、可限额、可回滚的双模式能力架构。

## 3. 核心架构决策

### 3.1 一套 Assistant Core，两类能力来源

BYOK 和官方服务不得实现为两套独立 Assistant。两种模式必须复用同一套本地任务编排、Prompt、RAG、Memory、Skill 和工具协议，仅在能力 Provider 层分流。

```text
Local Assistant Core
  ├─ BYOK Provider
  ├─ Managed Provider
  ├─ Local Provider
  └─ Disabled Provider
```

这样可以避免本地 Agent 与云端 Agent 出现 Prompt、工具循环、引用格式和权限行为不一致的问题。

### 3.2 本地 Runtime 继续负责 Agent 编排

第一阶段及中期版本中，下列能力继续在本地执行：

- 会话任务和 SSE 事件编排
- Agent 有限工具循环
- 本地附件解析和会话临时索引
- 本地知识库、向量库和引用选择
- 会话记忆和长期偏好
- Skill 安装、激活和资源读取
- Artifact 生命周期
- Electron Main 工具确认和本地系统操作

官方 FastAPI 后端首先作为 AI 能力数据面，不重新实现完整 Agent。未来确有服务端长任务需求时，再单独评审服务端 Agent。

### 3.3 永久唯一密钥不能作为登录密码

“官网登录后获取唯一密钥”在实现中拆分为以下概念：

- `user_id`：官网用户身份。
- `device_id`：一次桌面安装或受信设备的唯一标识。
- Refresh Token：由 Electron Main 使用 `safeStorage` 加密保存。
- Runtime Token：短期、可撤销、带能力范围的访问令牌。
- Provider Key：官方后端保存的上游模型密钥，永远不下发到客户端。

用户登录采用系统浏览器中的 OAuth 2.1/OIDC Authorization Code + PKCE 流程。第一版桌面回调建议使用仅监听 `127.0.0.1` 随机端口的 loopback redirect，避免自行设计账号密码协议。

如果产品需要展示“设备密钥”，它只能用于设备识别、恢复提示或人工支持，不能直接换取无限期模型调用权限。

### 3.4 控制面与数据面分离

Spring Boot 负责账号、授权、套餐、配额和设备等控制面业务；FastAPI 负责低延迟、流式的模型能力调用。二者通过签名令牌、内部接口和用量事件协作。

### 3.5 契约优先

桌面端、Spring Boot 和 FastAPI 不复制彼此的 DTO 源码。跨语言协议统一由以下内容定义：

- OpenAPI
- JSON Schema
- 稳定错误码
- 事件版本
- 向后兼容规则

接口变更必须先更新契约和契约测试，再修改服务实现。

## 4. 范围与非目标

### 4.1 本计划包含

- BYOK 与官方服务能力选择
- 官网登录、设备注册、Token 刷新和注销
- 官方 Chat、Embedding、Vision、Rerank、Web Search 能力
- 套餐授权、能力开关、限额和用量记录
- Provider 路由、超时、重试、熔断和错误归一化
- 本地配置迁移、灰度发布和回滚
- 全链路日志、指标和安全审计

### 4.2 第一阶段不包含

- 将本地知识库原文件长期上传到云端
- 将本地 SQLite、Chroma、Skill 包同步到云端
- 让官方后端直接操作用户电脑、文件或应用
- 云端保存完整会话正文作为默认行为
- 多端会话同步
- 对外开放用户可编程 API Key
- 完整服务端 Agent 平台
- 一开始就实现复杂的多供应商成本优化算法

## 5. 目标架构

```mermaid
flowchart LR
    Renderer["Renderer 设置与会话 UI"] --> Main["Electron Main"]
    Main --> Runtime["本地 Python Runtime\nAssistant Core"]
    Main --> Auth["网页登录与凭据管理"]

    Runtime --> Select{"Capability Selector"}
    Select --> BYOK["BYOK Adapters"]
    Select --> Managed["Managed Adapters"]
    Select --> Local["Local Adapters"]
    Select --> Disabled["Disabled"]

    BYOK --> Upstream["用户选择的模型供应商"]
    Managed --> Gateway["官方 API Gateway"]
    Gateway --> Spring["Spring Boot Control Plane"]
    Gateway --> FastAPI["FastAPI AI Data Plane"]
    FastAPI --> Providers["官方上游模型供应商"]

    Runtime --> LocalData["本地附件 / RAG / Memory / Skills"]
    Runtime --> MainTools["Electron Main 本地工具"]
```

### 5.1 请求路径

```mermaid
sequenceDiagram
    participant UI as Renderer
    participant Main as Electron Main
    participant RT as Python Runtime
    participant GW as Official Gateway
    participant AI as FastAPI
    participant Model as Model Provider

    UI->>Main: 发送用户消息
    Main->>RT: POST /v1/chat
    RT->>RT: 本地 Memory / RAG / Skill 编排
    RT->>GW: Chat 请求 + Runtime Token
    GW->>AI: 已鉴权请求
    AI->>Model: 流式模型调用
    Model-->>AI: Token Stream
    AI-->>RT: 标准流式响应
    RT-->>Main: SSE 文本或 ToolCall
    Main->>Main: 权限确认并执行本地工具
    Main->>RT: ToolResult
    RT->>GW: 继续模型推理
    RT-->>UI: 最终事件
```

官方后端只看到完成模型调用所必需的输入，不获得本地工具执行权限。

## 6. 能力与模式模型

### 6.1 能力类型

首批统一以下能力：

```text
chat
embedding
vision
rerank
web_search
```

### 6.2 能力来源

```text
byok       用户配置的远程供应商
managed    PetDock 官方后端
local      本地模型或本地实现
disabled   明确关闭
```

不同能力允许的来源不同：

| 能力 | BYOK | Managed | Local | Disabled |
| --- | --- | --- | --- | --- |
| Chat | 是 | 是 | Mock 仅用于降级和测试 | 是 |
| Embedding | 是 | 是 | 是 | 否，至少保留 Hash 降级 |
| Vision | 是 | 是 | 后续评估 | 是 |
| Rerank | 后续 | 是 | 后续评估 | 是 |
| Web Search | 是 | 是 | 否 | 是 |

### 6.3 配置原则

设置页可以提供“BYOK”和“官方服务”两个主要入口，但内部配置必须按能力保存来源，不能只保存一个全局布尔值。

概念配置如下：

```json
{
  "version": 1,
  "defaultMode": "managed",
  "capabilities": {
    "chat": "managed",
    "embedding": "local",
    "vision": "disabled",
    "rerank": "disabled",
    "web_search": "managed"
  }
}
```

第一版 UI 可以只开放常用组合，数据结构必须允许后续混合模式。

### 6.4 有效能力计算

官方能力是否真正可用，由以下交集决定：

```text
服务端 Entitlement
∩ 用户本地启用状态
∩ 当前客户端版本支持
∩ 服务端实时可用状态
```

客户端开关只是用户偏好，不能代替服务端授权。FastAPI 必须再次校验 Token 中的能力范围和服务端限额。

### 6.5 能力快照

控制面返回的能力快照至少包含：

```json
{
  "version": 1,
  "plan": "pro",
  "capabilities": {
    "chat": { "enabled": true, "remaining": 1000000, "unit": "tokens" },
    "embedding": { "enabled": true, "remaining": 500000, "unit": "tokens" },
    "vision": { "enabled": false, "remaining": 0, "unit": "requests" },
    "web_search": { "enabled": true, "remaining": 100, "unit": "requests" }
  },
  "expiresAt": "2026-08-11T12:00:00Z"
}
```

快照用于 UI 和本地预判，服务端仍是最终授权来源。

## 7. 安全与隐私边界

### 7.1 凭据所有权

| 凭据 | 持有者 | 存储方式 | 是否下发 Renderer |
| --- | --- | --- | --- |
| BYOK API Key | Electron Main | `safeStorage` | 否 |
| 官网 Refresh Token | Electron Main | `safeStorage` | 否 |
| Runtime Token | Electron Main / Python Runtime 内存 | 短期内存 | 否 |
| 本地 Runtime Token | Electron Main / Python Runtime | 每次启动随机生成 | 否 |
| 官方上游 Provider Key | FastAPI 服务端 | Secret Manager | 否 |

本地 Runtime Token 和官方 Runtime Token 是两个不同的信任域，不得复用。

### 7.2 Runtime Token 建议

- 有效期建议 10 至 30 分钟。
- 包含 `user_id`、`device_id`、`session_id`、`capabilities`、`plan_version` 和 `exp`。
- 使用非对称签名，FastAPI 通过 JWKS 离线验签。
- 不包含上游 Provider Key。
- 设备注销、账号封禁或订阅失效时可以提前吊销。
- Python Runtime 不持有 Refresh Token；Token 即将过期时由 Main 刷新并通过本地受鉴权接口更新。

### 7.3 数据传输说明

启用官方能力意味着对应内容会发送到官方后端：

| 能力 | 可能发送的数据 |
| --- | --- |
| Chat | 用户消息、系统提示、必要的检索片段、工具结果摘要 |
| Embedding | 待向量化的查询或文档 Chunk 文本 |
| Vision | 用户明确添加的图片或派生图片 |
| Web Search | 搜索关键词和需要读取的 URL |
| Rerank | 查询和候选片段 |

默认日志不得记录以上正文。正式上线前必须在隐私政策和产品设置中明确这些边界。

### 7.4 服务端日志最小化

允许记录：

- Request ID、User ID 哈希、Device ID 哈希
- 能力类型、逻辑模型档位、Provider 标识
- 输入输出 Token 数、请求时长、状态码、重试次数
- 配额扣减结果和稳定错误码

默认禁止记录：

- 完整 Prompt 和回答
- 图片、附件和知识库正文
- BYOK Key、Refresh Token、Runtime Token
- Provider 原始认证头

## 8. 官方后端职责

### 8.1 Spring Boot 控制面

建议模块：

```text
control-plane/
  identity/       用户与登录身份映射
  device/         设备注册、撤销和最后活跃时间
  subscription/   套餐、订阅和订单状态
  entitlement/    套餐到能力授权的计算
  quota/          限额配置、预占和查询
  usage/          用量账本、汇总和对账
  session/        Runtime Token 签发与吊销
  admin/          管理后台接口
  audit/          安全操作审计
```

Spring Boot 不执行模型推理，不保存客户端 BYOK Key，不处理本地工具调用。

### 8.2 FastAPI AI 数据面

建议模块：

```text
ai-gateway/
  api/            Chat、Embedding、Vision、Rerank、Search 路由
  auth/           JWT/JWKS 校验和能力范围验证
  providers/      上游供应商适配器
  routing/        逻辑模型到实际模型的路由
  inference/      流式调用、超时和取消
  quota/          请求前预占与完成后结算
  usage/          用量事件与失败补偿
  observability/  日志、指标和 Trace
  errors/         稳定错误码映射
```

LangChain 只在确实能减少 Provider 适配和流式处理复杂度时使用。对于纯代理接口可以直接使用供应商 SDK，避免为“技术栈对齐”增加不必要层级。

### 8.3 推荐云端仓库

云端代码建议独立为一个 monorepo，避免基础设施、服务端密钥配置和桌面安装包代码混在一起：

```text
petdock-cloud/
  contracts/
    openapi/
    schemas/
    error-codes/
  services/
    control-plane/    Spring Boot
    ai-gateway/       FastAPI
  infra/
    gateway/
    database/
    redis/
    deployment/
    monitoring/
  tests/
    contract/
    integration/
    load/
```

桌面仓库通过版本化 OpenAPI 产物或生成客户端消费契约。

## 9. API 契约草案

### 9.1 身份与设备接口

优先使用标准 OIDC/OAuth2 端点：

```text
GET  /oauth2/authorize
POST /oauth2/token
GET  /.well-known/openid-configuration
GET  /.well-known/jwks.json
```

PetDock 业务接口：

```text
POST   /api/v1/devices
GET    /api/v1/devices/current
DELETE /api/v1/devices/{deviceId}
GET    /api/v1/entitlements
POST   /api/v1/runtime-sessions
DELETE /api/v1/runtime-sessions/{sessionId}
GET    /api/v1/usage/summary
```

### 9.2 AI 数据面接口

Chat 和 Embedding 优先兼容 OpenAI 请求语义，便于复用当前 LangChain/OpenAI-compatible 适配器：

```text
POST /ai/v1/chat/completions
POST /ai/v1/embeddings
POST /ai/v1/vision/analyze
POST /ai/v1/rerank
POST /ai/v1/web/search
POST /ai/v1/web/fetch
GET  /ai/v1/capabilities
GET  /ai/v1/health
```

必要请求头：

```text
Authorization: Bearer <runtime-token>
X-PetDock-Request-Id: <uuid>
X-PetDock-Device-Id: <opaque-id>
X-PetDock-Client-Version: <semver>
```

服务端不得允许客户端直接指定任意上游 Provider 和模型名。客户端提交逻辑能力或逻辑档位，由服务端完成路由。

### 9.3 统一错误格式

```json
{
  "error": {
    "code": "quota_exhausted",
    "message": "当前能力额度已用完。",
    "requestId": "9e8d...",
    "retryable": false,
    "retryAfterSeconds": null
  }
}
```

首批稳定错误码：

```text
authentication_required
token_expired
device_revoked
capability_disabled
capability_not_entitled
quota_exhausted
rate_limited
provider_unavailable
provider_timeout
provider_invalid_response
request_cancelled
request_too_large
unsupported_client_version
```

HTTP 状态码、错误码、是否重试和 UI 提示之间必须有集中映射，不能在各端散落字符串判断。

### 9.4 本地 Runtime 会话接口

Electron Main 通过现有本地 `PETDOCK_RUNTIME_TOKEN` 鉴权，把短期官方 Runtime Token 更新到 Python Runtime 内存：

```text
PUT    /v1/managed/session
DELETE /v1/managed/session
GET    /v1/managed/session/status
```

更新请求只接受 `accessToken`、`expiresAt` 和能力快照版本。Python Runtime 不得把 Token 写入 SQLite、配置文件、日志或错误事件。Main 应在任务开始前确保 Token 剩余有效期满足最小窗口；服务端返回认证错误时最多刷新并重试一次，已经产生模型输出的流式请求不得静默重放。

## 10. 本地项目目标结构

基于当前项目结构，后续建议逐步形成：

```text
src/main/assistant/
  accountSessionManager.ts       官网登录、刷新、注销
  deviceIdentityManager.ts       设备标识和注册状态
  capabilitySettingsManager.ts   各能力来源和用户开关
  managedTokenBroker.ts          短期 Runtime Token 获取与更新
  modelSettingsManager.ts        继续管理 BYOK Chat 配置
  embeddingModelManager.ts       继续管理本地/BYOK Embedding
  visionSettingsManager.ts       继续管理 BYOK Vision
  webSettingsManager.ts          继续管理 BYOK Web Search

python-runtime/petdock_runtime/
  providers/
    contracts.py                 Chat/Embedding/Vision 等端口
    selector.py                  按能力来源选择 Provider
    managed/
      client.py                  官方网关 HTTP 客户端
      chat.py
      embeddings.py
      vision.py
    byok/
      chat.py
      embeddings.py
      vision.py
  agent/
    contracts.py
    service.py
    factory.py
    langchain_backend.py
  api/
    resources.py
    server.py
```

首轮重构时不要求一次创建所有文件，只在职责真实出现时落地，避免空抽象和过度设计。

## 11. 分阶段实施顺序

| 阶段 | 核心结果 | 依赖 | 可发布范围 |
| --- | --- | --- | --- |
| Phase 0 | 协议和安全边界冻结 | 无 | 不改变运行逻辑 |
| Phase 1 | 本地 Provider 抽象 | Phase 0 | 仍为 BYOK 版本 |
| Phase 2 | 登录、设备和 Token | Phase 0 | 登录灰度，不开放模型流量 |
| Phase 3 | Managed Chat MVP | Phase 1、2 | 白名单 Chat Beta |
| Phase 4 | 其他 Managed 能力 | Phase 3 | 按能力分别灰度 |
| Phase 5 | 计费级可靠性 | Phase 3、4 | 正式发布 |
| Phase 6 | 可选服务端 Agent | Phase 5 后另行评审 | 独立立项 |

### Phase 0：契约与基线冻结

#### 目标

在修改运行逻辑前冻结能力模型、认证边界和跨端契约，保证后续 Spring、FastAPI 和桌面端可以并行开发。

#### 工作项

- `P0-01` 定义 Capability、Capability Source 和有效能力计算规则。
- `P0-02` 定义 Runtime Token Claims、有效期和吊销语义。
- `P0-03` 创建 OpenAPI、错误码和版本兼容规则。
- `P0-04` 保存当前 BYOK 功能基线和端到端测试结果。
- `P0-05` 确认官方服务传输的数据类型、默认日志和保留策略。
- `P0-06` 决定身份服务实现方式、正式域名、回调方式和证书策略。

#### 交付物

- `contracts/openapi/*.yaml`
- 错误码清单
- Token Claims 文档
- 数据边界与日志规范
- BYOK 回归测试清单

#### 验收标准

- 三端对同一请求和错误样例的序列化结果一致。
- 所有敏感凭据的持有者和生命周期明确。
- 当前 `npm run check`、Runtime 打包 smoke、C3/C5 端到端继续通过。

#### 回滚

本阶段不改变运行逻辑，无运行时回滚需求。

### Phase 1：本地 Provider 抽象，不接入云端

#### 目标

先让现有 BYOK 和本地能力通过稳定 Provider 端口运行，确保官方模式只是新增适配器。

#### 工作项

- `P1-01` 在 `providers/contracts.py` 定义 Chat、Embedding、Vision 和可选 Rerank 端口。
- `P1-02` 将 `LangChainBackend` 从直接读取 `RuntimeConfig` 改为依赖 Chat Provider 或 Chat Model Factory。
- `P1-03` 将现有在线 Embedding、Vision 实现归入 BYOK Adapter。
- `P1-04` 增加 `CapabilitySelector`，但默认全部选择现有实现。
- `P1-05` 在 `src/shared/assistant.ts` 定义脱敏能力设置和快照。
- `P1-06` 增加配置版本和迁移逻辑，旧配置自动迁移为 BYOK/Local 来源。
- `P1-07` 为 Provider 选择、配置迁移、Runtime 环境和降级行为补测试。

#### 关键约束

- 不改变现有 API Key 保存位置和 `safeStorage` 规则。
- 不改变本地 Runtime HTTP/SSE 协议。
- 不把 BYOK Key 传给任何官方服务。
- Provider 端口不得依赖 FastAPI、Spring 或 Electron 类型。

#### 验收标准

- 未登录用户的行为与当前版本一致。
- 旧配置无需用户重新输入 Key。
- Mock、BYOK Chat、本地/在线 Embedding、BYOK Vision 和 BYOK Web Search 均通过回归。
- Provider 选择可通过单元测试独立验证。

#### 回滚

保留旧配置读取和现有 Provider 实现；通过功能开关关闭新 Selector 即可回到原路径。

### Phase 2：官网身份、设备和会话基础设施

#### 目标

完成登录、设备注册、Refresh Token 安全存储和短期 Runtime Token 签发，但尚不向普通用户开放模型流量。

#### Spring Boot 工作项

- `P2-01` 接入标准 OIDC/OAuth2 登录。
- `P2-02` 实现用户、设备、会话和撤销记录。
- `P2-03` 实现 Entitlement 查询和 Runtime Token 签发。
- `P2-04` 暴露 JWKS，并支持密钥轮换。
- `P2-05` 为登录、设备新增、注销和封禁增加审计日志。

#### 桌面端工作项

- `P2-06` 实现系统浏览器 PKCE 登录和 loopback 回调。
- `P2-07` 使用 `safeStorage` 保存 Refresh Token，不下发 Renderer。
- `P2-08` 实现账号脱敏快照、设备状态、退出登录和设备撤销。
- `P2-09` 实现 Runtime Token Broker，并确保 Python Runtime 只获得短期 Token。
- `P2-10` 处理过期、时钟偏差、离线、撤销和重复登录。

#### 验收标准

- Renderer 和日志中均看不到 Refresh Token 和 Runtime Token。
- 关闭并重启应用后可以安全恢复会话。
- 设备撤销后旧 Runtime Token 在规定窗口内失效。
- 未登录状态不影响 BYOK 使用。
- 官网不可用时 BYOK 仍可正常启动。

#### 回滚

官方登录入口受 Feature Flag 控制；关闭后桌面端继续使用 BYOK，不删除已有 BYOK 配置。

### Phase 3：官方 Chat MVP

#### 目标

打通第一条真实官方流量链路，只支持 Chat，其他官方能力保持关闭。

#### FastAPI 工作项

- `P3-01` 实现 Runtime Token/JWKS 校验。
- `P3-02` 实现 `/ai/v1/chat/completions` 流式接口。
- `P3-03` 实现逻辑模型路由和单一上游 Provider Adapter。
- `P3-04` 实现请求取消、首 Token 超时、总超时和断流处理。
- `P3-05` 产生 Token 用量事件和稳定错误码。
- `P3-06` 默认关闭 Prompt/Response 正文日志。

#### Spring Boot 工作项

- `P3-07` 为 Chat 实现套餐授权、基础限额和用量入账。
- `P3-08` 实现内部配额预占、结算和失败释放。
- `P3-09` 提供用户用量摘要。

#### 本地 Runtime 工作项

- `P3-10` 实现 `ManagedChatProvider`。
- `P3-11` 保持现有本地 Agent、工具循环和 SSE 协议不变。
- `P3-12` 支持 Runtime Token 刷新和一次安全重试。
- `P3-13` 将官方错误映射为现有 Runtime 错误事件。

#### 桌面 UI 工作项

- `P3-14` 增加 BYOK/官方服务入口、登录状态和 Chat 能力状态。
- `P3-15` 官方 Chat 不可用时提供切回 BYOK 的明确操作。
- `P3-16` 不在 UI 中展示上游 Provider 密钥或内部模型名称。

#### 验收标准

- 官方 Chat 支持流式文本、取消和多轮工具调用。
- 本地工具仍只由 Electron Main 执行。
- 切换 BYOK/Managed 不丢失本地会话、附件和 Skill。
- 配额耗尽、Token 过期、Provider 超时和网络中断均有稳定结果。
- 用量账本和上游用量允许对账。

#### 回滚

服务端和桌面端分别设置 Managed Chat Feature Flag。关闭后已有登录状态可以保留，但请求自动停止进入官方 Chat。

### Phase 4：Embedding、Vision、Web Search 与 Rerank

#### 目标

按能力逐个接入，不把所有能力作为一个大版本同时上线。

#### 4.1 Managed Embedding

- `P4-E01` 定义官方 Embedding Descriptor，包括逻辑 ID、Revision、Dimensions、Tokenizer 和阈值。
- `P4-E02` 实现批量大小、正文长度和并发限制。
- `P4-E03` 将 Descriptor 纳入现有向量空间 Signature。
- `P4-E04` Provider 或 Revision 变化时要求创建新索引或显式重建，禁止混用向量空间。
- `P4-E05` 保留 Local Hash 作为离线和故障降级，但不把不同空间的向量混写。

验收重点：索引可恢复、切换提示明确、旧知识库不会静默返回错误结果。

#### 4.2 Managed Vision

- `P4-V01` 实现受限 MIME、尺寸、像素和请求体校验。
- `P4-V02` 只上传用户明确加入会话的图片或派生图片。
- `P4-V03` 保持现有视觉摘要缓存不保存 Base64。
- `P4-V04` 支持用户单独关闭 Vision，即使套餐已授权。

验收重点：图片不进入默认日志，取消发送后清理临时请求状态。

#### 4.3 Managed Web Search

- `P4-W01` 在 Main 的 `WebSearchService` 增加 Managed Provider，不改变本地工具权限边界。
- `P4-W02` 继续执行现有 URL、SSRF、内容类型、重定向和正文预算策略。
- `P4-W03` 官方后端负责搜索供应商密钥和服务端配额。
- `P4-W04` 保持来源引用格式与 BYOK 搜索一致。

验收重点：搜索和网页读取仍被识别为外部不可信内容。

#### 4.4 Managed Rerank

- `P4-R01` 仅在已有混合召回结果上执行，不替代本地检索准入。
- `P4-R02` 设置候选数量、单片段长度和总字符预算。
- `P4-R03` Rerank 失败时回退到现有 RRF/本地评分。

#### Phase 4 总体验收

- 每项能力可以独立启用、禁用、灰度和回滚。
- 任一官方能力故障不会破坏其他能力和 BYOK。
- 设置快照、服务端 Entitlement 和实际调用结果一致。

### Phase 5：配额、可靠性、成本与正式上线

#### 目标

从可用 MVP 提升为可以正式收费和稳定运营的服务。

#### 工作项

- `P5-01` 实现用户、设备、IP 和能力四个维度的限流。
- `P5-02` 实现配额预占、实际结算、超时释放和幂等补偿。
- `P5-03` 建立不可变 Usage Ledger 和周期汇总表。
- `P5-04` 建立 Provider 超时、熔断、健康探测和受控故障切换。
- `P5-05` 实现 Request ID 在 Electron、Runtime、Gateway、FastAPI 和 Provider 间贯通。
- `P5-06` 建立延迟、首 Token、成功率、取消率、Token、成本和配额拒绝指标。
- `P5-07` 建立费用异常、滥用、凭据泄漏和 Provider 故障告警。
- `P5-08` 完成压力测试、容量估算、灾备和密钥轮换演练。
- `P5-09` 完成隐私政策、用户协议、账单说明和客服排查手册。

#### 验收标准

- 重复请求、重试和断流不会造成明显重复扣费。
- Provider 故障时能够按策略失败或切换，不无限重试。
- 可以按 Request ID 完成跨服务排查，同时不读取用户正文。
- 可以按用户、能力、模型和账期对账。
- 可以在不发布桌面新版本的情况下关闭某个官方能力。

### Phase 6：可选的服务端 Agent 增强

本阶段不是当前承诺范围，只有满足以下条件才启动：

- 明确存在必须脱离用户电脑持续执行的长任务。
- 本地 Runtime 无法满足可靠性、并发或调度需求。
- 已有稳定的协议、配额和审计基础设施。
- 已明确哪些数据允许上传和保留。

如启动，应新增服务端 Agent 产品边界，而不是把当前本地 Agent 代码复制一份。优先抽取与框架无关的 Prompt、事件和工具契约，再决定是否使用 LangChain、LangGraph 或其他引擎。

## 12. 测试策略

### 12.1 单元测试

- 配置迁移和 CapabilitySelector
- Token 过期、刷新、撤销和时钟偏差
- Entitlement 交集计算
- Provider 路由和错误归一化
- 配额预占、结算和补偿
- Embedding Signature 与索引隔离
- 日志脱敏

### 12.2 契约测试

- OpenAPI 请求/响应样例
- Spring 与 FastAPI 的 Token Claims 兼容
- TypeScript 与 Python 生成客户端兼容
- SSE Chunk、取消和错误事件兼容
- 新旧客户端版本兼容

### 12.3 集成测试

- 桌面登录、刷新、注销和设备撤销
- Runtime Token 更新
- Managed Chat 流式与工具结果续传
- Embedding 批量与索引重建
- Vision 文件限制与摘要缓存
- Web Search 来源和网页读取安全策略
- 配额不足、Provider 超时和服务端降级

### 12.4 模式回归矩阵

| 场景 | Chat | Embedding | Vision | Web Search | 预期 |
| --- | --- | --- | --- | --- | --- |
| 现有 BYOK | BYOK | Local | Disabled | BYOK | 与当前版本一致 |
| 全 Managed | Managed | Managed | Managed | Managed | 所有流量经过官方后端 |
| 混合模式 | Managed | Local | Disabled | BYOK | 各能力独立工作 |
| 未登录 | BYOK | Local | BYOK | BYOK | 不依赖官网 |
| 官网不可用 | BYOK | Local | BYOK | BYOK | BYOK 不受影响 |
| Token 过期 | Managed | Managed | Managed | Managed | 刷新一次后重试或要求登录 |
| 套餐无权限 | Managed | Managed | Managed | Managed | 服务端拒绝且 UI 状态一致 |

### 12.5 每阶段最低验证

```powershell
npm.cmd run check
npm.cmd run build:runtime
npm.cmd run test:runtime:packaged
npm.cmd run test:e2e:assistant:c3
npm.cmd run test:e2e:assistant:c5
```

涉及登录或官方服务时，还必须增加云端契约测试、服务集成测试和真实桌面登录冒烟测试。

## 13. 可观测性

### 13.1 链路标识

一次用户请求至少包含：

```text
conversation_id   本地会话标识，不直接作为云端用户标识
task_id           本地任务标识
request_id        跨服务唯一请求标识
session_id        官方 Runtime Session
device_id_hash    日志使用的设备哈希
usage_event_id    用量账本幂等标识
```

### 13.2 指标

- 请求数、成功率、取消率和错误码分布
- 首 Token 延迟、总时长和 Provider 时长
- 输入/输出 Token、Embedding Token、图片数和搜索次数
- 配额预占失败、结算失败和补偿积压
- Provider 限流、超时、熔断和切换次数
- Runtime Token 刷新成功率

### 13.3 日志要求

继续遵守项目现有规范：注释和日志使用中文；日志必须方便排查，但不得输出密钥、Token、Prompt、附件正文和图片内容。

## 14. 数据模型建议

控制面最低需要以下实体：

```text
users
devices
subscriptions
plans
plan_capabilities
user_entitlements
runtime_sessions
token_revocations
quota_buckets
usage_ledger
usage_daily_summary
security_audit_logs
```

关键规则：

- Usage Ledger 采用追加写，不直接覆盖历史记录。
- 配额汇总可以重算，账本必须可审计。
- Device ID 使用不可猜测随机值，不使用硬件序列号作为主键。
- Runtime Session 有明确过期时间和撤销状态。
- 套餐变更通过版本化 Entitlement 生效。

## 15. 发布与回滚策略

### 15.1 Feature Flags

至少提供：

```text
managed_login_enabled
managed_chat_enabled
managed_embedding_enabled
managed_vision_enabled
managed_web_search_enabled
managed_rerank_enabled
```

Feature Flag 必须能按环境、用户组、客户端版本和百分比灰度。

### 15.2 发布顺序

1. 内部开发账号。
2. 白名单测试账号。
3. 免费小额度灰度。
4. 单一正式套餐。
5. 扩大用户范围和 Provider 路由。

### 15.3 回滚原则

- 官方服务故障时优先关闭对应 Managed 能力，不删除用户登录和 BYOK 配置。
- 不自动把 Managed 请求切换到用户 BYOK Key，除非用户明确启用该回退。
- 不自动重建或删除本地向量索引。
- 配置迁移必须保留上一版本可读取的数据。
- 服务端契约至少兼容当前和上一桌面版本。

## 16. 主要风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 本地与云端重复 Agent | 行为不一致、维护成本翻倍 | 云端初期只做能力数据面 |
| 长期密钥泄漏 | 额度被盗用 | PKCE、Refresh Token 加密、短期 Runtime Token |
| 流式链路经过多层代理 | 首 Token 变慢、断流 | 数据面减少同步跳数，专项压测 SSE |
| 配额与实际用量不一致 | 错扣费、超卖 | 预占、结算、幂等 Usage Ledger、补偿任务 |
| Embedding 空间混用 | 检索静默失真 | Descriptor Signature、索引隔离、显式重建 |
| 官方服务不可用影响老用户 | BYOK 回归 | 模式隔离、Feature Flag、BYOK 独立启动 |
| Prompt 或附件进入日志 | 隐私事故 | 正文日志默认关闭、脱敏测试、日志审计 |
| Provider 成本失控 | 运营风险 | 逻辑模型、单请求预算、限流和成本告警 |
| 本地 Token 刷新失败 | 长任务中断 | Main Token Broker、提前刷新、一次受控重试 |
| 客户端伪造能力开关 | 越权调用 | 服务端重复鉴权和配额检查 |

## 17. 开发前待确认事项

Phase 0 结束前必须确认：

- 官网正式域名和 API 域名。
- OIDC/OAuth2 身份服务采用自建还是托管方案。
- 桌面回调采用 loopback redirect 还是自定义协议。
- 首批套餐、免费额度和能力授权规则。
- 首个官方模型 Provider 和逻辑模型档位。
- 官方服务部署区域和数据跨境要求。
- Prompt、图片和用量日志的保留策略。
- 支付、退款、欠费和套餐降级规则。
- 是否允许 Managed 自动回退 BYOK，以及默认值。
- 最低支持桌面版本和契约兼容周期。

这些决策不会阻塞 Phase 1 的本地 Provider 抽象，但会阻塞 Phase 2 和 Phase 3 正式实现。

## 18. 总体验收定义

双模式能力可以宣布完成，需要同时满足：

- 现有 BYOK 用户无需重新配置即可继续使用。
- 用户可以登录、退出、撤销设备并查看能力状态。
- 各能力可以独立选择 BYOK、Managed、Local 或 Disabled。
- 官方 Chat、Embedding、Vision 和 Web Search 均有明确授权、限额和用量记录。
- 本地文件、知识库、记忆和 Skill 默认不被持久化到官方服务。
- Renderer 不接触任何明文密钥和 Token。
- 本地工具仍只在 Electron Main 权限边界内执行。
- 官方能力可独立灰度和关闭，不需要紧急发布桌面版本。
- 全链路能够使用 Request ID 排查，但日志不包含敏感正文。
- 源码测试、契约测试、端到端测试、打包态测试和压力测试全部通过。

## 19. 实施检查表

```text
[ ] Phase 0 契约与安全边界冻结
[ ] Phase 1 本地 Provider 抽象完成，BYOK 零回归
[ ] Phase 2 登录、设备、Token 和 Entitlement 完成
[ ] Phase 3 Managed Chat MVP 完成
[ ] Phase 4-E Managed Embedding 完成
[ ] Phase 4-V Managed Vision 完成
[ ] Phase 4-W Managed Web Search 完成
[ ] Phase 4-R Managed Rerank 完成
[ ] Phase 5 配额、可靠性、成本和正式发布完成
[ ] Phase 6 服务端 Agent 是否立项完成评审
```

后续开发任务应引用本检查表中的 Phase 和工作项编号，例如 `P1-02`、`P3-10`，以便在代码、提交、Issue 和测试报告之间建立可追踪关系。
