# Managed Service Phase 0 决策登记

本文档记录 Phase 0 中不能仅由代码推导的产品、身份、部署和数据治理决定。以下决定已由项目负责人于 2026-08-13 确认；后续变更必须先完成架构评审，再修改权威契约和实现。

## 1. 基础架构与安全决定

| 编号 | 决定 | 状态 |
| --- | --- | --- |
| `D-P0-01` | 官网前端、桌面端和云端服务使用独立仓库与独立部署 | `Frozen` |
| `D-P0-02` | 桌面登录使用系统浏览器 Authorization Code + PKCE S256 + `127.0.0.1` 随机端口回调 | `Frozen` |
| `D-P0-03` | 官网 Web Session、桌面 Refresh Token、官方 Runtime Token 和本地 Runtime Token 分属不同信任域 | `Frozen` |
| `D-P0-04` | Runtime Token 使用 RS256、15 分钟 TTL、3 分钟提前刷新、60 秒最大时钟偏差 | `Frozen` |
| `D-P0-05` | 数据面本地撤销查询最多缓存 30 秒；Redis 投影存活到事实过期；不可用时 Managed 失败关闭 | `Frozen` |
| `D-P0-06` | Managed 不自动回退到 BYOK，第一版只允许用户手动切换 | `Frozen` |
| `D-P0-07` | Managed Web Search 只返回候选，网页正文由 Electron Main 安全抓取 | `Frozen` |
| `D-P0-08` | 云端初期只提供 AI 能力数据面，不复制本地 Agent | `Frozen` |

## 2. 产品与基础设施决定

### `D-P0-09` 身份服务

状态：`Frozen`

- 自建符合 OIDC/OAuth2 标准的身份服务，并作为 Spring Boot 控制面中的独立模块维护。
- 自建不等于手写协议或密码学；实现必须基于成熟、持续维护的 OAuth2/OIDC 框架，并通过协议、安全和密钥轮换测试。
- OAuth Issuer 使用 `https://account.petdock.site`，JWKS 使用 `https://account.petdock.site/.well-known/jwks.json`。
- 桌面 Public Client ID 固定为 `petdock-desktop`，不配置 `client_secret`。
- 桌面 Refresh Token 绝对有效期为 30 天；每次使用都执行轮换。
- 已轮换 Refresh Token 再次出现时，视为复用攻击并撤销当前设备对应的整个 Token Family。
- 官网普通退出只结束 Web Session，不影响已授权桌面设备。
- 官网提供单设备撤销和全部设备退出操作，显式撤销对应桌面会话。

### `D-P0-10` 域名与证书

状态：`Frozen`

- 正式主域名为 `petdock.site`；域名购买、ICP 备案、DNS 解析和覆盖正式主机的证书条件已于 2026-08-19 具备，普通用户流量仍须在入口网关和受限线上门禁通过后开放。
- 官网入口使用 `https://petdock.site`。
- OAuth Issuer 和账号入口使用 `https://account.petdock.site`。
- Spring Boot 控制面使用 `https://api.petdock.site`。
- FastAPI AI 数据面使用 `https://ai.petdock.site`。
- 所有公网入口只允许 HTTPS，由单机入口网关或反向代理统一申请、续期并终止 TLS。
- 服务进程不直接暴露公网端口；同机内部调用使用回环地址或受控容器网络。

如未来更换 `petdock.site`，必须先整体修改权威契约、OAuth 配置和桌面快照，不能仅在部署环境中静默替换。

### `D-P0-11` 部署区域与数据驻留

状态：`Frozen`

- 首批目标用户位于中国大陆，首个正式部署区域也位于中国大陆。
- Prompt、回答、图片、附件、Embedding Chunk、Rerank 查询与候选、搜索词、运行日志、用量事件和备份均不得跨境传输或处理。
- 上游 Provider 必须提供中国大陆境内处理路径，并满足本契约的数据保留要求。
- 日志、监控、对象存储、消息通知等外围服务只要接触 Managed 用户数据，也必须使用中国大陆境内资源。
- 第一版不进行跨境、跨区域或跨 Provider 自动故障切换；不满足驻留条件时对应 Managed 请求失败关闭。

### `D-P0-12` 数据保留

状态：`Frozen`

