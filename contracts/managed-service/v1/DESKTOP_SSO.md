# Desktop SSO 与显式账号选择

状态：v1 增量契约，2026-09-12。取代旧文档中所有主动登录强制 prompt=login 的要求；旧客户端 login 继续兼容。

每次主动登录发送 prompt=select_account。在标准授权端点可能复用认证或 Consent 之前执行选择门禁。授权事务存 Redis，5 分钟过期；复用凭证 60 秒过期且只能消费一次。官网与账号中心继续独立 Host-only Cookie。官网 A、桌面选择 B 后，官网保持 A。相同权限 Consent 可以复用，但账号选择不能省略。

## 浏览器与 API

- 已校验授权跳转到固定官网 `/oauth/select-account?transaction=<id>`，不把原 OAuth 参数交给官网。
- 官网 GET `/api/v1/web/oauth/transactions/{transactionId}` 返回 `{transactionId,expiresAt,account}`；account 为 WebProfile 或 null。匿名允许，沿用 Cookie；将页面展示的官网 Session 和身份绑定到事务。读取失败不可当作未登录。
- 官网 POST `/api/v1/web/oauth/transactions/{transactionId}/confirm`，Session + `X-PetDock-CSRF`，JSON `{expectedUsername}`，返回 `{actionUrl,transactionId,ticket}`。actionUrl 固定为账号中心 `/oauth/sso/decision`。确认时校验当前 Session 与展示时一致，内部 UUID 一致、用户仍有效。
- 浏览器立即表单 POST 到 actionUrl，字段 `{transactionId,action:reuse,ticket}`。不得把 ticket 放 URL、Storage、日志或统计。目标真实 Session 和精确官网 Origin 均必须匹配；错误浏览器不得消耗有效凭证。源 Session 撤销、换号或过期后交接失败。
- 其他账号或取消同样表单 POST `/oauth/sso/decision`，字段 `{transactionId,action:other|cancel}`，无需 ticket；验证精确官网 Origin 和账号中心 Session。取消只回原先校验过的 loopback，标准 access_denied 与原 state。
- other 跳固定账号中心 `/oauth/login?transaction=<id>`。登录页用账号中心 `/api/v1/web/session` 初始化 CSRF，然后 POST `/api/v1/web/oauth/password-login`，JSON `{transactionId,username,password}`，返回 `{resumeUrl}`。此接口匿名允许但必须 Session + CSRF；仅账号主机可调用，核验事务浏览器，登录成功后绑定用户并轮换 Session/CSRF。旧无 transaction 登录不变。
- resumeUrl 固定为账号中心 `/oauth/sso/resume?transaction=<id>`；服务器恢复保存的 OAuth 参数并执行标准 PKCE/Consent。恢复和 Consent 前核对所选用户，多标签身份变化时明确失败，不能串号。

错误沿用统一 API 错误结构：oauth_selection_expired (410，重新发起)、oauth_selection_mismatch (409，刷新选择或重新发起)、oauth_sso_unavailable (503，可重试)。现有 authentication_required、csrf_invalid、invalid_credentials、invalid_request 仍适用。账号中心表单错误跳固定 `/oauth/error?reason=account_selection_failed`。

## 配置与边界

`PETDOCK_DESKTOP_SSO_ENABLED=false` 默认关闭；关闭时 select_account 仍创建隔离事务并直接进入密码登录，不能自动复用账号中心旧认证。`PETDOCK_DESKTOP_SSO_SITE_ORIGIN=https://petdock.site` 是选择页面与表单精确来源；账号地址从已有 issuer 读取。正式环境仅允许冻结域名。有限 Session ID 轮换只迁移服务端随机浏览器绑定；不接受 URL 中的 Session ID。身份选择改变后旧事务不得复用新认证。

所有选择响应使用 no-store，页面排除分析采集。官网选择文档采用 Referrer-Policy: strict-origin，仅发送官网 Origin，不发送事务路径或查询参数，以保留原生跨主机 POST 的精确 Origin；不得使用会将 Origin 变为 null 的 no-referrer。JSON API、账号主机页面和恢复响应继续使用 no-referrer；服务端不得为兼容浏览器而放行 null Origin。新增接口不发桌面 Token，仍由原标准 OAuth 交换流程签发。Redis 故障不能产生假成功；无需数据库迁移。真实三主机 HTTPS 浏览器验收独立于单元测试。
