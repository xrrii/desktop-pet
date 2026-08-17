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

全部 Managed 用户数据只允许在中国大陆境内传输和处理。上游 Provider、日志、监控、对象存储和备份只要接触用户数据，也必须使用中国大陆境内资源；第一版不做跨境或跨 Provider 自动故障切换。

## 3. 日志

允许记录：

- `trace_id`、`request_id`、`attempt_id`、`usage_event_id`
- 用户和设备不可逆哈希
- 能力、逻辑模型档位、Provider 标识和客户端版本
- 输入/输出 Token 数、图片数、搜索次数、延迟、状态和稳定错误码
- 配额预占、结算、释放和补偿状态

默认禁止记录：

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