| 数据 | 冻结值 | 说明 |
| --- | --- | --- |
| Prompt、回答、图片、附件和知识片段正文 | 不持久化 | 只在完成请求所需的内存窗口处理 |
| 搜索关键词正文 | 不进入常规日志 | 用量仅记录次数 |
| 脱敏运行日志与指标 | 30 天 | 用于故障排查和容量分析 |
| 安全审计日志 | 180 天 | 不包含正文和凭据 |
| 原始 Usage Event | 账期结束后 24 个月 | 用于对账和争议处理 |
| 聚合账单与交易记录 | 按中国大陆适用要求 | 具体期限由法务和财务配置，不在代码中写死 |

调试正文采样默认关闭。任何例外必须单独评审、显式开启、限制白名单和期限，并与默认生产日志隔离。

### `D-P0-13` 首批套餐与授权

状态：`Frozen`

- 第一阶段只提供白名单 `Beta` 套餐，价格为 0，不接入充值和退款闭环。
- 正式收费阶段同时支持套餐订阅和按量计费；用户可以不订阅套餐，显式选择按量计费。两种模式是并列选择，套餐额度耗尽后不得未经用户确认自动切换到按量扣费。
- 当前免费 Beta 只启用套餐订阅模式。按量计费的价格、币种、计费精度、余额或授信、结算、退款和欠费处理必须在 Phase 5 另行冻结并通过支付合规评审后才能启用。
- 第一批只开放 Managed Chat，其他 Managed 能力保持关闭。
- 输入 Token 和输出 Token 分别计量，用户界面只展示统一 Managed 用量或额度，不暴露 Provider 成本和内部单价；正式按量计费面向用户的 PetDock 价格必须在 Phase 5 单独冻结并明确展示。
- 免费额度按自然月重置，不结转；具体额度数值通过服务端套餐配置维护，不写入跨端契约。
- 订阅套餐额度用尽后 Managed 停止，不自动切换为按量扣费，也不自动回退到 BYOK；用户可以手动切换能力来源。
- Phase 3 只验证幂等预占、结算、释放和 Usage Event，不把 Beta 账本作为正式收费账本。

### `D-P0-14` 首个 Provider 与逻辑模型

状态：`Frozen`

- Phase 3 只接入一个 Chat Provider 和一个逻辑模型档位 `chat-standard`。
- 实际 Provider、模型、上游地址、凭据、超时、上下文和单请求预算由项目负责人通过服务端安全配置固定。
- 实际 Provider 和模型值不进入公开契约、桌面配置或客户端响应；客户端只能提交逻辑档位。
- 第一版不自动跨 Provider 切换。Provider 不可用时返回稳定错误，不把请求发送到未明确配置的备用 Provider。
- Provider 配置必须满足中国大陆数据驻留和不跨境处理要求。
- Embedding、Vision、Rerank 和 Search 的 Provider 在 Phase 4 分别评审，不默认复用 Chat Provider。

### `D-P0-15` 客户端支持周期

状态：`Frozen`

- 首个支持 Managed 的桌面版本为 `0.2.0`。
- 服务端至少支持当前和上一个受支持的 Managed 桌面小版本，每个已发布 Managed 小版本的兼容窗口不少于 6 个月。
- 首个 Managed 版本发布时只存在 `0.2.x` 支持线；后续发布新小版本后才开始双版本兼容。
- 常规升级先提示，不立即阻断；仅安全漏洞、协议不兼容或重大服务事故允许强制升级。
- 最低版本和 Managed 能力紧急开关由服务端配置，不要求紧急发布桌面安装包。
- 不支持的客户端返回 `unsupported_client_version`，并提供最低版本和下载入口，不得伪装成认证失败。
- 关闭 Managed 能力不得影响本地 BYOK。

### `D-P0-16` 单机部署与可用性

状态：`Frozen`

- 当前预算只使用一台位于中国大陆的云服务器。
- 官网前端、入口网关、Spring Boot 控制面、FastAPI AI 数据面、数据库、撤销存储和基础监控部署在同一主机，但全部运行在独立 Docker 容器中，使用独立配置、健康检查和清晰端口边界；宿主机只运行 Docker Engine、Compose Plugin 和 SSH 管理服务。
- 第一版不建设应用集群、数据库集群、跨可用区副本、冷备服务器、跨区域容灾或自动故障转移。
- 明确接受单点故障：主机维护或故障时，官网和 Managed 能力可以同时不可用；本地 BYOK 必须保持可用。
- Beta 不承诺高可用 SLA。服务必须具备健康检查、资源上限、磁盘容量告警、进程自动拉起和可控维护窗口。
- 备份不等同于高可用。账号、设备、套餐、用量和审计数据仍必须定期加密备份到中国大陆境内的主机外存储，并在正式充值前完成一次手工恢复演练。
- 单机容量接近阈值、用户规模扩大或正式 SLA 发生变化时，必须重新评审部署拓扑；扩容不能改变客户端契约和信任边界。

