# PetDock 面试问答

> 用途：面试前复习和口头表达。答案以当前 `desktop-pet`、`petdock-cloud`、`petdock-web` 三个仓库的已实现代码为依据。
>
> 建议：不要死记每个文件名，先记住职责边界、请求链路和几个关键取舍。被追问时，优先讲清楚“问题 - 方案 - 为什么 - 风险”。

## 一、项目总览

### 1. PetDock 是什么？你在项目中主要做了什么？

PetDock 是一个 Windows 桌面 AI 助手。桌面上常驻一个可交互的桌宠，双击后打开助手窗口；助手支持流式对话、工具调用、文件和图片附件、知识库检索、长期记忆、Artifact 文件生成以及 Skill 扩展。

项目采用三仓协作：

- `desktop-pet`：Electron 桌面端和本地 Python Assistant Runtime。
- `petdock-cloud`：官方托管服务的 Spring Boot 控制面、FastAPI AI Gateway、Embedding/Rerank Runtime。
- `petdock-web`：官网、账号中心、设备管理、用量展示和管理员能力授权页面。

项目重点解决两个问题：一是让 AI 能力丰富，二是避免 Renderer、模型和系统权限互相穿透。最终采用 Electron Main 作为桌面权限边界，Python Runtime 负责 Agent 编排，云端负责身份、能力授权和托管模型调用。

### 2. 为什么拆成 Electron + Python Runtime，而不是全部写在 Electron 里？

Electron 更适合窗口、托盘、文件选择器和 Windows 系统能力；Python 生态更适合 LangChain、文档解析、向量检索和本地模型。因此把桌面交互和 AI 编排拆开：Electron Main 管权限，Python Runtime 管 Agent、RAG、记忆和 Provider。

这样做的好处是 LangChain 不进入 Renderer，Python 服务可以单独测试，后续也能替换成本地或远程服务。代价是需要维护进程生命周期、协议版本、启动失败和跨语言数据模型，所以项目用 TypeScript/Pydantic 共享协议和契约测试约束两端。

### 3. 项目的总体架构怎么画？

```text
桌宠/助手 Renderer
        |
        | 受限 contextBridge IPC
        v
Electron Preload
        |
        v
Electron Main
  - 窗口、托盘、文件对话框
  - API Key/Token 加密存储
  - 工具风险校验与系统操作
  - Python Runtime 生命周期
        |
        | 127.0.0.1 随机端口 + Bearer 启动令牌
        | HTTP 请求 + SSE 事件
        v
Python Assistant Runtime
  - FastAPI API
  - LangChain Agent
  - Memory / Knowledge / RAG
  - Attachment / Artifact / Skill / Vision
        |
        +--> BYOK Provider
        +--> 官方 Cloud AI Gateway
```

云端再分为控制面和 AI 数据面：控制面管理账号、OAuth、设备、套餐、能力授权、Runtime Session 和用量；AI Gateway 校验 Runtime Token 后调用 Chat、Vision、Web Search 等 Provider，Embedding 和 Rerank 使用独立 Runtime。

## 二、桌面端与进程通信

### 4. 用户发送一条消息后，完整链路是什么？

1. Renderer 收集输入、会话 ID、附件 ID 和可选 Skill ID。
2. Preload 通过 `contextBridge` 暴露的 `askAssistant` 调用 IPC。
3. Electron Main 的 `AssistantManager.ask()` 校验输入、附件、知识库和 Skill。
4. `AssistantRuntimeProcess` 启动或复用 Python Runtime，并读取 readiness 信息。
5. `AssistantRuntimeClient` 调用 Runtime 的 `POST /v1/chat` 创建任务。
6. Python `AssistantService` 为任务建立事件队列和后台协程。
7. `LangChainBackend` 读取历史、附件、知识库和 Skill，调用模型。
8. Runtime 通过 `GET /v1/events/{taskId}` 以 SSE 输出文本增量、工具调用、来源和完成事件。
9. Main 校验事件序号；遇到工具调用时重新执行权限策略。
10. Main 将脱敏后的事件转发给 Renderer，Renderer 更新消息和状态。

一句话概括：Renderer 发起意图，Main 负责边界，Runtime 负责推理，SSE 负责把过程流式传回界面。

### 5. Python Runtime 是怎么启动和鉴权的？

每次 Runtime 启动时，Electron Main 生成随机启动令牌，通过子进程环境变量传入 Python。Python 只监听 `127.0.0.1` 的随机端口，启动后向 stdout 输出一行 readiness JSON，包含协议版本、端口和进程信息；普通日志写 stderr。

