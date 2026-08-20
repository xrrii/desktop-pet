# PetDock Web 身份与会话契约

本文档冻结官网 `P2-W01` 的账号与会话、`P2-W02` 的账号主机复用边界，以及 `P2-W03` 的服务方案和设备管理接口。它与 `openapi/web-control-plane.yaml`、`DESKTOP_OAUTH.md`、`error-codes/error-codes.json` 和 `DECISION_REGISTER.md` 一起构成官网与 OAuth 浏览器交互契约；不改变桌面 Refresh Token 或 Runtime Token 的信任边界。

## 1. 仓库、域名与接口边界

- 官网前端位于独立 `petdock-web` 仓库，正式入口为 `https://petdock.site`。
- 官网 Web API 由 Spring Boot 控制面提供，正式服务地址为 `https://api.petdock.site`。
- 官网业务路径统一使用 `/api/v1/web/*`，桌面 Bearer API 继续使用 `control-plane.yaml` 中的 `/api/v1/*` 资源路径；两者不得在前端请求层混用。
- 生产浏览器 Origin 只允许精确的 `https://petdock.site`。本地和 shared-dev 可以通过未提交环境配置增加受控开发 Origin；生产不得使用通配符 CORS。
- 官网只调用 Spring Boot 控制面，不调用 FastAPI AI 数据面，不读取桌面 Refresh Token、Runtime Token、Provider Key 或 BYOK Key。

## 2. Web Session Cookie

会话 Cookie 固定为 `__Host-petdock_web_session`，服务端必须同时满足：

- `Secure`、`HttpOnly`、`SameSite=Lax`；
- `Path=/`；
- 不设置 `Domain`，保持 API 主机范围；
- 所有会话和资料响应返回 `Cache-Control: no-store`；
- Session ID 不进入响应 JSON、前端存储、日志或错误消息。

官网 API 使用服务端 Session，不把登录态编码为浏览器可读 JWT。Session 可以保存在 Redis，Redis 丢失只会使 Web Session 失效，不影响 PostgreSQL 用户事实、桌面 Token Family 或设备撤销事实。服务端采用 Spring Session 默认的空闲过期口径，实际到期时间由 `WebSessionSnapshot.expiresAt` 返回；客户端不得自行延长有效期。

## 3. CSRF

浏览器首次调用 `GET /api/v1/web/session` 时，服务端创建匿名 Session（如尚不存在）并返回随机、不可预测的 `csrfToken`。前端只把该值放入后续写请求的 `X-PetDock-CSRF` Header，不写入 Cookie、LocalStorage、URL、日志或错误消息。

以下请求必须带 `X-PetDock-CSRF`，并且 Token 必须与当前 Session 绑定：

- `POST /api/v1/web/auth/register`
- `POST /api/v1/web/auth/login`
- `POST /api/v1/web/auth/logout`
- `PATCH /api/v1/web/profile`
- `PUT /api/v1/web/account/password`
- `DELETE /api/v1/web/devices/{deviceId}`
- `DELETE /api/v1/web/devices`

缺失、格式不合法、过期或不匹配统一返回 `csrf_invalid`。服务端不得接受查询参数、JSON 字段或自定义 Cookie 中的 CSRF 值代替 Header。CORS 只允许必要的 `GET`、`POST`、`PATCH`、`PUT`、`DELETE` 方法和 `Content-Type`、`X-PetDock-Request-Id`、`X-PetDock-CSRF` 请求头，并固定 `Access-Control-Allow-Credentials: true`。

## 4. Session 生命周期

| 操作 | 结果 |
| --- | --- |
| 首次 `GET /session` | 创建匿名 Session，返回 `authenticated=false`、CSRF Token 和 `expiresAt=null` |
| 注册成功 | 创建用户、建立已登录 Session、轮换 Session ID 和 CSRF Token，返回 `201` |
| 登录成功 | 建立已登录 Session、轮换 Session ID 和 CSRF Token，返回 `200` |
| 普通官网退出 | 只销毁当前 Web Session 并清理 Cookie，返回 `204`；不撤销桌面设备或 Token Family |
| Session 过期或 Redis Session 丢失 | 受保护接口返回 `authentication_required`；客户端重新调用 `/session` 获取匿名 CSRF Token |
| 修改密码成功 | 撤销其他 Web Session，当前 Session 也失效并清理 Cookie，返回 `204`；客户端必须重新登录 |

