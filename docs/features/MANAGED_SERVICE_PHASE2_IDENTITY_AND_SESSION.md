# PetDock Managed Service Phase 2 身份、设备与会话开发方案

## 1. 文档状态

- 状态：Active
- 建立日期：2026-08-15
- 适用阶段：Managed Service Phase 2
- 适用仓库：`desktop-pet`、`petdock-web`、`petdock-cloud`
- 当前入口：云端 `P2-05` 已完成，桌面 `P2-06` 正在实现系统浏览器 PKCE 与 loopback 登录

本文档承载 Phase 2 的详细设计、跨仓库拆分、开发环境、实现顺序和验收要求。总体架构、安全边界和阶段定义仍以 `docs/architecture/MANAGED_SERVICE_IMPLEMENTATION_PLAN.md` 为准，接口字段和协议语义仍以 `contracts/managed-service/v1` 权威契约为准。

发生冲突时按以下优先级处理：

```text
Managed Service v1 权威契约
  -> 冻结架构与安全规则
       -> 本 Phase 2 专项方案
            -> 进度与验证记录
```

本文件不得记录服务器公网 IP、SSH 凭据、数据库口令、Token、证书私钥、真实用户数据或生产 Provider 配置。

## 2. 当前环境现状

截至 2026-08-15：

- 中国大陆云服务器已经就绪。
- `petdock.site` 域名已经就绪。
- ICP 备案仍在审核中，正式公网登录和官网流量尚未开放。
- Phase 1 本地 Chat Factory 与能力来源抽象已经完成，尚未接入真实 Managed 网络流量。
- 开发者可能使用多台个人电脑参与开发，需要共享且稳定的数据库和中间件环境。
- 开发阶段优先把关系数据库、撤销/短期状态存储和必要中间件部署到服务器，本地开发机通过受控通道连接。

备案审核只阻塞正式公网入口和真实域名登录联调，不阻塞以下工作：

- 本地 Mock OIDC 和 Mock 控制面测试。
- Electron PKCE、loopback、`safeStorage` 和 Runtime Token Broker 开发。
- 服务器内部数据库、中间件和服务容器准备。
- 通过 SSH 隧道或自建私网进行受控开发联调。
- 云端单元测试、服务集成测试和数据库迁移测试。

## 3. Phase 2 目标与非目标

### 3.1 目标

Phase 2 完成以下基础设施：

- 独立官网的注册、登录、账号安全和 OAuth 授权确认入口。
- 标准 OAuth 2.1/OIDC Authorization Code + PKCE 桌面登录。
- 桌面设备注册、当前设备查询、撤销和重复登录处理。
- Electron Main 安全持有并轮换桌面 Refresh Token。
- Entitlement 脱敏快照和短期 Runtime Token 签发。
- Main 向 Python Runtime 注入、刷新和清除短期 Runtime Token。
- 桌面端账号、设备、套餐和能力状态的脱敏展示。
- “前往官网管理”入口和返回应用后的状态刷新。

### 3.2 非目标

Phase 2 不包含：

- 不开放普通用户 Managed Chat、Embedding、Vision、Web Search 或 Rerank 流量。
- 不把本地 Agent、Memory、RAG、Skill 或工具编排迁移到云端。
- 不实现正式支付闭环、退款和财务对账。
- 不建设集群、跨可用区副本或自动容灾。
- 不允许 Managed 故障自动使用用户 BYOK Key。
- 不在 `desktop-pet` 仓库创建官网、Spring Boot 或 FastAPI 服务代码。

## 4. 开发环境部署基线

### 4.1 结论

服务器集中部署开发数据库和中间件适合多台个人电脑协作，可以避免每台电脑维护独立状态和重复初始化。但“本地直连”只指应用逻辑直接使用共享开发资源，不代表把数据库或中间件端口直接暴露到公网。

推荐拓扑：

```text
个人电脑 A ─┐
个人电脑 B ─┼─ SSH 隧道或自建私网 ─> 服务器受控入口
个人电脑 C ─┘                           |
                                           +-> 开发关系数据库
                                           +-> 撤销/短期状态存储
                                           +-> 开发控制面服务
                                           +-> 开发身份服务
```

### 4.2 网络边界

