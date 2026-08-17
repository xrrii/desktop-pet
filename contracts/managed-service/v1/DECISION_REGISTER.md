# Managed Service Phase 0 决策登记

本文档记录 Phase 0 中不能仅由代码推导的产品、身份、部署和数据治理决定。以下决定已由项目负责人于 2026-08-13 确认；后续变更必须先完成架构评审，再修改权威契约和实现。

## 1. 基础架构与安全决定

| 编号 | 决定 | 状态 |
| --- | --- | --- |
| `D-P0-01` | 官网前端、桌面端和云端服务使用独立仓库与独立部署 | `Frozen` |
| `D-P0-02` | 桌面登录使用系统浏览器 Authorization Code + PKCE S256 + `127.0.0.1` 随机端口回调 | `Frozen` |
| `D-P0-03` | 官网 Web Session、桌面 Refresh Token、官方 Runtime Token 和本地 Runtime Token 分属不同信任域 | `Frozen` |
| `D-P0-04` | Runtime Token 使用 RS256、15 分钟 TTL、3 分钟提前刷新、60 秒最大时钟偏差 | `Frozen` |
| `D-P0-05` | 撤销存储最多缓存 30 秒；不可用时 Managed 失败关闭 | `Frozen` |
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

- 正式主域名为 `petdock.site`，已完成购买；DNS 解析和证书签发是公网灰度前置条件。
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
- 第一批只开放 Managed Chat，其他 Managed 能力保持关闭。
- 输入 Token 和输出 Token 分别计量，用户界面只展示统一 Managed 额度，不暴露 Provider 成本和单价。
- 免费额度按自然月重置，不结转；具体额度数值通过服务端套餐配置维护，不写入跨端契约。
- 额度用尽后 Managed 停止，不自动回退到 BYOK；用户可以手动切换能力来源。
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
- 官网前端、入口网关、Spring Boot 控制面、FastAPI AI 数据面、数据库、撤销存储和基础监控部署在同一主机，但保持独立进程或容器、独立配置和清晰端口边界。
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
- 重复撤销必须幂等，不向客户端泄露 Token 是否曾经存在。Redis 只做不超过 30 秒的可重建缓存，PostgreSQL 记录最终事实。

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
- 备份目标必须位于中国大陆境内的主机外存储；备案完成前只进行内部/隧道验收，不开放普通用户公网登录流量。

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

### `D-P2-13` OAuth Consent 与官网设备授权

状态：`Frozen`

- 当前 `authorization_consent_enabled` 继续关闭，不新增自定义 Consent API。
- P2-W02 复用 Spring Authorization Server 标准 `/oauth2/authorize` 与官网登录 Session；交互式设备授权确认必须在单独开启 Consent 前再次评审。
- 官网 Web Session 与桌面 Access/Refresh Token 完全隔离；P2-W01~W04 完成后再实施 Desktop `P2-11` 管理入口。

### `D-P2-14` 官网注册用户的 OIDC subject

状态：`Frozen`

- 官网注册新用户时，由控制面生成独立于用户表主键、username 和邮箱的不可变 subject，格式固定为 `usr_<UUID v4>`。
- subject 只在服务端创建用户时生成一次并持久化到 `users.subject`；Web 请求和 Web 账号响应不得接收或返回该字段。
- OIDC ID Token 和 UserInfo 继续使用 `users.subject` 作为 `sub`，不得改用 username、邮箱或 `users.id`，避免账号字段变化和内部主键暴露影响 OIDC 身份稳定性。
- `users.subject` 现有唯一约束是最终冲突防线；生成发生极低概率冲突时必须重新生成，不得回退为可预测标识。