## 3. 后续变更要求

1. 先在 `petdock-cloud` 完成架构评审并修改本文件。
2. 更新 OpenAPI、OAuth、数据边界、兼容或部署文档中的对应值。
3. 运行 `python -m pytest`。
4. 整体同步桌面消费快照，再在 `desktop-pet` 运行 `npm.cmd run test:contracts` 和 `npm.cmd run check`。

涉及法律、支付和数据跨境的决定必须经过对应专业评审；本登记表只记录工程执行口径，不代替法律意见。

## 4. Phase 2 身份与共享开发决定

以下决定冻结 `P2-00` 的契约缺口。它们只补充实现口径，不改变 Phase 0 已发布的公网域名、信任边界和 Token 生命周期。

### `D-P2-01` OIDC Discovery、UserInfo 与 Token Response

状态：`Frozen`

- Issuer 固定为 `https://account.petdock.site`；Discovery 使用 `/.well-known/openid-configuration`，JWKS 使用 `/.well-known/jwks.json`。
- Discovery 至少公布 `issuer`、`authorization_endpoint`、`token_endpoint`、`revocation_endpoint`、`userinfo_endpoint`、`jwks_uri`、`response_types_supported`、`grant_types_supported`、`scopes_supported`、`token_endpoint_auth_methods_supported` 和 `code_challenge_methods_supported`。
- 桌面端请求 `openid desktop.session`，可选 `profile email`；只允许 `code`、`authorization_code` 和 `refresh_token` 流程，客户端认证方式为 `none`，PKCE 仅允许 `S256`。
- UserInfo 最小字段为 `sub`、`email`、`email_verified`、`preferred_username` 和 `name`。不在 v1 UserInfo 中返回手机号、头像、地址、Provider 信息或用量正文。
- 标准 Token Response 使用 RFC 6749 与 OIDC Core 字段：`access_token`、`token_type`、`expires_in`、`refresh_token`、`scope`，登录授权时附带 `id_token`。不得添加 Provider 凭据或未评审的长期凭据字段。

### `D-P2-02` 账号快照来源

状态：`Frozen`

- 桌面端账号脱敏快照以 OIDC UserInfo 为唯一身份资料来源；控制面不新增同义账号资料接口。
- 控制面业务接口只返回设备、Entitlement、Runtime Session 和用量摘要等业务数据。账号展示字段由 Main 在 UserInfo 响应中提取后再脱敏传给 Renderer。
- UserInfo 请求只由 Electron Main 携带桌面 Access Token 发起，Renderer 和 Python Runtime 不得直接访问。

### `D-P2-03` Refresh Token 主动撤销

状态：`Frozen`

- 身份服务提供 RFC 7009 `POST /oauth2/revoke`，请求字段为 `token` 和可选 `token_type_hint`，Public Client 额外提交 `client_id`；成功统一返回 HTTP 200 且不返回 Token 内容。
- 官网单设备撤销、全部设备退出和设备删除最终调用同一撤销服务；撤销设备时同时撤销该设备的 Refresh Token Family、Access Token 关联会话和 Runtime Session。
- 重复撤销必须幂等，不向客户端泄露 Token 是否曾经存在。Redis 是可重建投影，键存活到对应 PostgreSQL 撤销事实过期；数据面本地正向或负向查询缓存不超过 30 秒，PostgreSQL 记录最终事实。

### `D-P2-04` `managed_login_enabled` 下发

状态：`Frozen`

- 控制面提供登录前可访问的 `GET /api/v1/features`，返回 `version`、`managed_login_enabled` 和 `minimum_client_version`；该端点不要求桌面 OAuth 认证，以避免读取登录开关本身形成循环依赖。
- 服务端默认关闭 `managed_login_enabled`；只有服务端配置明确开启且客户端版本满足最低版本时，桌面端才展示官方登录入口。
- 桌面端本地默认值固定为 `false`。服务不可用、响应字段缺失或版本不兼容时必须按 `false` 处理，不影响 BYOK。

