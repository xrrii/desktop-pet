# Managed Service v1 安全与数据边界

## 1. 凭据所有权

| 凭据 | 持有者 | 持久化 | 禁止暴露给 |
| --- | --- | --- | --- |
| 官网 API Web Session | 系统浏览器、控制面 | `api.petdock.site` Host-only `__Host-petdock_web_session`，Session 状态可在 Redis | 账号主机、Electron、Python Runtime |
| OAuth 账号主机 Session | 系统浏览器、控制面 | `account.petdock.site` Host-only `__Host-petdock_web_session`，Session 状态可在 Redis | 官网 API 主机、Electron、Python Runtime |
| 桌面 Refresh Token | Electron Main | `safeStorage` | Renderer、Python Runtime、官网前端 |
| 官方 Runtime Token | Electron Main、Python Runtime 内存 | 不持久化 | Renderer、日志、官网前端 |
| 本地 Runtime Token | Electron Main、Python Runtime | 每次启动临时值 | Renderer、云端 |
| BYOK Key | Electron Main | `safeStorage` | Renderer、官网和官方服务 |
| 官方 Provider Key | FastAPI 数据面 | Secret Manager | 所有客户端和官网前端 |

## 2. 能力数据传输

| 能力 | 允许发送到官方数据面 | 默认禁止持久化 |
| --- | --- | --- |
| Chat | 用户消息、系统提示、必要检索片段、工具结果摘要 | Prompt、回答和工具正文 |
| Embedding | 查询或文档 Chunk 文本 | 原始文本和向量输入正文日志 |
| Vision | 用户明确加入会话的图片或派生图片 | 图片、Base64 和视觉 Prompt 正文 |
| Rerank | 查询和候选片段 | 查询及候选正文 |
| Web Search | 搜索关键词和必要搜索选项 | 搜索关键词正文日志 |

官网 Web API 只接受来自 `https://petdock.site` 的受控浏览器请求，使用 API 主机 Host-only HttpOnly Session Cookie 和 `X-PetDock-CSRF` Header。OAuth 页面只从 `https://account.petdock.site` 同源加载，并使用账号主机独立的 Host-only HttpOnly Session Cookie；两个主机不得共享父域 Cookie、Session ID 或登录跳转票据。Cookie、Session ID、CSRF Token、密码、完整 username、授权码、`state`、PKCE 参数和完整 redirect URI 不进入日志。任一 Web Session 都不是桌面 OAuth Token，也不能换取 Runtime Token 或 Provider Key。

Managed Web Search 第一版不接收网页正文读取 URL，也不提供 `/ai/v1/web/fetch`。URL 校验、DNS 固定、SSRF 防护和正文抓取由 Electron Main 执行。

Phase 4 进一步冻结以下边界：Embedding 只接收用户明确加入知识库或会话的 Chunk/查询，并仅在服务器内网进入本地 `bge-base-zh-v1.5` 模型；Vision 只接收单张安全派生图片并校验魔数、解码尺寸和像素预算；Rerank 只接收本地召回且通过准入的候选，不得新增候选或修改正文。四项能力分别使用独立 Feature Flag、Entitlement、配额和 Provider Secret，任一校验失败都必须在 Provider 调用前失败关闭。

全部 Managed 用户数据只允许在中国大陆境内传输和处理。上游 Provider、日志、监控、对象存储和备份只要接触用户数据，也必须使用中国大陆境内资源；第一版不做跨境或跨 Provider 自动故障切换。

## 3. 日志

允许记录：

- `trace_id`、`request_id`、`attempt_id`、`usage_event_id`
- 用户和设备不可逆哈希
- 能力、逻辑模型档位、Provider 标识和客户端版本
- 输入/输出 Token 数、图片数、搜索次数、延迟、状态和稳定错误码
- 配额预占、结算、释放和补偿状态

默认禁止记录：

- `requestFingerprint`；该摘要只允许保存在受控预占事实中，不进入日志、指标标签或客户端响应
- 密钥、Cookie、Authorization Header 和任何 Token
- Prompt、回答、附件、知识库片段、图片和搜索词正文
- 本地真实路径、完整 URL 查询参数和工具正文
- 官网支付凭据和支付渠道原始回调密钥

## 4. 数据保留

- Prompt、回答、图片、附件、知识片段和搜索词正文不持久化，也不进入常规日志。
- 脱敏运行日志和指标保留 30 天。
- 不含正文和凭据的安全审计日志保留 180 天。
- 原始 Usage Event 保留至账期结束后 24 个月。
- 聚合账单、交易记录、用户导出、删除、退款和争议材料按中国大陆适用要求配置，具体期限不在代码中写死。
- 调试正文采样默认关闭；任何例外必须单独评审、显式开启、限制白名单和期限，并与默认生产日志隔离。

服务上线前必须同步更新隐私政策、服务端保留配置和自动化审计测试。本文件记录工程基线，不代替法律意见。

## 5. 官网访问统计

- 只采集首页、分享页和首页两个固定下载按钮，不采集完整 URL、查询参数、来源、账号标识、Cookie、IP、UA 或设备指纹。请求传输中的 UA 只用于基础爬虫过滤，不保存。
- 浏览器随机 UUID 固定 30 天过期，不滑动续期；服务端使用独立 Secret 的 HMAC 摘要。事实表只保存事件 UUID、服务端接收时间、固定事件/页面/入口枚举、可空访客摘要。
- 最近 30 个北京时间自然日作为可查询保留范围，过期事实每小时分批清理；物理删除最多存在正常清理周期的延迟，故障恢复后继续收敛。无身份信息的采集运行窗口仅用于覆盖判断和首次启用时间。
- DNT/GPC 时不发送；存储被拒绝时只计 PV，不人为产生 UV。访客数是可去重浏览器估算，不证明真人，也不用于计费。
- 采集器限流只在内存暂存带进程随机盐的地址摘要，每分钟重置，容量受全局限流约束。代理不记录采集访问日志，不转发 Cookie、Authorization 和 Referer。
- Secret 不可与签名或 Provider 凭据复用；常规重启保留同一文件。紧急轮换会使跨轮换区间 UV 偏高，应记录操作时间，不能声称前后区间可直接比较。
- 首版部署假设为单个控制面实例。多实例启用前需改造全局限流与采集窗口协调。