除健康检查外，所有接口都要求 `Authorization: Bearer <token>`，Python 使用常量时间比较校验令牌。Renderer 不接触端口和令牌。这样可以避免固定端口被其他本机进程随意调用，也避免把 Runtime 凭据暴露到前端。

### 6. 为什么使用 HTTP + SSE，而不是 Electron IPC 直接传所有数据？

Electron IPC 适合 Renderer 和 Main 的受限调用，但不适合作为 Python Agent 的长期协议。HTTP + SSE 便于 Python 单独测试，流式文本天然适合 SSE，协议可以用 OpenAPI、Pydantic 和固定 JSON 做版本化，未来替换本地 Runtime 或拆分服务的成本也更低。

代价是要处理进程启动、端口发现、令牌鉴权、断开和事件顺序。项目通过 readiness、启动超时、健康检查、事件 `sequence` 和 Runtime 状态机处理这些问题。

### 7. SSE 事件为什么要有 sequence？

Runtime 事件和 Main 产生的事件可能异步到达，没有序号就可能重复显示或乱序更新。Runtime 事件带单调递增序号，Main 记录 `lastRuntimeSequence`，丢弃重复或倒序事件；Main 转发给 Renderer 时再维护自己的 UI 序号。

### 8. Renderer、Preload、Main 各自允许做什么？

Renderer 只负责 UI 和用户交互，不能直接访问 Node、文件系统、API Key、Runtime 端口或系统命令。

Preload 只通过 `contextBridge` 暴露白名单方法，例如发送消息、取消任务、读取脱敏状态和提交权限决定，不能暴露任意 `ipcRenderer`。

Main 是唯一的桌面能力入口，负责文件对话框、打开应用/目录、网络策略、密钥存储、Runtime 管理和最终工具权限判断。窗口配置保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。

## 三、Agent、工具调用与权限

### 9. Agent 的核心循环是怎样的？

任务开始时，Runtime 读取会话历史，绑定附件，生成附件上下文，根据 Skill 权限决定是否检索知识库，整理来源并激活用户选择的 Skill，然后组装 System Prompt、历史消息和上下文，调用模型并流式输出文本。如果产生工具调用，就暂停等待工具结果；结果追加到历史后继续有限轮次推理。

外部工具调用有数量和轮次上限，避免模型在单次请求中无限循环或重复执行操作。

### 10. 为什么 Python Agent 不能直接执行系统命令？

模型输出本质上是不可信输入。如果 Python 直接执行 shell 或任意文件操作，提示注入、路径穿越和误操作风险都会很高。

项目采用“Agent 规划、Main 执行”：Runtime 只能产生固定 schema 的工具调用；Main 对工具名、参数、路径、URL 和风险等级重新校验，再决定拒绝、自动执行或等待用户确认。Renderer 提交的只是任务 ID、工具调用 ID 和用户决定，不能覆盖 Main 保存的原始参数。

### 11. 一个需要确认的工具调用是怎么完成的？

```text
模型产生 tool_call
      ↓
Runtime 通过 SSE 发给 Main
      ↓
Main 重新计算风险和规范化参数
      ↓
safe      -> 直接执行
confirm   -> 发 permission_required，等待用户
dangerous -> 直接拒绝
      ↓
Main 记录审计日志
      ↓
结果 POST /v1/tool-result 回 Runtime
      ↓
Agent 继续推理
```

权限确认有超时机制；任务取消、助手关闭或 Runtime 退出时，未处理的确认会失效。工具调用、用户决定、执行耗时和错误会写入脱敏审计记录。

### 12. 如何防止联网工具 SSRF 或读取内网地址？

联网能力不允许直接请求任意 URL。Main 会检查 URL 协议、域名解析结果、重定向目标、IP 地址范围、响应大小、内容类型、压缩编码和超时。

网页读取原则上只允许本轮搜索结果，或者用户明确提供的 HTTP(S) 地址。搜索结果和网页正文经过清洗后，Renderer 只展示最终被回答引用的脱敏来源，完整正文不会写入普通日志或长期数据库。

### 13. Skill 系统解决什么问题？

Skill 是可安装、可启用的领域能力包，用来补充 Agent 的提示词、参考资料和固定流程。安装时先预览清单，用户选择后再落盘；Runtime 启动时只注册名称和描述，真正激活后才读取正文和资源。

Skill 权限只能收缩能力，例如是否允许读取知识库、记忆或网络；它不能绕过 Electron Main 的最终工具策略，因此既能扩展能力，也不会把第三方 Skill 直接变成任意代码执行入口。

## 四、RAG、附件与记忆

### 14. PetDock 的知识库 RAG 是怎么做的？