### `D-P2-05` 开发端点覆盖

状态：`Frozen`

- `local-mock` 和 `shared-dev` 允许通过未提交的环境变量覆盖 Issuer、控制面和数据面地址；覆盖值只能指向回环地址、服务器内网地址或 SSH 隧道端口。
- `staging` 与 `production` 构建固定官方端点，启动时拒绝任何覆盖；生产 Issuer 必须为 `https://account.petdock.site`，控制面和数据面分别为 `https://api.petdock.site` 与 `https://ai.petdock.site`。桌面 Public Client 允许 `127.0.0.1` 上 `/oauth/callback` 的运行时随机端口，其他主机、路径、协议、查询参数和片段均拒绝。
- 端点覆盖不进入 Renderer、契约样例、日志或错误消息；构建校验必须阻止生产包携带静态开发服务端点，但不得误报运行时生成的 OAuth loopback 回调。

### `D-P2-06` 设备显示名与重复注册

状态：`Frozen`

- 客户端首次注册必须提交 `displayName`；服务端去除首尾空白、折叠连续空白并拒绝控制字符，长度按契约限制为 1 至 100 个 Unicode 字符。
- 客户端未能提供可用名称时使用固定本地化默认名 `Windows Desktop`，服务端不读取硬件序列号、用户名或文件路径生成名称。
- 同一用户重复提交同一 `deviceId` 时执行幂等更新并刷新 `lastSeenAt`；若设备 ID 已属于其他用户，返回稳定的冲突错误，不转移设备所有权。
- 设备显示名只用于设备列表展示，不参与授权、Token 签名或设备身份判断。

### `D-P2-07` 服务端时间

状态：`Frozen`

- 控制面所有 HTTP 响应使用标准 HTTP `Date` Header 表示服务端 UTC 时间，不新增业务 `serverTime` 字段。
- 客户端只使用 `Date` Header 估算本机时钟偏差；时间头缺失时不得延长 Token、撤销或配额窗口。
- 数据库、JWT、审计时间和内部调度统一使用 UTC；Ubuntu 主机展示时区可为 `Asia/Shanghai`。

### `D-P2-08` 共享开发数据与环境隔离

状态：`Frozen`

- `shared-dev` 使用 PostgreSQL 17 数据库 `petdock_shared_dev` 和 Redis 8.0 逻辑库 0；容器端口只绑定服务器回环地址，本地开发通过 SSH 隧道接入。
- Spring Boot 通过 Flyway 管理 Schema；PostgreSQL 是用户、设备、授权、Entitlement、Runtime Session、撤销和审计的事实来源，Redis 只保存 Session、限流和可重建撤销缓存。
- `local-mock` 默认使用本机或测试容器，`shared-dev`、`staging`、`production` 使用独立数据库、Redis 命名空间、凭据、卷和备份目标，禁止跨环境复用数据。
- 正式环境数据库 URL、用户名、密码、Redis URL、签名密钥和主机外加密备份目标只通过受控环境变量或密钥管理系统注入；仓库只提供无敏感值的 `.env.example`。
- 备份目标必须位于中国大陆境内的主机外存储；日常开发继续只使用本地或 `shared-dev`，正式域名先通过来源 IP 白名单完成线上验收，验收通过前不开放普通用户公网登录流量。

### `D-P2-09` 当前设备与 OAuth 授权绑定

状态：`Frozen`

- 当前设备由服务端 OAuth 授权记录绑定关系解析，不新增客户端设备 Header，也不允许客户端覆盖当前设备身份。
- 首次成功注册设备时，一个尚未绑定的 OAuth 授权只能绑定一个 `deviceId`；已绑定授权不能改绑其他设备。
- Refresh Token 轮换保持同一个 Token Family 和设备绑定；授权尚未绑定设备时，当前设备查询返回 `device_not_found`。

## 5. Phase 2 官网 Web 契约决定

### `D-P2-10` 官网 Web API 与接口边界

状态：`Frozen`

