# Managed Service v1 兼容规则

## 1. 请求和响应

- 服务端可以增加可选响应字段，客户端必须忽略未知字段。
- 客户端不得发送契约未声明的敏感字段；服务端应拒绝未知认证和路由字段。
- 已发布的必填字段、类型、含义和幂等语义不得在 v1 内改变。
- 时间统一使用 UTC RFC 3339 字符串；JWT NumericDate 使用 UTC Unix 秒。
- ID 区分大小写并视为不透明值，客户端不得从 ID 推导用户、设备或区域信息。

## 2. 枚举和错误

- 能力名称和来源属于受控枚举，新增值需要客户端版本门槛和 Feature Flag。
- 新错误码可以在 v1 内增加；旧客户端必须显示通用错误，并保留 `requestId` 供排查。
- `retryable` 只描述服务端判断，不授权客户端无限重试。
- Chat 自动认证重试只允许发生在尚未输出文本或 ToolCall 时，且最多一次。

## 3. 流式事件

- SSE 事件包含事件版本、单调递增 `sequence`、`traceId` 和 `requestId`。
- 客户端忽略未知的可选事件类型，但不能忽略终止、安全或认证事件。
- 已产生输出的流不得从头静默重放。
- 断流后是否可恢复必须由具体事件或错误明确声明，不能依据 HTTP 状态猜测。

## 4. 发布支持

- 服务端按 `X-PetDock-Client-Version` 执行最低版本策略。
- 不支持的客户端返回 `unsupported_client_version`，不得返回模糊的认证错误。
- 首个支持 Managed 的桌面版本为 `0.2.0`。
- 服务端至少兼容当前和上一个受支持的 Managed 桌面小版本，每个已发布 Managed 小版本的兼容窗口不少于 6 个月。
- 常规升级先提示；仅安全漏洞、协议不兼容或重大服务事故允许提高最低版本并强制升级。
- 最低版本和 Managed 紧急开关由服务端配置；关闭 Managed 不得影响本地 BYOK。
- 破坏性变更使用新 URL 主版本和新契约目录，不原地覆盖 v1。

## 5. 官网与 OAuth Web Session

- 官网 Web API 与桌面 Bearer API 分文件定义，使用 `/api/v1/web/*` 路径和 `__Host-petdock_web_session` HttpOnly Cookie。
- `api.petdock.site` 与 `account.petdock.site` 使用相同 Cookie 名称时仍必须分别建立 Host-only Session，不得通过设置父域 `Domain` 使已有 Session 跨主机可见。首次桌面授权需要重新登录属于 v1 预期行为。
- Web Session、CSRF Header、登录态和资料响应中的未知可选字段必须按通用降级处理；Session ID、CSRF Token 和密码不得进入日志或前端持久化。
- 官网普通退出只结束当前 Web Session，不改变桌面 Access/Refresh Token、Token Family、设备或 Runtime Session。
- 官网账号字段和接口可以在 v1 内增加可选字段，但不得改变 username 规范、CSRF 要求、Cookie 安全属性或桌面/官网信任域边界。
- 启用标准 Authorization Consent 不改变 Public Client ID、PKCE、loopback、Token Response 或错误回调协议。首次授权和权限扩大可以增加页面交互，相同权限的重复授权可以跳过页面；旧桌面客户端必须继续按标准 `access_denied` 处理拒绝结果。