- 数据库和中间件只监听服务器回环地址、容器私网或自建私网地址。
- 不向公网开放数据库、中间件和内部管理端口。
- 开发机优先通过 SSH 本地端口转发或自建 WireGuard 私网接入。
- 防火墙只开放必要的受控入口，业务容器之间使用独立内部网络。
- 正式入口网关统一终止 TLS；备案完成前不开放面向普通用户的公网业务流量。
- Ubuntu 主机时区使用 `Asia/Shanghai`；数据库、JWT、接口时间和应用内部统一使用 UTC，Renderer 再按用户时区展示。
- 不在公开文档、仓库脚本和测试样例中写入真实服务器 IP、端口、用户名或连接串。

### 4.3 环境隔离

共享服务器至少划分以下逻辑环境：

| 环境 | 用途 | 数据要求 | 对外状态 |
| --- | --- | --- | --- |
| `local-mock` | 单机单元测试和桌面 E2E | 全部合成数据 | 不访问服务器也可运行 |
| `shared-dev` | 多电脑共享开发联调 | 仅开发账号和合成数据 | 只允许受控开发访问 |
| `staging` | 备案后跨端灰度验收 | 独立测试数据 | 仅内部白名单 |
| `production` | 正式服务 | 正式数据 | Phase 5 前不启用收费流量 |

`shared-dev` 不得与未来 `production` 共用数据库、账号、密钥、对象存储目录、Token 签名私钥或日志索引。即使物理上暂时使用同一台服务器，也必须使用独立容器网络、独立数据库和中间件命名空间、独立存储卷、服务账号和配置文件；正式环境启用前再评审是否拆分为独立实例。

### 4.4 多电脑凭据管理

- 每台开发电脑使用独立 SSH 密钥或私网设备凭据，可以单独撤销。
- 每位开发者和每类服务使用独立数据库账号，不共享管理员账号。
- 日常应用账号只拥有业务所需权限；数据库迁移使用独立迁移账号。
- 本地连接信息放入未提交的环境文件或系统凭据存储，不进入仓库。
- 禁止通过聊天记录、进度文档、截图或命令输出传播完整连接串和密钥。
- 开发电脑丢失或停用时，应能单独撤销该设备的远程访问凭据。

### 4.5 数据库迁移和并发开发

- 数据结构迁移必须由 `petdock-cloud` 仓库中的版本化迁移工具统一管理。
- 不允许开发者直接在共享数据库手工修改表结构后不提交迁移。
- 每次合并涉及 Schema 的变更前，在空数据库和现有开发快照上分别执行迁移测试。
- 破坏性迁移需要备份、恢复步骤和明确维护窗口。
- 自动化测试默认使用隔离数据库或事务回滚，不能依赖共享开发库中的固定记录。
- 共享开发库只保存合成账号和合成业务数据，不导入真实用户数据。

### 4.6 备份与可恢复性

- 共享开发数据库执行定期备份，备份保存在中国大陆境内。
- 备份文件加密，密钥与备份文件分离保存。
- 在正式公网联调前至少完成一次开发环境恢复演练。
- 中间件中的撤销和短期状态应能通过数据库事实或重新登录恢复，不能成为唯一不可重建的数据源。

### 4.7 已确认技术选型

Phase 2 `shared-dev` 基础依赖已经确认：

| 领域 | 选型 |
| --- | --- |
| 关系数据库 | PostgreSQL 17 |
| 缓存与短期状态 | Redis 8.0 |
| 数据库迁移 | Flyway |
| 身份框架 | Spring Authorization Server |
| 容器编排 | Docker Compose Plugin |
| 入口网关 | Nginx，业务服务和备案条件就绪后接入 |
| 开发接入 | SSH 本地端口转发 |

PostgreSQL 是用户、设备、Token Family、Runtime Session、Entitlement 和安全审计的权威数据源。Redis 只保存 Web Session、限流、短期状态、刷新锁和可重建的撤销缓存，不作为设备撤销或 Token Family 的唯一事实来源。

服务器部署命令和验证步骤见 `docs/guides/MANAGED_SERVICE_SHARED_DEV_DEPLOYMENT.md`。

## 5. 跨仓库职责

### 5.1 `petdock-web`

- `P2-W01`：注册、登录、账号安全和用户资料页面。
- `P2-W02`：OAuth 桌面设备授权确认页面。
- `P2-W03`：套餐、充值、订单、设备和用量基础页面；支付闭环延后。
- `P2-W04`：只调用 Spring Boot 控制面，不调用 AI 数据面，不读取桌面 Token。

官网使用 HttpOnly 安全 Cookie 或等价 Web Session。官网普通退出只结束 Web Session，不得隐式撤销全部桌面设备。