- 官网 Web API 由 Spring Boot 控制面提供，正式入口为 `https://api.petdock.site`，业务路径统一使用 `/api/v1/web/*`。
- 官网前端正式 Origin 只允许精确的 `https://petdock.site`；生产 CORS 不使用通配符，开发 Origin 只通过未提交环境配置受控增加。
- 官网 Web API 与桌面 `control-plane.yaml` 分离定义；官网不得复用桌面 Bearer API，也不得调用 FastAPI AI 数据面。
- 本轮只冻结 Session、注册、登录、退出、资料读取/显示名更新和密码修改；套餐、充值、订单、设备、Entitlement、Usage 和支付回调不在本轮接口范围内。

### `D-P2-11` 官网 Session 与 CSRF

状态：`Frozen`

- Session Cookie 固定为 `__Host-petdock_web_session`，必须使用 `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`，且不得设置 `Domain`。
- `GET /api/v1/web/session` 登录前可访问；缺少 Cookie 时创建匿名 Session，并返回绑定当前 Session 的随机 `csrfToken`。
- 所有注册、登录、退出、资料写入和密码写入请求必须携带 `X-PetDock-CSRF`；CSRF Token 不得放入 Cookie、LocalStorage、URL、日志或错误消息。
- Web Session 只保存可丢失的登录态，Redis 不作为用户或撤销事实来源；官网普通退出不影响桌面设备、Refresh Token Family 或 Runtime Session。
- 服务端使用 Spring Session 默认空闲过期口径，响应返回 `expiresAt`；会话和资料响应必须使用 `Cache-Control: no-store`。

### `D-P2-12` 官网账号字段与密码凭据

状态：`Frozen`

- 登录标识使用独立 `username`，长度 3 至 32，只允许 ASCII 字母、数字、`.`、`_`、`-`，首尾必须是字母或数字；服务端按小写形式判断唯一性。
- 注册和修改密码要求 10 至 128 个字符，不强制字符类型组合；密码哈希算法与成本由服务端成熟框架和安全配置决定。
- `users.password_hash` 允许为空；没有密码凭据的历史或外部身份用户不能使用 username/密码登录，绑定密码的流程延后。
- 注册必须提交 `displayName`；资料接口本轮只允许更新显示名。邮箱绑定、验证、修改、忘记密码、MFA 和账号删除延后。
- 登录失败统一返回 `invalid_credentials`，不得通过响应区分用户名不存在、密码错误、账号暂停或密码凭据不可用。

### `D-P2-13` OAuth Consent 与官网桌面授权

状态：`Frozen`

- P2-W02 将桌面 Public Client 的 `authorization_consent_enabled` 固定为 `true`，对应 Spring Authorization Server `requireAuthorizationConsent=true`；继续使用标准 `/oauth2/authorize` 和现有 JDBC Consent 持久化，不新增 JSON Consent API 或自定义 Token 协议。
- OAuth 浏览器交互固定使用 `/oauth/login`、`/oauth/register`、`/oauth/resume` 和 `/oauth/consent`；登录或注册后只能由服务端 SavedRequest 恢复本机 `/oauth2/authorize`，不得接受任意 `returnTo` 或外部跳转地址。
- `account.petdock.site` 使用独立 Host-only `__Host-petdock_web_session`，不共享 `api.petdock.site` 的同名 Cookie，也不降低 `__Host-` 属性或建立父域 Cookie；两者复用同一用户目录、账号应用服务、Spring Session 机制和 Redis，但 Session 实例与退出行为相互隔离。首次桌面授权可能需要在账号主机重新登录。
- 页面确认的是固定 `PetDock Desktop` Client 及本次请求的已登记权限，不展示或采集尚未建立的具体设备信息；设备事实只在授权码交换后按现有设备注册契约建立。
- 当前官方权限采用整体同意或整体拒绝，不提供逐项勾选；首次授权或权限扩大时展示 Consent，相同用户、Client 和权限集合的重复授权可复用持久化 Consent 跳过页面。
- 拒绝授权通过标准 `error=access_denied` 和原始 `state` 返回已校验 loopback；官网与账号主机 Session 均与桌面 Access/Refresh Token 完全隔离。P2-W01~W04 完成后再实施 Desktop `P2-11` 管理入口。

### `D-P2-14` 官网注册用户的 OIDC subject

状态：`Frozen`

