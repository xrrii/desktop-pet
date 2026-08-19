# Managed Service v1 身份与会话契约

本文档冻结 `P2-00` 中 OIDC/OAuth2、桌面账号快照、Feature Flag、设备命名和服务端时间的字段语义。它与 OpenAPI、JSON Schema 和 `DECISION_REGISTER.md` 一起构成权威契约。

## 1. OIDC Discovery

Issuer 固定为 `https://account.petdock.site`。Discovery 地址为：

```text
GET https://account.petdock.site/.well-known/openid-configuration
```

Discovery 响应至少包含以下字段和值：

| 字段 | 固定值或要求 |
| --- | --- |
| `issuer` | `https://account.petdock.site` |
| `authorization_endpoint` | `https://account.petdock.site/oauth2/authorize` |
| `token_endpoint` | `https://account.petdock.site/oauth2/token` |
| `revocation_endpoint` | `https://account.petdock.site/oauth2/revoke` |
| `userinfo_endpoint` | `https://account.petdock.site/userinfo` |
| `jwks_uri` | `https://account.petdock.site/.well-known/jwks.json` |
| `response_types_supported` | 包含 `code` |
| `grant_types_supported` | 包含 `authorization_code`、`refresh_token` |
| `scopes_supported` | 包含 `openid`、`desktop.session`，可包含 `profile`、`email` |
| `token_endpoint_auth_methods_supported` | 包含 `none` |
| `code_challenge_methods_supported` | 仅包含 `S256` |

桌面 Public Client ID 固定为 `petdock-desktop`，不配置 `client_secret`。桌面授权请求至少包含 `scope=openid desktop.session`，并且只能增加已登记的 `profile`、`email`。

`petdock-desktop` 固定启用 Spring Authorization Server 标准 Authorization Consent。首次授权或权限扩大时展示固定 Client 和权限说明，相同用户、Client 和权限集合的重复授权可以复用持久化 Consent；当前官方权限整体同意或整体拒绝，不按具体设备逐项授权。浏览器页面、账号主机 Session 和恢复规则以 `DESKTOP_OAUTH.md` 为准。

## 2. UserInfo 与账号脱敏快照

桌面 Main 使用短期 Access Token 调用：

```text
GET https://account.petdock.site/userinfo
Authorization: Bearer <desktop-access-token>
```

响应允许的最小字段为：

```json
{
  "sub": "合成 subject",
  "email": "合成邮箱",
  "email_verified": true,
  "preferred_username": "合成用户名",
  "name": "合成显示名"
}
```

除上述字段外，客户端必须忽略未知字段。UserInfo 不返回手机号、头像、地址、Provider 信息、完整用量、Prompt、回答或其他正文。Electron Main 负责提取并脱敏后再通过 IPC 提供给 Renderer；控制面不新增重复的账号资料接口。

## 3. Token Response

Authorization Code 和 Refresh Token 两种成功响应均遵循 RFC 6749；授权登录响应额外返回 OIDC `id_token`：

```json
{
  "access_token": "仅用于合成测试的占位符",
  "token_type": "Bearer",
  "expires_in": 300,
  "refresh_token": "仅用于合成测试的占位符",
  "scope": "openid desktop.session",
  "id_token": "仅用于合成测试的占位符"
}
```

`id_token` 只在 Authorization Code 登录响应中出现；Refresh Token 响应不得要求客户端重复提交 `client_secret`。任何 Token Response 都不得包含 Provider Key、API Key、Cookie 或用户正文。

## 4. RFC 7009 主动撤销

```text
POST /oauth2/revoke
Content-Type: application/x-www-form-urlencoded

client_id=petdock-desktop&token=<token>&token_type_hint=refresh_token
```

Public Client 必须提交 `client_id`，`token_type_hint` 可选，取值为 `access_token` 或 `refresh_token`。无论 Token 是否存在、是否已撤销或是否属于当前用户，成功请求都返回 HTTP 200 空响应，不泄露存在性。服务端必须记录不含 Token 正文的安全审计事件。

