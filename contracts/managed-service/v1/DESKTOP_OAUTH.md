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
- Main 必须校验 `state`，拒绝缺失、重复、过期或不匹配的回调。
- 授权码只允许消费一次；成功、失败、超时或用户取消后立即关闭监听器。
- 第一版授权等待上限为 5 分钟，超时后返回稳定本地错误，不自动重新打开浏览器。

示例仅用于说明，不是正式域名：

```text
http://127.0.0.1:49152/oauth/callback
```

## 3. 会话隔离

- 官网前端使用控制面签发的 HttpOnly 安全 Cookie 或等价 Web Session。
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

- 身份服务由 PetDock 自建，并提供标准 OIDC/OAuth2 接口。
- Issuer 固定为 `https://account.petdock.site`，桌面 Public Client ID 固定为 `petdock-desktop`。
- 桌面 Refresh Token 的绝对有效期为 30 天，每次使用都必须轮换。
- 已轮换 Refresh Token 再次出现时，撤销当前设备对应的整个 Token Family。
- `petdock.site` 已完成购买；DNS 解析和证书签发完成前，不开放公网登录流量。