- 官网注册新用户时，由控制面生成独立于用户表主键、username 和邮箱的不可变 subject，格式固定为 `usr_<UUID v4>`。
- subject 只在服务端创建用户时生成一次并持久化到 `users.subject`；Web 请求和 Web 账号响应不得接收或返回该字段。
- OIDC ID Token 和 UserInfo 继续使用 `users.subject` 作为 `sub`，不得改用 username、邮箱或 `users.id`，避免账号字段变化和内部主键暴露影响 OIDC 身份稳定性。
- `users.subject` 现有唯一约束是最终冲突防线；生成发生极低概率冲突时必须重新生成，不得回退为可预测标识。

### `D-P2-15` P2-W03 业务中心、设备管理与计费模式快照

状态：`Frozen`

- 官网业务中心使用现有 Web Session，新增当前服务方案、活动设备列表、单设备撤销和全部设备撤销接口；官网仍不得复用桌面 Bearer API 或调用 AI 数据面。
- 设备列表只返回当前用户的活动设备及脱敏字段，不返回已撤销历史、主机名、硬件序列号、IP、Token Family、Runtime Session 或 OAuth 授权标识。官网无法识别正在访问页面的桌面设备，因此不得展示或接受“当前设备”标记。
- 单设备和全部设备撤销都必须显式确认并携带 Session 绑定的 CSRF Header；撤销联动失效 OAuth Access/Refresh Token、Token Family 和 Runtime Session，但不退出当前官网 Session。
- 服务访问快照固定区分 `inactive`、`subscription` 和 `pay_as_you_go`：未开通时没有计费模式；套餐模式必须有套餐标识、有效期和数值剩余额度；按量模式不关联套餐或套餐有效期，`plan=null`、`expiresAt=null`、`remaining=null` 表示按实际用量计费，不表示免费、无限或额度耗尽。
- Entitlement 继续决定能力是否可用，计费模式只决定授权用量如何结算。按量用户仍必须具有服务端授权，不能因为没有套餐而绕过 Capability、版本、设备或 Runtime Token 校验。
- 当前免费 Beta 只产生套餐模式快照；按量模式先冻结协议，不在 P2-W03 开放选择、充值或扣费。正式启用前必须完成 Phase 5 的价格展示、用户确认、支付/结算和账单能力。
- P2-W03 只为充值、订单和用量保留稳定页面路由及准确未开放状态，不新增虚构余额、订单或 Usage 数据。真实 Usage API 属于 Phase 3，正式支付和交易闭环属于 Phase 5。

## 6. Phase 3 Managed Chat MVP 决定

### `D-P3-01` Chat 调用拓扑与开放范围

状态：`Frozen`

- Phase 3 只开放 `chat-standard`，Desktop Python Runtime 使用 Main 注入的短期 Runtime Token 直接调用 FastAPI 数据面；Spring Boot 不代理 SSE，也不进入流式 Token 热路径。
- Agent、Memory、RAG、附件、Skill 和工具执行继续位于用户设备；数据面只转发模型可见工具 Schema 并返回结构化 ToolCall，不执行任何工具。
- `ai-data-plane.yaml` 中 Embedding、Vision、Rerank 和 Web Search 仅保留为 Phase 4 草案。Phase 3 公网 Nginx 只允许 Chat、Capabilities 和 Health 三个精确操作，其他路径保持 `404`。
- Web 只调用 Spring Boot Web API，不持有 Runtime Token、不消费 Chat SSE，也不调用 FastAPI 数据面。

### `D-P3-02` Managed Chat 独立开关

状态：`Frozen`

- `GET /api/v1/features` 增加可选 `managed_chat_enabled`；`managed_login_enabled=true` 不代表 Chat 可用。
- 旧客户端忽略新增字段；新客户端遇到字段缺失、类型错误、请求失败或版本不兼容时一律按 `managed_chat_enabled=false` 处理。
- 首次部署默认关闭。关闭 Chat 只阻止新的 Managed Chat 请求，不清除登录状态、本地会话或 BYOK 配置，也不自动切换或消耗用户 BYOK Key。

### `D-P3-03` 链路标识、请求指纹与重试

状态：`Frozen`