### 5.2 `petdock-cloud`

- `P2-01`：基于成熟框架接入标准 OIDC/OAuth2。
- `P2-02`：用户、设备、桌面会话、Token Family 和撤销记录。
- `P2-03`：Entitlement 查询和 Runtime Token 签发。
- `P2-04`：JWKS 暴露、RS256 签名和密钥轮换。
- `P2-05`：登录、设备新增、注销、撤销、封禁和 Token 重放审计。

云端最低数据实体继续使用实施总纲定义的 `users`、`devices`、`subscriptions`、`plans`、`plan_capabilities`、`user_entitlements`、`runtime_sessions`、`token_revocations` 和 `security_audit_logs`。具体数据库与中间件产品选型在 `P2-00` 冻结，但不得改变公网契约。

### 5.3 `desktop-pet`

- `P2-06`：系统浏览器 PKCE 登录和 loopback 回调。
- `P2-07`：使用 `safeStorage` 保存并轮换 Refresh Token。
- `P2-08`：账号脱敏快照、设备状态、退出和设备撤销。
- `P2-09`：Runtime Token Broker 和 Runtime Session Bridge。
- `P2-10`：过期、时钟偏差、离线、撤销、重复登录和并发刷新。
- `P2-11`：固定官网管理入口和返回应用后的状态刷新。

## 6. 桌面端模块设计

建议在 `src/main/managed/` 建立独立领域，避免把身份和 Token 生命周期继续堆入 `AssistantManager`：

```text
src/main/managed/
  managedAuthManager.ts
  managedEndpointPolicy.ts
  managedFeatureFlags.ts
  managedOAuthClient.ts
  managedOAuthLoopback.ts
  managedOAuthTypes.ts
  managedControlPlaneClient.ts
  managedDeviceIdentityManager.ts
  managedAccountSessionManager.ts
```

P2-06 至 P2-09 已落地。`managedAuthManager` 只在进程内保留 Access/Refresh Token；Preload 只暴露账号、设备显示状态和会话同步状态等脱敏快照；Runtime Token Broker 只在 Electron Main 内存持有短期 Runtime Lease，Python Runtime 通过本地 Session Bridge 获取并保持内存态。

本地联调通过未提交环境变量选择端点：`PETDOCK_MANAGED_ENVIRONMENT=local-mock` 或 `shared-dev`，并同时设置 `PETDOCK_MANAGED_ISSUER` 与 `PETDOCK_MANAGED_CONTROL_PLANE_URL`。生产和预发布不读取这些覆盖值，固定使用契约中的官方端点。

职责边界：

- `managedAuthManager.ts`：登录状态机、取消、启动恢复、UserInfo/设备同步、RFC 7009 退出和当前设备撤销编排。
- `managedOAuthLoopback.ts`：只监听 `127.0.0.1` 随机端口，校验回调路径、`state`、超时和一次性消费。
- `managedTokenStore.ts`：P2-07 使用 `safeStorage` 保存 Refresh Token；`managedControlPlaneClient.ts`、`managedDeviceIdentityManager.ts` 和 `managedAccountSessionManager.ts`：P2-08 负责 UserInfo、设备同步和撤销；`managedRuntimeTokenBroker.ts`：P2-09 负责 Runtime Token。
- `managedFeatureFlags.ts`：处理 `managed_login_enabled` 和开发环境端点覆盖，生产构建固定官方端点。

## 7. OAuth PKCE 与 Loopback

固定参数：

```text
issuer=https://account.petdock.site
client_id=petdock-desktop
response_type=code
scope=openid profile email desktop.session
code_challenge_method=S256
redirect_path=/oauth/callback
```

每次登录必须：

1. 检查 `managed_login_enabled` 和 `safeStorage` 可用性。
2. 生成新的高熵 `state` 和 `code_verifier`。
3. 绑定 `127.0.0.1` 随机端口，再根据实际端口生成完全一致的 Redirect URI。
4. 使用系统浏览器打开授权地址，不使用 Electron 内嵌页面。
5. 校验回调方法、路径、`state`、错误参数和一次性消费状态。
6. 使用原始 `code_verifier` 换取桌面 Access/Refresh Token。
7. 先安全保存轮换后的 Refresh Token，再更新内存会话。
8. 获取 UserInfo 并注册或确认当前设备；Entitlement 和 Runtime Session 由后续阶段负责。
9. 成功、失败、用户取消或 5 分钟超时后立即关闭监听器。

