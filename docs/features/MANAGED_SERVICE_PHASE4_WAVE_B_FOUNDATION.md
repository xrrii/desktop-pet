# PetDock Managed Service Phase 4 Wave B 共用底座方案

本文档承接 [Phase 4 多能力开发方案](MANAGED_SERVICE_PHASE4_CAPABILITIES.md) 的 `P4-00`，定义 Wave B 在三仓中的实施边界、依赖顺序、验收门禁和回滚方式。Wave B 只建设四项能力共用的控制面与数据面底座，不代表任何真实 Provider 已接入或任何 Phase 4 流量已经开放。

## 1. 目标与非目标

### 1.1 目标

- 让 Chat、Embedding、Vision、Web Search、Rerank 共享一套能力注册、授权、配额和 Usage 状态机。
- 将 `FeatureFlag -> Entitlement -> Runtime Claims -> Gateway 校验 -> Usage Reservation -> Provider Adapter` 固定为单向链路。
- 使每项能力可以独立启停、独立限流、独立灰度和独立回滚，不影响现有 Managed Chat 与 BYOK。
- 为后续 Wave C-F 提供窄 Provider 接口、统一错误映射、请求指纹和脱敏可观测性。

### 1.2 非目标

- 不在 Wave B 实现 Embedding、Vision、Web Search 或 Rerank 的真实 Provider。
- 不开放新的公网 Nginx 路由，不把任何 Phase 4 开关改为 `true`。
- 不新增支付、正式账本、按量结算或服务端 Agent。
- 不改变 Desktop 的本地 Provider、向量库、图片缓存、Web SSRF 和 RAG 业务逻辑。

## 2. 冻结不变量

1. `petdock-cloud/contracts/managed-service/v1` 继续是唯一权威契约源，Desktop 只消费同步快照，Web 只消费生成类型。
2. 缺失、类型错误或无法解析的 Phase 4 开关按 `false` 处理；能力未授权时不得生成对应 Runtime Claim。
3. 所有远程调用都必须经过 Runtime Token、能力授权、预算和预占校验；Provider 不得自行扣额度。
4. 相同 `request_id`、主体、能力、逻辑模型和请求指纹只能产生一个终态；参数冲突不得调用 Provider。
5. Managed 失败不得自动切换到用户 BYOK。只有方案明确允许的本地降级（Embedding Hash 影子索引、Rerank 本地排序）可以在客户端执行。
6. Provider Secret 只能由 Cloud 运行时注入；不得进入契约、客户端、镜像层、环境转储、日志或指标标签。

## 3. 工作分解

### B-01 能力注册与配置快照

- 在控制面维护五项能力的公开 `capability`、`logicalModel`、单位、预算和可用状态。
- 将四项 Phase 4 开关纳入现有 `FeatureFlagSnapshot`，保留旧客户端缺失字段的兼容行为。
- `/ai/v1/capabilities` 只返回认证主体可见的真实能力；关闭、未授权或 Provider 未就绪时明确返回不可用原因，不泄露 Secret 或内部地址。

### B-02 Entitlement 与额度投影

- 复用现有 Entitlement/套餐事实，为每项能力增加独立的授权和周期额度视图。
- `chat` 既有字段保持兼容；新增能力使用可选字段，旧 Web/Desktop 不因缺字段失败。
- 额度来源只认控制面事实，客户端不得根据开关、请求次数或本地缓存推导 `remaining`。

### B-03 Usage Reservation 状态机

统一使用：

```text
reserved -> settled
reserved -> released
reserved -> failed
```

- 预占请求必须携带主体、Session、能力、逻辑模型、请求指纹、单位和预算。
- `settled` 记录可靠 Provider 用量；无法取得可靠用量时进入 `failed` 并保留预占量。
- 未调用 Provider 的明确拒绝、取消或能力关闭进入 `released`。
- 幂等冲突在预占前返回，不产生 Provider 尝试；结算和释放必须可重复提交。

### B-04 Runtime Token 与 Claims

- Runtime Lease 仍由控制面签发和撤销；能力 Claims 只包含已授权且开关打开的能力。
- Claims 至少绑定 `subject`、设备、Session、租约过期时间、能力、逻辑模型和契约版本。
- Gateway 必须同时校验 Token 撤销、能力 Claim、请求能力和逻辑模型，不能只校验登录态。
- Web Session、用户 JWT 和公网来源不得访问内部预占/结算接口。

### B-05 AI Gateway 共用中间件

按固定顺序执行：

```text
请求解析 -> 大小/字段预算 -> Runtime Token -> 撤销检查
-> Capability/Entitlement -> 并发限制 -> Usage 预占
-> Provider Adapter -> 终态结算/释放 -> 脱敏响应
```

- 每个阶段返回稳定的 `ErrorEnvelope` 和可检索的 `request_id`，不返回 Provider 原始错误。
- 预占成功后即使客户端断开，也必须由服务端完成终态收敛；不得留下无限期 `reserved`。
- 第一版不做跨 Provider 自动重试或自动切换，重试由后续能力专项单独评审。

### B-06 Provider Adapter 注册表

- 建立按 `capability + logicalModel` 查找的窄接口和注册表。
- Adapter 只接收已校验的领域请求和最小配置，不读取其他能力的配置或隐式默认模型。
- 非生产环境允许确定性假 Adapter 供契约和集成测试使用；生产配置禁止假 Adapter。
- Adapter 必须返回结构化用量、上游延迟、可分类错误和取消结果；原始正文不得写入日志。

