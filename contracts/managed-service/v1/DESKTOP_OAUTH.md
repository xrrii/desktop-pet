# PetDock Desktop OAuth v1 冻结规则

## 1. 客户端类型

- Electron Desktop 是 OAuth Public Client，不保存 `client_secret`。
- 使用系统浏览器，不使用 Electron 内嵌登录页。
- 使用 Authorization Code + PKCE，`code_challenge_method` 固定为 `S256`。
- 每次授权生成独立的高熵 `state`、`code_verifier` 和 loopback 监听端口。

## 2. Loopback Redirect

- 只监听 `127.0.0.1`，不监听 `0.0.0.0`、局域网地址或公网地址。
- 端口由操作系统随机分配，redirect URI 使用实际端口。
- 回调路径固定为 `/oauth/callback`。
- Authorization Server 只对 `petdock-desktop` 接受 `http://127.0.0.1:<explicit-port>/oauth/callback`；必须包含显式端口，并拒绝用户信息、查询参数、片段、其他协议、其他主机和其他路径。
- 非桌面 Client 的 redirect URI 继续执行完整字符串精确匹配，不继承 loopback 随机端口规则。
- Main 必须校验 `state`，拒绝缺失、重复、过期或不匹配的回调。
- 授权码只允许消费一次；成功、失败、超时或用户取消后立即关闭监听器。
- 第一版授权等待上限为 5 分钟，超时后返回稳定本地错误，不自动重新打开浏览器。

示例仅用于说明，不是正式域名：

```text
http://127.0.0.1:49152/oauth/callback
```

## 3. 会话隔离

- 官网业务 API 与 OAuth 账号主机都使用控制面签发的 HttpOnly 安全 Cookie，但分别建立独立的 Host-only Web Session。
- `api.petdock.site` 与 `account.petdock.site` 可以使用同名 `__Host-petdock_web_session`；Cookie 均不得设置 `Domain`，浏览器不得在两个主机间共享 Session。用户已登录官网时，首次桌面授权仍可能需要在账号主机重新登录。
- Electron 只获得桌面 Access/Refresh Token，不读取官网 Cookie。
- 桌面 Refresh Token 只由 Main 使用 `safeStorage` 持久化，不下发 Renderer 或 Python Runtime。
- Python Runtime 只接收 15 分钟官方 Runtime Token，不接收桌面 Refresh Token。
- 官网普通退出只结束 Web Session，不影响已授权桌面设备；单设备撤销和全部设备退出必须显式撤销对应桌面会话，不得通过共享 Cookie 实现。

## 4. Token 请求

授权请求至少包含：

```text
response_type=code
client_id=<desktop-public-client-id>
redirect_uri=http://127.0.0.1:<random-port>/oauth/callback
code_challenge=<base64url-sha256>
code_challenge_method=S256
state=<high-entropy-random>
```

换取 Token 时必须提交原始 `code_verifier` 和完全一致的 `redirect_uri`。不得在 URL、日志、Renderer 事件或错误消息中输出授权码、Token 或 Verifier。

## 5. 身份与会话参数

- 身份服务由 PetDock 自建，并提供标准 OIDC/OAuth2 接口。Discovery、UserInfo、Token Response 和 RFC 7009 撤销字段以 `IDENTITY_AND_SESSION.md` 为准。
- Issuer 固定为 `https://account.petdock.site`，桌面 Public Client ID 固定为 `petdock-desktop`。
- 桌面 Refresh Token 的绝对有效期为 30 天，每次使用都必须轮换。
- 已轮换 Refresh Token 再次出现时，撤销当前设备对应的整个 Token Family。
- `petdock.site` 已完成购买；DNS 解析和证书签发完成前，不开放公网登录流量。

## 6. 系统浏览器交互

- 正式 OAuth 交互页面只从 `https://account.petdock.site` 同源加载，入口固定为 `/oauth/login`、`/oauth/register`、`/oauth/consent` 和稳定错误页。
- 未登录的 Authorization Request 由服务端 HttpSession RequestCache 保存。登录或注册成功后，前端只能访问 `GET /oauth/resume`；该端点只恢复服务端保存且已校验为本机 `/oauth2/authorize` 的请求，并返回 `302`，不得接收任意 `returnTo`、完整 Authorization URL 或外部跳转地址。
- 账号主机只允许反向代理 `GET /api/v1/web/session`、`POST /api/v1/web/auth/login` 和 `POST /api/v1/web/auth/register` 三个账号接口，用于建立独立账号主机 Session；不得把整个官网 Web API 暴露为无约束别名。
- OAuth 页面不得在 Storage、日志、分析系统、错误正文或页面快照中保存授权码、Token、密码、Cookie、`state`、PKCE 参数或完整 redirect URI。

## 7. 标准 Authorization Consent

- `petdock-desktop` 固定启用 `requireAuthorizationConsent=true`，使用 Spring Authorization Server 标准 GET/POST `/oauth2/authorize` 和现有 JDBC Consent 持久化，不新增 JSON Consent API、自定义授权协议或 Consent 业务表。
- Consent 页面展示固定名称 `PetDock Desktop`、发布方 `PetDock` 和本次请求的已登记权限。请求必须包含 `openid`、`desktop.session`，并且只能增加已登记的 `profile`、`email`。
- 当前官方权限作为完整集合整体同意或整体拒绝，不提供逐项勾选。首次授权或权限扩大时必须展示 Consent；相同用户、Client 和权限集合的重复授权可以复用持久化 Consent 跳过页面。
- Consent 确认的是 OAuth Client，不是具体设备。页面不得展示或采集设备 ID、硬件序列号、主机名、IP 定位或设备显示名；设备只在授权码交换成功后按现有设备注册契约建立。
- 拒绝授权必须通过标准 `error=access_denied` 和原始 `state` 返回已校验 loopback，不签发 Token、不持久化 Refresh Token，也不创建设备。

## 8. 开发与发布门禁

- 本地或 shared-dev 完成门禁必须使用两个独立测试主机名和受信 HTTPS 证书，分别模拟 `api` 与 `account` 的 Host-only Cookie；同一 `127.0.0.1` 主机的不同端口不能证明 Cookie 隔离。
- ICP 备案未完成时可以进行本地、shared-dev、Testcontainers 和分离测试主机 HTTPS 联调；正式域名公网登录仍须等待备案、DNS、TLS 和入口网关配置全部就绪。
- P2-W02 只有在真实 Spring Authorization Server、分离 Host Session、系统浏览器和 Desktop loopback/PKCE 跨端联调通过后才能标记为完成；Mock 测试不能替代该门禁。