授权码、Token、Verifier、Cookie 和完整回调查询参数不得进入日志、Renderer、截图或错误消息。

## 8. Token 生命周期

| 凭据 | 持有者 | 持久化 | 主要用途 |
| --- | --- | --- | --- |
| 官网 Web Session | 系统浏览器、控制面 | HttpOnly Cookie | 官网页面 |
| 桌面 Access Token | Electron Main | 仅内存 | 调用控制面 |
| 桌面 Refresh Token | Electron Main | `safeStorage` | 恢复和轮换桌面会话 |
| 官方 Runtime Token | Main、Python Runtime | 仅内存 | 调用 AI 数据面 |
| 本地 Runtime Token | Main、Python Runtime | 启动期内存 | 保护本地 Runtime API |

规则：

- 桌面 Refresh Token 绝对有效期 30 天，每次使用必须轮换。
- 新 Refresh Token 保存成功后，旧值立即从内存移除。
- 旧 Token 重放由服务端撤销当前设备整个 Token Family。
- Runtime Token 固定有效 15 分钟，剩余不足 3 分钟时提前刷新。
- Runtime Token 刷新使用 single-flight，同一时刻只允许一个刷新请求。
- Python Runtime 不接收 Refresh Token，也不能调用 OAuth Token Endpoint。
- Renderer 不接收任何明文 Token。
- 临时网络故障不能自动删除仍可能有效的 Refresh Token；明确的撤销或无效凭据才清理本地会话。

## 9. 控制面与 Runtime 接口

桌面端按 v1 控制面契约消费：

```text
POST   /api/v1/devices
GET    /api/v1/devices/current
DELETE /api/v1/devices/{deviceId}
GET    /api/v1/entitlements
POST   /api/v1/runtime-sessions
DELETE /api/v1/runtime-sessions/{sessionId}
GET    /api/v1/usage/summary
```

每次控制面业务请求携带：

- 桌面 Access Token。
- `X-PetDock-Client-Version`。
- 新生成的 `X-PetDock-Request-Id`。

Main 与 Python Runtime 按本地契约使用：

```text
PUT    /v1/managed/session
DELETE /v1/managed/session
GET    /v1/managed/session/status
POST   /v1/managed/auth-result
```

Phase 2 只建立会话通道。即使登录和 Runtime Token 已就绪，Phase 1 的 Managed Chat、Embedding、Vision 和 Web Search 仍保持不可用，直到对应后续阶段完成 Provider 与服务端数据面验收。

## 10. Renderer 与 IPC

Renderer 只读取脱敏快照，建议覆盖以下状态，不携带 Token 或原始认证响应：

- 未登录。
- 正在登录。
- 已登录。
- 会话需要刷新。
- 已离线但保留可恢复凭据。
- 当前设备已撤销。
- 登录已过期，需要重新授权。
- 客户端版本不受支持。

允许的命令：

- 开始登录。
- 取消当前登录。
- 刷新账号状态。
- 退出当前桌面会话。
- 撤销当前设备。
- 打开固定的官网管理页面。

正式官网链接由 Main 内置白名单或受控构建配置提供，Renderer 不得提交任意地址。

## 11. 异常与恢复

- 官网或控制面离线：显示稳定离线状态，BYOK 继续启动。
- Refresh Token 过期：清除无效桌面会话并要求重新登录，不影响 BYOK 配置。
- 当前设备撤销：清除 Main 和 Runtime 内存 Token，删除本地加密 Refresh Token。
- Runtime Token 过期：Main 刷新后更新 Runtime；只有尚未输出文本或 ToolCall 的请求才允许安全重试一次。
- 流式输出期间认证过期：返回 `authentication_expired_during_stream`，不静默重放。
- 本机时钟明显偏差：使用控制面响应时间辅助判断并显示稳定提示。
- 重复点击登录：复用当前登录任务或明确拒绝，不同时打开多个监听器和浏览器授权流程。
- 应用退出：关闭 loopback 监听器，清除内存 Access/Runtime Token，不删除仍有效的加密 Refresh Token。

## 12. `P2-00` 决策结果

`P2-00` 已在 `petdock-cloud/contracts/managed-service/v1` 权威契约中完成冻结，决策编号为 `D-P2-01` 至 `D-P2-08`。具体字段和行为以云端 `IDENTITY_AND_SESSION.md`、`DECISION_REGISTER.md` 以及同步到本仓库的 v1 消费快照为准，桌面端不得另行解释或扩展。