- `trace_id` 标识一次本地用户任务，`request_id` 标识一次逻辑模型调用，`attempt_id` 标识一次 HTTP/Provider 尝试，`usage_event_id` 标识一条追加写 Usage Event。
- 数据面对完整 Chat 请求体执行 RFC 8785 JSON Canonicalization Scheme，再计算 SHA-256 小写十六进制摘要作为 `requestFingerprint`；只保存摘要，不保存用于计算摘要的正文。
- 同一 Runtime Session、同一 `request_id` 和同一请求指纹仅在现有状态仍为 `reserved` 时返回原预占并标记重放；若已进入任一终态则返回 `usage_state_conflict`。任一身份、Session、逻辑模型或指纹不一致时返回 `idempotency_conflict`；两种冲突都不得调用 Provider。
- 仅流前 `token_expired` 允许保留 `request_id`、更换 `attempt_id` 后重试一次。已输出 `delta` 或 `tool_call` 后禁止静默重放；其他 Provider、限流、超时或断流错误在 Phase 3 不自动重试。

### `D-P3-04` Beta 配额预占与终态

状态：`Frozen`

- FastAPI 完成请求、Runtime Token 和撤销校验后，必须在调用 Provider 前通过容器内网内部接口请求 Spring Boot 原子预占；内部接口使用独立服务身份且不得暴露到公网 Nginx。
- 状态只允许 `不存在 -> reserved -> settled|released|failed`。`settled` 使用可靠实际用量，`released` 仅用于能够证明 Provider 未被调用，`failed` 表示 Provider 已调用但实际用量未知。
- `settled`、`released`、`failed` 是互斥终态；只有 `attempt_id`、实际用量或原因均与既有终态一致时才幂等成功，任何字段不同或提交其他终态都返回 `usage_state_conflict` 并产生脱敏告警。
- Beta 阶段 `failed` 保守保留原预占额度；自动补偿、超时回收、正式金额账本和人工修复流程属于 Phase 5。

### `D-P3-05` Chat SSE 顺序与终止语义

状态：`Frozen`

- 流前失败使用 HTTP `ErrorEnvelope`；HTTP 200 建流后所有业务结果只通过 `chat-stream-event.schema.json` 返回。
- `sequence` 从 1 开始严格递增且不允许跳号；每个事件的 `traceId`、`requestId` 必须与请求 Header 一致；`usage` 最多一次且只能位于终止事件之前。
- 每条流必须且只能以一个 `completed` 或 `error` 结束，终止后不得再发送事件。客户端断开必须取消上游任务，并根据 Provider 是否被调用及用量是否可靠进入正确用量终态。
- `completed.finishReason` 只允许 `stop`、`tool_calls`、`cancelled`；未知关键事件、身份不一致、序号异常、重复终止或终止后事件均映射为 `stream_protocol_error` 并失败关闭。

### `D-P3-06` Usage Summary 与数据边界

状态：`Frozen`

- Spring Boot/PostgreSQL 是 Entitlement、配额、Usage Event 和摘要的事实源；预占及 `reserved` 事件同事务写入，终态及对应事件同事务写入，摘要只读取已提交事实。
- Desktop 继续使用 `/api/v1/usage/summary`；Web 使用 `/api/v1/web/usage/summary` 和既有 HttpOnly Session，只展示当前周期、Chat 已用、剩余及 `tokens` 单位。未开通时返回稳定错误，不展示全零假数据。
- Prompt、回答、工具参数、工具结果、附件正文、知识片段、完整请求体和完整上游响应不得进入数据库、Usage Event、默认日志或测试快照。
- `requestFingerprint` 只保存在受控预占事实中，不进入常规日志、指标标签或客户端响应。日志允许记录链路 ID、逻辑能力、配置别名、耗时、Token 数、用量终态和稳定错误码；禁止记录认证凭据、用户正文、真实 Provider 凭据和内部模型配置值。

### `D-P3-07` Phase 3 Chat Provider 受控选型

状态：`Partially Frozen`

- Provider 适配协议使用 OpenAI-compatible；生产模式固定使用 `openai_compatible`，不得使用仓库内假 Provider。
- 模型名固定为 `deepseek-v4-flash-vision-exp`；上游必须同时支持 SSE、Tool Calling 和可靠 Usage 返回，缺少 Usage 或工具参数无法闭合时按无效响应失败。
- 服务商及实际接口必须满足中国大陆数据驻留要求；当前非敏感配置使用 `https://api.deepseek.com` 作为不含查询参数或片段的 HTTPS API 根地址，但该公开域名本身不构成区域合规证明，生产启用前仍须取得服务商说明并通过白名单联调。
- API Key 只允许通过服务器 Docker Secret 文件注入 AI Gateway，不得进入 `.env`、镜像层、日志、契约、测试快照或客户端。