用户通过 Electron 原生目录选择器授权目录后，Runtime 解析 PDF、DOCX、XLSX、PPTX 和文本文件，统一切分成带位置信息的文档块，使用 Embedding 生成向量。

元数据和文档位置保存在 SQLite，向量保存在 Chroma。查询时先向量召回候选，再做评分和可选 Rerank，最后把通过准入的来源片段注入 Prompt，并把页码、标题、工作表或幻灯片等位置作为引用展示。

Chroma 只负责向量检索，SQLite 负责业务元数据、索引状态和来源定位，两者职责分离。

### 15. 为什么要区分知识库索引和会话附件临时索引？

知识库是用户长期维护的资料；会话附件通常只对当前会话有效，不能污染长期知识库。因此项目对大附件集建立独立的 SQLite/FTS5 和 Chroma 临时索引，复用 Chunk 策略和当前 Embedding Profile，但使用隔离的目录和 collection。

小资料集在 token 预算内直接注入；超过阈值才进入临时检索。删除会话、清空会话或切换 Embedding Profile 时，临时索引会一起清理。

### 16. 多文件分析时如何避免某个文件被完全忽略？

附件分析不仅按相关性召回，还会保留逐文件覆盖信息：哪些文件直接读取、哪些文件命中片段、哪些文件未命中、哪些文件存在解析警告。对于比较、总结、字段提取等任务，系统优先保证每个文件都有机会进入上下文，再在 token 限制内控制内容量。

### 17. 长期记忆是怎么处理的？

会话历史和长期记忆保存在本地 SQLite。每轮任务结束后，记忆分析器可以生成候选，但候选默认不会直接写入正式记忆；用户确认后才生效。用户可以查看、删除单条记忆，也可以按会话、记忆或工具日志范围清理。

### 18. 文档解析和图片理解有什么安全边界？

文档解析只处理静态内容，不执行文档内脚本。图片先生成去除 EXIF/GPS 的安全派生图，再交给没有工具、记忆和 Skill 权限的独立 Vision Analyzer。图片能力需要主动探测成功后才会启用；扫描版 PDF OCR 不在当前实现范围内。

## 五、官方服务、认证与配额

### 19. 桌面端如何登录官方服务？

桌面端使用系统浏览器完成 OAuth 2.1/OIDC Authorization Code + PKCE。Electron Main 生成一次性 state、code verifier，并在 `127.0.0.1` 随机端口监听一次性回调。

回调成功后，Main 保存加密的 Refresh Token，短期 Access Token 只在受控进程内使用。Access Token 不下发给 Renderer；Runtime 需要官方能力时，由 Main 注入短期 Session 或代理刷新结果。

### 20. 为什么要用 PKCE 和 loopback，而不是在桌面端嵌入登录页？

桌面应用属于公共客户端，不能安全保存 client secret。PKCE 用 code verifier 绑定授权请求和换 token 请求，即使授权码被截获，也不能直接兑换 Token。

使用系统浏览器可以复用浏览器登录能力，也减少嵌入式 WebView 带来的凭据采集风险。Loopback 回调只绑定本机地址，并且 state、端口和回调会做校验。

### 21. 控制面和 AI 数据面为什么要分开？

控制面负责“谁是谁、能用什么、还有多少额度”；AI 数据面负责“实际调用模型”。分开后可以对 Chat、Vision、Search、Embedding、Rerank 分别做开关和授权，对 AI Gateway 做单独的资源和出口控制，也能让 Web 端只访问控制面，不接触 AI 数据面和桌面 Token。

### 22. 用量配额是怎么避免并发超额的？

调用开始前，AI Gateway 向控制面申请 usage reservation；调用成功后 settle，调用失败或取消时 release/fail。控制面用 requestId 做幂等和状态流转，避免同一次请求重复扣量或异常时额度永久占用。

Web 端展示的是控制面返回的真实摘要和历史，不在前端伪造额度。正式支付、退款和按量结算账本目前不属于已完成范围。

### 23. 官方服务不可用时会不会自动切换到用户自己的 API Key？

不会静默切换。官方服务和 BYOK 配置相互独立，官方额度耗尽、授权失效或服务关闭时，界面会展示明确状态；只有用户主动选择服务来源才会切换，避免用户在不知情的情况下产生第三方 API 费用。

## 六、Web、测试与部署

### 24. Web 端为什么不直接调用 FastAPI AI 数据面？

Web 端是账号和服务管理入口，不是模型调用客户端。它只调用 Spring Boot 控制面的 Web API，通过 HttpOnly Web Session 和 CSRF 保护请求；不读取或保存 Desktop Refresh Token、Runtime Token、Provider Key，也不消费 Chat SSE。