本次冻结已确定 OIDC Discovery/UserInfo/Token Response、RFC 7009 主动撤销、`managed_login_enabled` 服务端下发、开发端点覆盖和生产固定校验、设备显示名与重复注册、HTTP `Date` 服务端时间，以及 PostgreSQL/Redis 的 shared-dev 和生产环境隔离规则。

云端已完成 P2-01、P2-02、P2-04、P2-05、P2-08 UserInfo 衔接和 P2-09 Runtime Session 回归覆盖，具备持久化用户目录、设备、授权记录、Runtime Token 签发、撤销审计、签名密钥轮换基础和安全审计回归门禁；Entitlement 管理与 Usage API 按确认延后。桌面端 P2-06 至 P2-09 已完成，下一步进入 P2-10 过期、离线、时钟偏差和并发刷新异常矩阵。

## 13. 实施顺序

1. `P2-00`：冻结契约缺口、开发环境和数据库/中间件选型（已完成）。
2. 建立 `shared-dev` 服务器内部网络、开发数据库、中间件、备份和受控接入。
3. `P2-01` 至 `P2-05`：云端身份、设备、会话、Entitlement、JWKS 和审计（P2-01、P2-02、P2-04、P2-05 已完成，Entitlement 管理延后）。
4. `P2-06`：桌面 PKCE、loopback 和本地 Mock OAuth 验收。
5. `P2-07`：Refresh Token `safeStorage`、轮换和恢复。
6. `P2-08`：账号/设备脱敏快照、退出和撤销。
7. `P2-09`：Runtime Token Broker 和本地 Runtime Session API（已完成）。
8. `P2-10`：离线、过期、时钟偏差、重复登录和并发刷新。
9. `P2-W01` 至 `P2-W04`：官网页面和授权确认。
10. `P2-11`：官网管理入口和返回应用刷新。
11. 备案完成后执行真实域名、TLS、系统浏览器和打包版跨端登录验收。

## 14. 测试与安全验收

### 14.1 桌面单元测试

- PKCE S256、state、随机端口和 Redirect URI 完全一致。
- 只绑定 `127.0.0.1`，拒绝重复、过期和不匹配回调。
- 5 分钟超时、取消、应用退出和监听器清理。
- `safeStorage` 不可用、文件损坏、原子替换和 Refresh Token 轮换。
- Runtime Token 3 分钟阈值、single-flight 和时钟偏差。
- Renderer 快照和日志不包含 Token、Verifier、Cookie 或完整回调 URL。
- Feature Flag 关闭时 BYOK 独立启动。

### 14.2 云端测试

- OAuth/OIDC 框架集成测试。
- Refresh Token 轮换、旧 Token 重放和 Token Family 撤销。
- 设备新增、查询、撤销和封禁。
- RS256、JWKS、`kid` 轮换、未知 `kid` 和算法降级拒绝。
- Entitlement 版本和 Runtime Token Claims。
- 审计日志只记录脱敏标识和稳定结果。

### 14.3 跨端和打包态测试

- 本地 Mock OAuth + 控制面完整登录。
- 应用重启后恢复桌面会话。
- Main 向 Runtime 注入、刷新和清除短期 Token。
- 当前设备撤销后旧 Runtime Token 在规定窗口内失效。
- 官网不可用、服务器不可达和备案未完成时 BYOK 仍可用。
- Windows 开发版和解包版系统浏览器登录。
- 备案、DNS 和 TLS 就绪后的真实域名白名单登录冒烟。

## 15. Phase 2 完成定义

只有同时满足以下条件才可将 Phase 2 标记为 `Done`：

- `P2-00` 至 `P2-11` 以及 `P2-W01` 至 `P2-W04` 的阶段范围完成。
- Renderer、Python Runtime 和日志均看不到 Refresh Token 与 Runtime Token。
- 应用重启后能够安全恢复桌面会话。
- 设备撤销、Token 轮换、重放检测和 Runtime Token 刷新通过跨端验收。
- 未登录和官方服务不可用时 BYOK 行为与 Phase 1 基线一致。
- 官网 Web Session 与桌面 Refresh Token 完全隔离。
- 备案完成后正式域名、DNS、TLS 和系统浏览器真实登录通过验收。
- Phase 2 没有向普通用户开放 Managed 模型流量。
- 云端契约、服务集成、桌面源码、打包态和提交前脱敏检查全部通过。
