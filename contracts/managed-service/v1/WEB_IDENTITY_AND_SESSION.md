# PetDock Web 身份与会话契约

本文档冻结官网 `P2-W01` 所需的 Web API、HttpOnly Session、CSRF 和账号字段，以及 `P2-W02` 账号主机复用这些能力时的最小边界。它与 `openapi/web-control-plane.yaml`、`DESKTOP_OAUTH.md`、`error-codes/error-codes.json` 和 `DECISION_REGISTER.md` 一起构成官网与 OAuth 浏览器交互契约；不改变桌面 Refresh Token 或 Runtime Token 契约。

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

缺失、格式不合法、过期或不匹配统一返回 `csrf_invalid`。服务端不得接受查询参数、JSON 字段或自定义 Cookie 中的 CSRF 值代替 Header。CORS 只允许必要的 `GET`、`POST`、`PATCH`、`PUT` 方法和 `Content-Type`、`X-PetDock-Request-Id`、`X-PetDock-CSRF` 请求头，并固定 `Access-Control-Allow-Credentials: true`。

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

## 7. OAuth 浏览器交互与后续工作项

- 桌面 OAuth Issuer、Authorization Endpoint、Token Endpoint、PKCE 和 loopback 规则保持 `IDENTITY_AND_SESSION.md` 与 `DESKTOP_OAUTH.md` 不变。
- P2-W02 将 `petdock-desktop` 的 `authorization_consent_enabled` 固定为 `true`，对应 `requireAuthorizationConsent=true`；同意和拒绝只通过 Spring Authorization Server 标准 GET/POST `/oauth2/authorize` 处理，不新增 JSON Consent API。
- `account.petdock.site` 复用同一用户目录、账号应用服务、Spring Session 机制和 Redis，但建立独立 Host-only `__Host-petdock_web_session`；它不共享 `api.petdock.site` 的同名 Cookie，不设置父域 `Domain`，退出任一 Session 不隐式清除另一个 Session 或桌面 Token。
- 账号主机只开放 `GET /api/v1/web/session`、`POST /api/v1/web/auth/login` 和 `POST /api/v1/web/auth/register` 三个最小接口别名。现有 `web-control-plane.yaml` 仍描述官网 API 服务，不因这些受限入口增加新的 Consent API。
- OAuth 页面固定为 `/oauth/login`、`/oauth/register` 和 `/oauth/consent`。登录或注册成功后只能访问 `GET /oauth/resume`，由服务端 SavedRequest 恢复已校验的本机 `/oauth2/authorize`；不得接受任意 `returnTo` 或完整外部 URL。
- Consent 只确认固定 `PetDock Desktop` Client 和本次请求的已登记权限，不展示具体设备。当前官方权限整体同意或整体拒绝；首次授权或权限扩大时展示，相同用户、Client 和权限集合的重复授权可以复用持久化 Consent。
- 密码找回、邮箱验证、MFA、账号删除、全部桌面设备退出、套餐、充值、订单、Entitlement 管理、Usage API 和支付回调不属于本轮契约。
- Desktop `P2-11` 在 P2-W01~W04 完成后实施，使用系统浏览器打开官网管理入口，不共享 Cookie 或桌面 Token。

## 8. 兼容与回滚

- P2-W02 不改变 `web-control-plane.yaml` 或现有桌面 OpenAPI 的字段、路径、认证方式和错误语义；OAuth 页面与标准协议端点由本文档和 `DESKTOP_OAUTH.md` 冻结。
- 未登录时 Web API 不影响桌面 BYOK；关闭官网 Web Session 或官网 Feature Flag 不删除用户、设备、Refresh Token Family 或本地配置。
- 业务实现发布前必须先通过契约测试、CSRF/Session 安全测试、MockMvc 和 Redis Session 集成测试；契约冻结不代表服务端功能已经完成。