`WebSessionSnapshot` 的 `user` 仅在 `authenticated=true` 时存在。账号信息为脱敏业务资料，不包含密码哈希、Session ID、Token、设备密钥或用量正文。

## 5. P2-W01 账号字段

### 5.1 username

- 独立登录标识，不使用邮箱代替登录名。
- 长度 3 至 32 个字符，只允许 ASCII 字母、数字、`.`、`_`、`-`；首尾必须是字母或数字。
- 服务端按小写形式执行唯一性判断和登录查询，响应返回规范化后的 username。
- 注册成功后 username 不可通过资料接口修改。

### 5.2 密码

- 注册和修改密码要求 10 至 128 个字符，不强制大小写、数字或符号组合。
- 服务端使用成熟框架的密码哈希实现；算法、成本和升级策略属于服务端安全配置，不写入客户端契约。
- 明文密码只存在于单次请求内存，不写入日志、审计、数据库、缓存或异常消息。
- `users.password_hash` 可以为空。没有密码凭据的历史或外部身份用户不能通过 username/密码登录，修改密码返回 `password_authentication_unavailable`；本轮不提供无密码账号的绑定流程。

### 5.3 资料

- 注册必须提交 `displayName`；服务端去除首尾空白、折叠连续空白、拒绝控制字符并限制为 1 至 100 个 Unicode 字符。
- `PATCH /profile` 本轮只允许更新 `displayName`。
- `email`、`emailVerified` 只作为现有账号的只读脱敏字段返回；邮箱绑定、验证、变更和通知延后。
- `passwordEnabled` 只表示当前账号是否存在可用密码哈希，不暴露哈希内容。

### 5.4 内部 subject

- 官网注册用户的 subject 由控制面按 `usr_<UUID v4>` 生成，与用户表主键、username 和邮箱相互独立，创建后不可修改。
- subject 用于稳定的 OIDC `sub`，不属于 Web 账号请求或响应字段，不得进入前端日志、持久化存储或页面内容。

## 6. 错误与审计

- 所有 Web API 错误使用统一 `ErrorEnvelope`，包含 `code`、稳定中文 `message`、`requestId`、`retryable` 和可空 `retryAfterSeconds`。
- 登录失败统一返回 `invalid_credentials`，不得区分 username 不存在、密码错误、账号暂停或密码凭据不可用；详细稳定原因只进入脱敏安全审计。
- 注册重复 username 返回 `username_unavailable`；客户端可以提示重新选择用户名。
- 输入不符合契约或密码策略返回 `invalid_request` 或 `password_policy_violation`，不返回字段正文。
- 限流返回 `rate_limited` 和 `Retry-After`，具体阈值由服务端安全配置决定。

以下审计事件在实现 P2-W01 时必须覆盖：`web_registration_succeeded`、`web_registration_failed`、`web_login_succeeded`、`web_login_failed`、`web_logout_succeeded`、`web_profile_updated`、`web_password_changed`、`web_csrf_rejected`。事件不得写入密码、Cookie、CSRF Token、完整 username、邮箱正文或异常堆栈。

## 7. P2-W03 服务方案与设备管理

### 7.1 Web API

P2-W03 在官网 API 主机新增：

```text
GET    /api/v1/web/entitlements
GET    /api/v1/web/devices?page=1&pageSize=20
DELETE /api/v1/web/devices/{deviceId}
DELETE /api/v1/web/devices
```

- 四个接口都要求已登录 Web Session，并返回或遵守 `Cache-Control: no-store`。
- 两个 `DELETE` 必须校验 `X-PetDock-CSRF`，不允许自动重试。
- `account.petdock.site` 不开放上述接口别名；账号主机继续只开放 Session、登录和注册三个最小 Web API。

### 7.2 服务访问与计费模式

`EntitlementSnapshot` 使用三种互斥状态：

| 状态 | `status` | `billingMode` | `plan` | Capability `remaining` |
| --- | --- | --- | --- | --- |
| 未开通 | `inactive` | `null` | `null` | 不返回 Capability |
| 套餐订阅 | `active` | `subscription` | 非空套餐标识 | 非负整数，表示套餐剩余额度 |
| 按量计费 | `active` | `pay_as_you_go` | `null` | `null`，表示按实际用量结算 |