这样可以把浏览器暴露面控制在账号和业务数据范围内，模型调用仍由桌面 Runtime 或受控 AI Gateway 发起。

### 25. 项目有哪些测试？如何证明功能不是页面壳子？

项目采用分层测试：

- Electron/TypeScript：状态机、Runtime 生命周期、IPC 相关 Manager、密钥存储、网络策略和工具策略。
- Python：Agent、附件、文档解析、Artifact、记忆、Skill、Provider 和 RAG。
- Cloud：契约测试、Spring Boot 控制器和安全边界测试、ArchUnit、Testcontainers 集成测试、AI Gateway Provider 测试。
- Web：Vitest/Testing Library 单元测试和 Playwright 端到端测试。

当前仓库已有较完整的自动化测试和生产构建检查。面试时可以强调“测试覆盖了协议、安全边界和核心流程”，但不要把测试数量当作业务价值本身。

### 26. 项目如何打包和部署？

桌面端使用 PyInstaller 把 Python Runtime 打成可执行文件，再使用 electron-builder 生成 Windows NSIS 安装包和 Portable 便携版。

云端使用 Docker Compose 编排 PostgreSQL、Redis、Spring Boot Control Plane、AI Gateway、Embedding Runtime、Rerank Runtime、Web 和 Nginx。生产网络按前端、后端和 Provider 出口隔离，AI 服务使用只读文件系统、tmpfs、capability drop、资源上限和 healthcheck。

### 27. 项目目前有哪些未实现或不能夸大的地方？

需要主动说明：

- 正式支付、退款、收费账本和按量计费闭环尚未完成。
- 生产环境按单台服务器设计，不应表述为已实现集群和自动容灾。
- 当前主要支持 Windows，不应表述为跨 macOS/Linux 的完整桌面产品。
- 扫描版 PDF OCR 不在当前范围。
- 复杂 Office/PDF 修改和受控 Python 执行属于延期能力。

主动讲清边界，通常比把 Roadmap 当成现成功能更可信。

## 七、AI Coding 项目的诚实回答方式

### 28. 如果面试官问“这个项目是不是 AI 生成的”，怎么回答？

可以这样回答：

> 项目大量使用了 AI Coding 工具提升开发效率，尤其是样板代码、测试用例、类型定义和文档整理。但架构边界、协议设计、安全约束和功能取舍是我自己梳理并验收的。我能说明一次请求从 Renderer 到 Main、Runtime、模型再回到 UI 的完整链路，也能解释为什么要把权限校验放在 Main、为什么要把会话附件索引和长期知识库隔离，以及异常和取消如何处理。

重点不是声称“每一行都是手写”，而是证明你理解并能维护系统。

### 29. 如果被要求现场改一个功能，应该怎么开始？

先确认功能属于哪一层，再追踪现有链路：

1. 先找共享类型或协议定义。
2. 找 Renderer/Preload 的入口。
3. 找 Main 的 IPC handler 或 Manager。
4. 找 Runtime API 和领域服务。
5. 找持久化、Provider 或外部系统边界。
6. 补单元测试、契约测试或 E2E 测试。

不要一上来修改几千行的 Renderer 文件。先画出数据流，再决定改动点。

### 30. 你认为项目中最值得讲的技术难点是什么？

我会选“跨进程 Agent 工具调用的安全闭环”来讲：模型只能提出固定工具调用，Runtime 不能直接执行系统操作；Main 重新校验风险，并根据策略自动执行、等待用户确认或拒绝；结果再回传 Runtime 继续推理，同时记录脱敏审计日志。

这个难点同时涉及异步任务、SSE、事件顺序、权限边界、取消和超时，比单纯接一个大模型 API 更能体现工程能力。

## 八、最后需要背熟的五句话

1. **架构：** Electron Main 管桌面权限，Python Runtime 管 Agent/RAG/记忆，二者通过本地 HTTP + SSE 通信。
2. **安全：** Renderer 没有 Node 和密钥权限，工具由 Main 重新校验，Python Agent 只能规划不能直接执行高风险操作。
3. **Agent：** 先组织历史、附件、知识库和 Skill 上下文，再流式调用模型；工具结果回传后继续有限轮次推理。
4. **服务：** Cloud Control Plane 管身份、设备、授权和用量，AI Gateway 管实际模型调用，Web 只访问控制面。
5. **边界：** 已实现的是本地助手和托管 AI 能力闭环，支付、退款、集群容灾和跨平台桌面仍不是当前完成能力。