### B-07 统一可观测性与审计

- 链路字段统一使用 `trace_id`、`request_id`、`attempt_id`、`usage_event_id`。
- 指标只记录能力、逻辑模型、状态、延迟桶、预算命中和错误类别，不记录查询、图片、候选正文或 Embedding 内容。
- 审计覆盖开关变化、授权变化、额度拒绝、幂等冲突、Provider 禁用和手动回滚。
- 日志脱敏规则在 Cloud、Desktop Runtime 和 Web 端保持一致，禁止把 Token、Cookie、Provider Key 写入日志。

### B-08 Secret、网络与部署基线

- Provider Secret 使用只读文件或等价运行时 Secret 注入，容器继续非 root、只读文件系统、`cap_drop: ALL` 和资源限制。
- AI Gateway 只允许内部网络访问；公网 Nginx 仅保留 Phase 3 已发布路径与健康检查。
- 未完成能力专项上线门禁前，Phase 4 路径必须返回 `404` 或稳定的关闭错误，不得返回假成功。
- Provider 出站域名、地区、超时和证书校验纳入部署配置，不写入公开契约。

### B-09 三仓 SDK/类型同步

- Cloud 修改权威契约后，先运行三语言契约测试和制品校验，再同步 Desktop 快照。
- Web 只重新生成 `web-control-plane.ts`，不手写 Phase 4 服务端事实或 Mock 数据。
- Desktop 只增加共用状态和错误映射所需类型，不提前接入具体能力入口。
- 每次同步必须附带逐文件 SHA-256 结果和生成命令，避免三仓漂移。

### B-10 测试夹具与门禁

- 建立五项能力的统一请求指纹、幂等冲突、预算超限、撤销、取消、Provider 禁用和 Usage 终态夹具。
- 对每个 Adapter 使用确定性假实现覆盖成功、空结果、超时、取消、无可靠用量和非法响应。
- 使用隔离临时目录运行 Python/Runtime 测试，避免工作区 ACL 或系统临时目录权限影响结果。

## 4. 三仓交付边界

| 仓库 | Wave B 交付 | 明确不做 |
| --- | --- | --- |
| `petdock-cloud` | 控制面能力注册、Entitlement/额度投影、内部预占/结算、Runtime Claims、Gateway 中间件、Adapter 注册表、审计与测试夹具 | 真实 Provider、能力专属业务算法、公网新路由 |
| `desktop-pet` | Managed 能力状态/错误的共用窄类型、Runtime Lease 能力映射、契约快照同步和本地回退接口准备 | 具体能力 UI、真实远程调用、BYOK 自动降级 |
| `petdock-web` | 重新生成控制面类型，保持 Usage Summary 向后兼容，继续只调用 Spring Boot 控制面 | AI 数据面调用、Provider/模型展示、价格/支付入口、Mock Phase 4 数据 |

## 5. 推荐实施顺序

1. `B-01/B-02`：能力注册、Feature Flag 和 Entitlement/额度投影。
2. `B-03/B-04`：预占结算状态机、幂等键和 Runtime Claims。
3. `B-05/B-06`：Gateway 共用中间件与 Adapter 注册表，先接入确定性假 Adapter。
4. `B-07/B-08`：脱敏指标、审计、Secret 和容器/网络门禁。
5. `B-09/B-10`：三仓类型同步、契约夹具、跨端自动门禁。
6. Wave B 全部通过后，才进入 Wave C Managed Web Search；其他能力可以并行准备，但不得绕过共用门禁。

## 6. 验收矩阵

### Cloud

- 控制面单元测试覆盖开关缺失、授权拒绝、周期额度、并发额度和快照兼容。
- Usage 测试覆盖 `reserved/settled/released/failed`、重复终态和幂等冲突。
- Gateway 测试覆盖 Token 撤销、Claim 不匹配、预算超限、取消、断连和 Provider 禁用。
- Adapter 契约测试覆盖四类能力的确定性成功/失败响应和 Secret 脱敏。
- 契约 Python、TypeScript、Spring、制品校验和 Desktop 快照比对全部通过。

### Desktop/Web

- Desktop 类型检查、契约测试、Runtime 测试和生产构建通过；本地回退不改变既有 Chat 行为。
- Web 类型生成、typecheck、Vitest、生产构建和 Nginx 精确路由检查通过；不产生 Phase 4 Mock 数据。
- 三仓验证记录包含命令、结果、快照数量和未运行的真实 Provider/线上项。

## 7. 完成定义与回滚

Wave B 只有在共用状态机、内部认证、幂等、预算、日志脱敏、三仓同步和自动门禁全部通过后才标记 `Done`。任何一个能力的 Provider 或路由失败，只回滚该能力的开关、Claim 和 Adapter 注册，不回滚 Chat、其他能力或契约版本。

回滚顺序固定为：关闭能力开关 -> 停止签发对应 Claim -> 拒绝新预占 -> 等待已预占请求收敛 -> 保留审计和 Usage 终态 -> 恢复上一版 Adapter/配置。数据库只允许向后兼容的 expand 迁移，不能通过回滚删除既有 Chat 数据。

## 8. 下一工作项

Wave B 完成后进入 `P4-W01`：Managed Web Search Provider。Web Search 是首个灰度能力，必须继续复用 Electron Main 的 URL/DNS/SSRF/重定向/MIME/正文预算策略，并在独立白名单和独立开关下完成真实 Provider 验收。
