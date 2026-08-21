# Runtime Token 与撤销规则

## 1. JWT 签名

- v1 固定使用 `RS256`，JWT Header 必须包含 `alg=RS256`、`typ=JWT` 和非空 `kid`。
- 控制面持有私钥并签发 Runtime Token；FastAPI 数据面只通过 HTTPS JWKS 获取公钥。
- 数据面必须校验签名、`iss`、`aud`、`iat`、`exp`、`jti`、`sid`、`device_id`、能力范围和 Entitlement 版本。
- 拒绝 `alg=none`、对称算法、缺少 `kid`、未知 `kid` 和算法降级。
- Issuer 固定为 `https://account.petdock.site`，JWKS URL 固定为 `https://account.petdock.site/.well-known/jwks.json`。

## 2. 生命周期

- Runtime Token 固定有效 15 分钟。
- Main 在剩余有效期不足 3 分钟时提前刷新。
- Python Runtime 只在内存保存 Runtime Token，不持久化、不回读给 Renderer。
- 桌面 Refresh Token 只由 Electron Main 持有，Python Runtime 不得直接调用 OAuth Token Endpoint。
- 桌面 Refresh Token 绝对有效期为 30 天，每次使用都轮换；检测到旧 Token 复用时撤销当前设备的整个 Token Family。

## 3. 撤销

- 身份层主动撤销使用 RFC 7009 `POST /oauth2/revoke`；控制面设备撤销和官网退出操作复用同一撤销事实源，具体请求字段见 `IDENTITY_AND_SESSION.md`。
- 设备撤销、账号封禁和 Runtime Session 撤销写入控制面共享撤销存储。
- 数据面按 `sid`、`jti` 和 `device_id` 检查 Redis 撤销投影；数据面本地正向或负向查询缓存均不得超过 30 秒，Redis 投影键必须存活到对应撤销事实过期。
- 撤销存储不可用时 Managed 请求失败关闭，不得仅凭 JWT 签名放行。
- 撤销对新请求最多 30 秒生效。
- 已开始的流式请求第一版允许执行至结束，但单次数据面调用总时长不得超过 5 分钟。

## 4. 密钥轮换

- 发布新签名密钥前先把新公钥加入 JWKS，再使用新 `kid` 签发 Token。
- 旧公钥至少保留到全部旧 Token 过期并经过最大时钟偏差窗口。
- JWKS 响应必须支持缓存，但数据面遇到未知 `kid` 时只允许立即刷新一次。
- 刷新后仍未知的 `kid` 直接拒绝，不回退到其他密钥。
- 私钥不得进入官网前端、Electron、Python Runtime、日志或代码仓库。

## 5. 时钟偏差

- v1 允许的最大时钟偏差固定为 60 秒。
- 时钟偏差只用于 `iat`、`exp` 验证，不延长撤销缓存和业务配额窗口。
- Main 应使用控制面响应时间辅助识别明显的本机时钟错误，并向用户返回稳定提示。