按量模式的 `remaining=null` 不表示免费、无限或额度耗尽，`expiresAt=null` 表示没有套餐有效期，未来账期由 Usage 和账单契约表达。套餐模式和按量模式均必须由服务端 Entitlement 明确授权；客户端不能根据 `billingMode` 自行扩大能力。

当前免费 Beta 只启用 `subscription`。`pay_as_you_go` 先作为正式收费阶段的兼容协议冻结；P2-W03 不提供模式切换、价格、余额、充值、扣费、订单或退款接口，也不得在前端构造这些数据。

### 7.3 设备列表与撤销

- 列表只返回当前用户的活动设备，按 `lastSeenAt DESC, id DESC` 稳定排序并分页；默认 `pageSize=20`，上限 50。
- 设备字段只包含 `id`、`displayName`、`platform`、`createdAt` 和 `lastSeenAt`。`lastSeenAt` 当前表示最近登记时间，不表示实时在线。
- 官网不返回 `current`，也不接受 Device Header、URL 参数或桌面 Token 来标记当前设备。
- 撤销不存在或不属于当前用户的设备统一返回 `device_not_found`，不泄露设备归属。
- 单设备撤销和全部设备撤销联动失效设备相关的 OAuth Access/Refresh Token、Token Family、Runtime Session 和撤销缓存事实；当前 Web Session 保持有效。
- 全部撤销作用于服务端在事务中选出的全部活动设备，不受当前页面分页限制；空集合时幂等返回 `204`。

## 8. OAuth 浏览器交互与后续工作项

- 桌面 OAuth Issuer、Authorization Endpoint、Token Endpoint、PKCE 和 loopback 规则保持 `IDENTITY_AND_SESSION.md` 与 `DESKTOP_OAUTH.md` 不变。
- P2-W02 将 `petdock-desktop` 的 `authorization_consent_enabled` 固定为 `true`，对应 `requireAuthorizationConsent=true`；同意和拒绝只通过 Spring Authorization Server 标准 GET/POST `/oauth2/authorize` 处理，不新增 JSON Consent API。
- `account.petdock.site` 复用同一用户目录、账号应用服务、Spring Session 机制和 Redis，但建立独立 Host-only `__Host-petdock_web_session`；它不共享 `api.petdock.site` 的同名 Cookie，不设置父域 `Domain`，退出任一 Session 不隐式清除另一个 Session 或桌面 Token。
- 账号主机只开放 `GET /api/v1/web/session`、`POST /api/v1/web/auth/login` 和 `POST /api/v1/web/auth/register` 三个最小接口别名。现有 `web-control-plane.yaml` 仍描述官网 API 服务，不因这些受限入口增加新的 Consent API。
- OAuth 页面固定为 `/oauth/login`、`/oauth/register` 和 `/oauth/consent`。登录或注册成功后只能访问 `GET /oauth/resume`，由服务端 SavedRequest 恢复已校验的本机 `/oauth2/authorize`；不得接受任意 `returnTo` 或完整外部 URL。
- Desktop 显式重新登录使用标准 `prompt=login`，账号主机清理当前 Host-only Session 后重新显示登录页；登录成功后 `/oauth/resume` 消费该一次性提示再恢复授权请求。官网 `petdock.site` 的普通退出不替代该账号切换流程，也不撤销 Desktop Token。
- Consent 只确认固定 `PetDock Desktop` Client 和本次请求的已登记权限，不展示具体设备。当前官方权限整体同意或整体拒绝；首次授权或权限扩大时展示，相同用户、Client 和权限集合的重复授权可以复用持久化 Consent。
- 密码找回、邮箱验证、MFA、账号删除、按量模式启用、充值、订单、Usage API 和支付回调仍不属于当前实现；P2-W03 设备与只读服务快照以第 7 节为准。
- Desktop `P2-11` 在 P2-W01~W04 完成后实施，使用系统浏览器打开官网管理入口，不共享 Cookie 或桌面 Token。

## 9. 兼容与回滚

- P2-W03 只增加独立 Web API，并在尚未实现或发布的 Entitlement/Usage 响应上完成首次交付前模型校正；已实现的 P2-W01/P2-W02 字段、路径和认证语义不变。
- 未登录时 Web API 不影响桌面 BYOK；关闭官网 Web Session 或官网 Feature Flag 不删除用户、设备、Refresh Token Family 或本地配置。
- 业务实现发布前必须先通过契约测试、CSRF/Session 安全测试、MockMvc 和 Redis Session 集成测试；契约冻结不代表服务端功能已经完成。