## 5. Feature Flag

登录前即可访问控制面 Feature Flag；该请求不携带 Access Token：

```text
GET /api/v1/features
X-PetDock-Client-Version: 0.2.0
X-PetDock-Request-Id: <uuid>
```

响应字段由 `control-plane.yaml` 的 `FeatureFlagSnapshot` 定义：`version` 固定为 `1`，`managed_login_enabled` 控制官方登录入口，`minimum_client_version` 控制最低受支持版本。服务不可用、字段缺失和版本不兼容时，桌面端本地按 `managed_login_enabled=false` 处理。该端点不返回用户信息或 Token。

## 6. 端点覆盖与环境

开发端点只能通过未提交环境变量注入：

- `local-mock`、`shared-dev`：允许回环地址、服务器内网地址和 SSH 隧道端口。
- `staging`、`production`：拒绝覆盖，固定官方 Issuer、控制面和数据面地址。

生产构建检查必须验证构建产物不含静态开发服务端点（`127.0.0.1`、`localhost`、`.local` 或开发端口）。OAuth 登录运行时生成的 `http://127.0.0.1:<random-port>/oauth/callback` 是允许的 loopback 回调，不属于静态开发服务端点；检查结果只输出通过/失败，不输出完整配置值。

## 7. 设备显示名

客户端提交 `deviceId`、`displayName` 和 `platform=windows`。服务端执行去除首尾空白、折叠连续空白、拒绝控制字符和 1 至 100 个 Unicode 字符校验。客户端无法提供有效名称时使用 `Windows Desktop`。同一用户重复注册同一 `deviceId` 只更新名称和 `lastSeenAt`；同一 ID 属于其他用户时返回冲突。

当前设备由服务端将桌面 Access Token 所属的 OAuth 授权记录与设备绑定后解析，不新增设备请求头，也不接受客户端通过 Header 覆盖当前设备。首次成功调用 `POST /api/v1/devices` 时，一个尚未绑定的 OAuth 授权只能绑定一个 `deviceId`；后续 Refresh Token 轮换保持同一绑定。`GET /api/v1/devices/current` 在授权尚未绑定设备时返回 `device_not_found`。

## 8. Entitlement 与计费模式快照

桌面端通过 `GET /api/v1/entitlements` 读取脱敏服务访问快照。该快照区分：

- `inactive`：当前没有可用的 Managed 服务授权，`billingMode`、`plan`、`version` 和 `expiresAt` 均为 `null`，Capability 为空。
- `subscription`：用户使用套餐订阅，`plan` 为非空套餐标识，Capability 使用 `quotaMode=quota` 且 `remaining` 为非负整数。
- `pay_as_you_go`：用户不订阅套餐并显式采用按量计费，`plan=null`、`expiresAt=null`，Capability 使用 `quotaMode=metered` 且 `remaining=null`。

按量模式的 `remaining=null` 表示该能力按实际用量结算，不表示免费、无限或额度耗尽。两种活动计费模式均必须具有服务端 Entitlement，Runtime Token 仍只签发已授权 Capability；客户端不得把计费模式当作授权本身。

套餐模式和按量模式不会自动互相切换。当前免费 Beta 只启用套餐模式；按量模式的价格、币种、余额或授信、结算、订单和退款在 Phase 5 冻结并实现前不得向用户开放。

P2-W03 对尚未实现和发布的 Entitlement/Usage 响应进行首次交付前模型校正，固定样例覆盖三种状态；这不改变已经发布的账号、设备、OAuth 或 Runtime Token 字段。

## 9. 服务端时间

控制面每个 HTTP 响应由 Web 容器写入标准 HTTP `Date` Header，使用 UTC。客户端只使用该 Header 估算时钟偏差，不依赖业务 JSON 中的 `serverTime` 字段，也不得因缺少该 Header 延长 Token、撤销或配额有效期。
