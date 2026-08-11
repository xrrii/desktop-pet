# PetDock AI 助手进度记录

本文档用于持续记录 PetDock AI 助手相关工作的完成情况。每次实现架构文档中的能力后，应同步更新本文档。

关联文档：

- `docs/architecture/AI_ASSISTANT_ARCHITECTURE.md`
- `docs/features/SKILL_SYSTEM_DEVELOPMENT.md`
- `docs/features/CONVERSATION_RESOURCE_CAPABILITIES.md`

状态约定：

```text
Not Started  尚未开始
In Progress  进行中
Blocked      阻塞
Done         已完成
Deferred     延后
```

## 1. 当前总览

更新时间：2026-08-10

```text
AI 助手核心功能状态：Done（阶段 1 至阶段 5）
后续增强状态：In Progress（C1 至 C5 已完成，C6 Deferred）
架构设计状态：Done
AI 开工前工程基线：Done
桌宠基础能力：Done
Python LangChain Runtime：Done（阶段 5）
RAG 文档管理：Done（阶段 4）
RAG 检索优化：In Progress（R0/R3/R4 部分完成、R1 完成、R2 主体已实现但未完成正式验收）
Skill 系统：Done（阶段 5）
对话资源能力：In Progress（C1 至 C5 Done，C6 Deferred）
```

## 2. 已完成事项

### 桌宠基础能力

状态：Done

- [x] Electron + Vite + TypeScript 项目骨架。
- [x] 透明无边框桌宠窗口。
- [x] 桌宠 Canvas spritesheet 动画播放。
- [x] 桌宠拖拽移动。
- [x] 托盘菜单。
- [x] 多桌宠切换。
- [x] 安装包应用名改为 `PetDock`。
- [x] 安装包、exe、快捷方式图标配置。
- [x] 图标白边透明处理。
- [x] 安装版扩展宠物加载能力。
- [x] `assets/pets/**` 新增宠物默认不再被 Git 跟踪。

验证方式：

- `npm.cmd run build` 通过。
- 安装包可生成并安装。
- 安装版支持从扩展目录加载宠物。

### AI 助手设计文档

状态：Done

- [x] 编写 `docs/architecture/AI_ASSISTANT_ARCHITECTURE.md`。
- [x] 明确采用 Electron 桌宠 + Python Assistant Runtime 架构。
- [x] 明确 Python LangChain 作为 Agent Runtime。
- [x] 明确 Electron Main 作为权限和系统能力边界。
- [x] 补充能力列表和演进路线。
- [x] 补充 Skill 系统设计，并在阶段 5 完成实现基线。
- [x] 补充 RAG 文档管理设计，并在阶段 4 完成核心闭环。
- [x] 固化本地 Runtime 鉴权、生命周期和协议版本要求。
- [x] 明确桌宠与助手 UI 使用单一透明窗口和最小化 preload。

验证方式：

- 文档已创建于 `docs/`。

### AI 开工前工程基线

状态：Done

- [x] Electron 升级到 `43.1.1`，electron-vite 升级到 `5.0.0`。
- [x] 修复严格 TypeScript 类型检查错误。
- [x] 增加 `typecheck`、`test` 和 `check` 脚本。
- [x] 增加状态机和 manifest 归一化单元测试。
- [x] 启用 renderer sandbox 和 CSP，移除全局 `no-sandbox`。
- [x] IPC handler 校验调用窗口身份和坐标参数。
- [x] 集中桌宠共享类型，建立 AI 协议 v1 类型定义。
- [x] 同步 `package.json` 与 lockfile 版本。
- [x] 恢复 ASAR 打包并验证 Windows unpacked 产物。

验证方式：

- `npm.cmd run typecheck` 通过。
- `npm.cmd test` 通过。
- `npm.cmd run build` 通过。
- `npm.cmd run pack` 通过。

## 3. 核心功能阶段（已完成）

### 阶段 1：助手输入框 + 普通聊天

状态：Done

- [x] Assistant 与桌宠合并为单一透明窗口，不再显示完整页面。
- [x] 展开助手时扩大窗口，收起后恢复桌宠原始尺寸和屏幕位置。
- [x] 桌宠左侧空间充足时输入框从右向左展开，否则在右侧从左向右展开。
- [x] 展开状态拖动整个组合窗口，桌宠与输入框保持固定锚点。
- [x] 支持五套助手主题切换：雾白实用、墨线便笺、夜航玻璃、像素伙伴、苹果毛玻璃。
- [x] 主题选择持久化到用户设置，重启后恢复上次选择。
- [x] 双击桌宠或使用托盘菜单唤起助手。
- [x] 输入框支持发送、取消、加载状态和新对话。
- [x] Electron Main 管理 Python Runtime 启动、健康检查和优雅退出。
- [x] Python Runtime 暴露带单次启动令牌的本地 HTTP + SSE 接口。
- [x] Python Runtime 接入 LangChain OpenAI-compatible backend。
- [x] 未配置模型时提供离线 mock backend。
- [x] 支持普通对话、进程内会话上下文和流式回复。
- [x] 使用 PyInstaller 打包独立 Runtime exe 并随应用分发。

验收标准：

- 双击桌宠能打开输入框。
- 输入消息后能得到 AI 回复。
- 输入框关闭后不影响桌宠运行。
- API key 不暴露给 renderer。
- 双击行为改为唤起助手，跳跃仍可从托盘和右键菜单触发。

验证方式：

- `npm.cmd run check` 通过：7 个 TypeScript 测试、3 个 Python 测试。
- `npm.cmd run test:e2e:assistant` 通过。
- `npm.cmd run test:e2e:assistant:dev` 覆盖 electron-vite 开发模式、透明背景、CSS 加载、左右展开方向和五套主题切换。
- `npm.cmd run pack` 通过，包含独立 `petdock-assistant.exe`。
- `npm.cmd run test:e2e:assistant:packaged` 通过。
- `npm.cmd run test:e2e:assistant:langchain` 通过，打包版 `ChatOpenAI.astream()` 已连接本地 OpenAI-compatible 测试服务。
- 端到端测试覆盖单窗口展开/收起、左右停靠、桌宠与输入框锚点、透明气泡样式、五套主题、流式回复、取消和 Runtime 退出。

### 阶段 2：工具调用

状态：Done

- [x] 设计工具调用协议和 `/v1/tool-result` 回传接口。
- [x] Python Runtime 生成 tool call，并暂停任务等待执行结果。
- [x] Electron Main 接收 tool call，统一编排 UI 事件序号。
- [x] Electron Main 对工具名称、参数、URL、应用和路径做权限校验。
- [x] 支持 `open_url`，仅允许 `http` 和 `https`。
- [x] 支持 `open_app`，仅允许记事本、资源管理器和计算器白名单。
- [x] 支持 `open_file_or_folder`，打开前解析真实路径并确认文件存在。
- [x] 应用和文件/文件夹操作显示确认卡片；未知和危险工具直接拒绝。
- [x] 工具确认 60 秒超时，任务取消或助手关闭后自动失效。
- [x] 工具请求、策略判断、用户决策和执行结果写入独立审计日志。
- [x] 输入 `~` 弹出快捷命令菜单，支持“打开网站”和“打开应用”。
- [x] 快捷命令支持鼠标、上下方向键、回车和 Esc，`$` 保留给后续 Skill 菜单。

验收标准：

- AI 能打开网页。
- AI 能打开白名单应用。
- AI 能打开指定文件或文件夹。
- 需要确认的操作不会直接执行。

验证方式：

- TypeScript 单元测试覆盖 URL 协议、应用白名单、路径存在性和未知工具拒绝。

### 阶段 3：记忆与记忆管理界面

状态：Done

- [x] 设计并实现 SQLite schema 与自动迁移。
- [x] 保存会话历史和用户/助手/工具消息。
- [x] Runtime 重启后恢复 LangChain 会话上下文。
- [x] 支持明确“记住”表达的用户偏好记忆。
- [x] 根据成功工具执行记录常用应用和目录。
- [x] 工具审计日志同步保存到 SQLite，并保留原有脱敏 JSONL 日志。
- [x] 增加记忆摘要、会话消息恢复和清理 API。
- [x] 增加助手内“会话历史 / 长期记忆 / 使用记录”管理面板。
- [x] 支持单条删除、按类别清理和全部记忆清理。
- [x] 路径和工具参数在 Runtime 返回 Renderer 前脱敏。
- [x] 增加 Runtime 内部结构化记忆工具：`remember_preference`、`forget_memory`、`list_memories`。
- [x] 增加主任务完成后的异步记忆分析器，不阻塞主代理回复。
- [x] 增加待确认记忆候选，支持用户确认或忽略后再写入长期记忆。

验收标准：

- AI 能引用最近对话上下文。
- AI 能记住常用应用和目录。
- 用户可以清理记忆数据。

### 阶段 4：RAG 本地知识库

状态：Done

- [x] 使用独立 `knowledge.db` 保存知识库、授权来源、文档、chunk 和索引任务状态。
- [x] 引入 Chroma 1.5 持久化向量索引，业务数据不依赖 Chroma metadata。
- [x] 增加本地确定性 embedding，未配置模型时也能离线索引和检索。
- [x] 使用 SQLite FTS5 与 Chroma 向量召回，通过 RRF 做混合排序。
- [x] 支持 Markdown、文本、配置、源码等 UTF-8 文本文件。
- [x] 支持增量刷新、暂停、恢复、错误状态和 Runtime 重启后的状态恢复。
- [x] 默认排除构建目录、隐藏目录、敏感文件、符号链接、超大文件和二进制文件。
- [x] 目录只能通过 Electron Main 原生选择器授权，Renderer 不能提交任意路径。
- [x] 增加助手内知识库管理、索引进度、对话范围选择和来源引用。
- [x] 对话知识库范围由 Main 持久化，默认不选，用户主动勾选后才参与模型上下文。
- [x] 检索资料按不可信内容处理，不能借文档内容绕过工具权限。
- [x] 删除知识库只删除 SQLite/Chroma 索引，不修改来源文件。

验收标准：

- AI 能基于用户明确授权的目录回答问题并展示来源。
- 用户可以暂停、恢复、刷新和删除索引。
- 文件更新后可以增量重建，敏感文件不会进入索引。

验证方式：

- Runtime 测试覆盖 Chroma 持久化、增量更新、敏感文件排除、混合召回和引用事件。
- TypeScript 类型检查和单元测试覆盖共享协议及既有桌宠行为。
- `npm.cmd run check` 通过：10 个 TypeScript 测试、8 个 Python Runtime 测试和生产构建。
- `npm.cmd run pack` 通过，解包版包含约 67.8 MB 的 Chroma Runtime。
- `npm.cmd run test:runtime:packaged` 通过，验证独立 exe readiness、健康检查和优雅关闭。
- `npm.cmd run test:e2e:assistant:packaged` 通过，覆盖知识库管理视图并生成视觉回归截图。

## 4. 增强能力状态

### 对话资源能力

状态：In Progress（C1 至 C5 已完成，C6 Deferred）

- [x] C1：拖拽附件与文本解析。
- [x] C1.1：草稿/历史附件文本预览与失败投放提示。
- [x] C2：基础 Artifact 文件输出（开发版与解包版生成、预览、取消保存、实际保存和删除验收完成）。
- [x] C3：联网搜索与网页引用（开发版与解包版本地可控 Provider 搜索、抓取、引用验收完成）。
- [x] C4：复杂文档输入与条件式图片理解。
- [x] C5：多文件只读分析和临时索引（开发版与解包版双文件检索、跨轮复用、来源定位验收完成）。
- [ ] C6：受控 Python 执行与复杂文档输出/修改（Deferred，未排期）。

实现基线：

- `docs/features/CONVERSATION_RESOURCE_CAPABILITIES.md`

已决策的核心交互：

- 文件可以拖到展开的对话区。
- 文件可以直接拖到收起的桌宠，投放后自动展开助手；成功显示附件，失败显示错误。
- 文件只加入输入草稿，不自动发送。
- 文件输出先生成应用内 Artifact，用户通过原生保存对话框决定最终位置；C4 不增加复杂格式输出。
- 图片输入由独立 Vision Analyzer 处理，默认继承主模型配置但必须主动探测能力；不可用时明确拒绝图片输入。

C1 已实现：

- Preload 使用 Electron `webUtils.getPathForFile` 接收系统拖拽文件，真实路径只直接提交给 Main，不进入 Renderer API。
- Main 校验普通文件、类型、数量和大小后复制到应用附件根目录；Runtime 只按随机附件 ID 和受控相对路径登记。
- 支持文件拖到展开对话区、拖到收起桌宠后自动展开，以及原生多选文件按钮；附件只进入草稿，不自动发送。
- 首版严格解析 UTF-8/BOM 文本，解析失败状态可见且不能发送；单文件 10 MB、单批 30 MB、单轮 10 个。
- 用户消息保存脱敏附件摘要，模型上下文使用不可信附件边界，并通过 `attachment_sources` 返回实际读取来源与截断状态。
- 移除草稿、新建/切换会话、关闭助手、正常退出、删除会话和清空会话均执行对应附件清理；启动时清理遗留草稿及超过宽限期的孤立随机目录。
- 开发产物和 Windows 解包版均通过真实文件 CDP 拖拽、自动展开、只附件发送、来源展示和清理回归。

C1.1 已实现：

- 点击待发送或历史消息附件可打开纯文本预览，支持按 65,536 字符分页继续加载。
- Runtime 只按附件 ID 返回已解析文本，并校验草稿/会话归属；Renderer 仍不接触路径。
- 不支持格式拖到收起桌宠时立即展开助手，错误提示去除 Electron IPC 包装前缀。
- E2E 覆盖 `.exe` 失败投放、草稿预览、只附件发送和历史附件预览。

C2 已实现：

- Runtime 增加受控 `create_artifact` 内部工具、Artifact SQLite 索引和应用内受控目录，支持 TXT、Markdown、JSON、JSONL、YAML、CSV、TSV、XML、HTML、CSS、JavaScript、TypeScript、Python、Java、Kotlin、Go、Rust、SQL、TOML 和 INI。
- 模型只能提交建议文件名、格式和 UTF-8 正文；Runtime 执行格式白名单、25 MB 上限、文件名清理、Windows 保留名和会话归属校验，Renderer 不接触真实路径或完整正文接口。
- `artifact_created` 事件和历史消息均可恢复 Artifact 卡片；卡片提供只读预览、另存、失败重试和删除，文本支持分页，CSV/TSV 最多展示前 50 行、每行前 12 列。
- 保存必须由 Main 打开原生“另存为”对话框；Main 按 Artifact ID 从 Runtime 取回内容，并通过同目录临时文件直接原子替换目标，替换失败时原目标未被移走，取消或失败时保留应用内 Artifact。
- Artifact 生成、保存和删除写入不含正文及目标路径的现有 JSONL 工具审计日志；删除会话、清空会话或显式删除卡片时清理应用内文件，外部另存副本不由 PetDock 管理。
- `npm.cmd run typecheck`、26 个 TypeScript 测试和 35 个 Python Runtime 测试通过；Runtime 测试覆盖七种格式、Windows 文件名清理、大小与会话隔离、生成事件、预览、内容读取、保存标记和会话清理，Main 写入测试覆盖新建、原子覆盖、替换失败保留原文件、清理异常不误报和 Windows 符号链接拒绝。
- 开发版与解包版 E2E 已验证 Artifact 生成、卡片、预览、取消保存、实际保存内容和删除；生产路径仍由 Windows 原生“另存为”对话框选择目标，Smoke 仅在测试环境替换 Main 选择结果，C2 已标记为 Done。

C5 已实现：

- Runtime 按会话读取全部已绑定附件，使用活动 Embedding Profile 的 Token 计数统一决策：总量不超过 12,000 tokens 直接注入，超出后切换到最多 8,000 tokens 的相关片段上下文。
- 会话索引位于独立 `assistant/session-index/<profile-signature>`，使用独立 SQLite/FTS5、Chroma 目录和 collection；Chunk 策略与知识库共用，向量生成复用活动 Profile，但数据不会进入长期知识库。
- 索引按附件内容指纹、Embedding 签名和 Chunk 版本增量更新；向量失败可降级到 FTS5，索引整体失败时本轮对话继续并明确显示未读取范围。
- 多文件比较、总结、字段提取和交叉核对优先保证逐文件覆盖；结构化 `attachment_sources` 显示直接读取或命中片段、引用编号、分数、行/块/页/标题路径/工作表/幻灯片位置、未命中文件和解析警告。
- 删除会话、清空会话和切换 Embedding Profile 会清理对应派生索引；后续轮次无需重新上传或重复提交附件 ID。
- 69 项 TypeScript 测试、73 项 Python Runtime 测试、类型检查和生产构建通过；开发版与 Windows 解包版 `test:e2e:assistant:c5` Smoke 均通过。

### RAG 后续增强

状态：In Progress（已实现部分能力，剩余事项未排期）

- [x] 建立首版本地 ONNX 向量模型白名单，固定模型版本、推理规则、下载文件与 SHA-256。
- [x] 固化 RAG 召回与检索质量优化方案、阶段门槛和完成定义。
- [x] 增加确定性检索路由、查询清洗、动态结果数量、最终准入和延迟来源事件。
- [x] 实现统一 Embedding Provider，支持 Hash、本地 ONNX 和 OpenAI-compatible 在线接口。
- [x] 增加模型配置界面、白名单下载、暂停续传、完整性校验、在线密钥加密和切换失败回滚。
- [x] 增加 Index Signature、独立 Chroma collection 和 Hash 影子索引降级。
- [x] 建立固定检索评测工具、32 条基线用例和 JSON 指标报告。
- [ ] 将固定评测集扩充到 200 条以上，并补齐分类型指标、延迟、内存和磁盘报告。
- [ ] 在打包版完成至少一个 BGE 和一个 Multilingual E5 的真实下载、索引、查询、切换和回滚验收。
- [ ] PDF、DOCX、PPTX 文档解析。
- [ ] 文件系统 watcher 与自动增量更新。
- [ ] query rewrite、父子分块和 reranker。

当前验证：

- `npm.cmd run check` 通过：19 个 TypeScript 测试、30 个 Python Runtime 测试、RAG 评测和生产构建。
- 当前 32 条检索基线用例的路由准确率、工具误召回率、零结果准确率、文档召回、Precision@3 和 MRR@3 均达到预期。
- `npm.cmd run test:runtime:packaged` 与 `npm.cmd run test:e2e:assistant:packaged` 通过。
- 打包版 E2E 已覆盖模型选择和下载确认界面，尚未执行大型模型的真实网络下载与全量重建验收。

待决策（均未排期）：

- 默认本地 embedding 模型及各模型阈值。
- 二进制办公文档的解析依赖与隐私提示。
- 是否默认启用文件系统 watcher。
- 在线模型使用知识片段时的逐库授权策略。

### Skill 系统

状态：Done

- [x] 固化 Agent Skills 兼容、GitHub 安装和渐进式披露开发方案。
- [x] skill manifest 规范。
- [x] skill 目录扫描。
- [x] skill 启用/禁用。
- [x] skill 权限声明与运行时能力收缩。
- [x] 固定内部工具参数 schema。
- [x] skill 通过固定工具注册到 Agent。
- [x] skill 运行状态和错误日志展示。
- [x] 本地授权与 GitHub 安装来源校验。
- [x] 启动仅注册 `name`、`description`，激活后加载正文，资源按需读取。
- [x] `$` 显式调用与 Agent 自主激活。
- [x] 本地目录、GitHub 公共仓库、多 Skill 候选、更新和卸载。

实现基线：

- `docs/features/SKILL_SYSTEM_DEVELOPMENT.md`

首版边界：

- 兼容 `SKILL.md` YAML frontmatter 以及可选 `skill.json` 扩展清单。
- 含第三方脚本或外部依赖的 Skill 仅按 `instruction-only` 使用，不执行脚本。
- 不支持私有 GitHub 仓库、GitHub Token、Skill 签名和远程信任服务。
- Skill 不能直接联网或执行本地进程；声明权限只能收缩能力，最终由 Electron Main 复核。

## 5. 阻塞项

当前无明确阻塞项。

潜在风险：

- Python Runtime 打包后体积可能明显增加。
- LangChain 依赖升级可能影响打包稳定性。
- RAG 索引本地文件涉及隐私和性能风险。
- 文件系统工具必须严格限制权限。
- 自动执行系统操作必须有确认机制和审计日志。

## 6. 变更记录

### 2026-07-18

- 创建 AI 助手进度记录文档。
- 记录已完成的桌宠基础能力。
- 记录已完成的 AI 架构文档。
- 建立阶段 1 至阶段 3 的近期计划。
- 为 RAG 文档管理和 Skill 系统建立占位进度。

### 2026-07-19

- 阶段 1 助手界面改为跟随桌宠的透明气泡窗口。
- 增加左右空间自适应停靠、相反方向展开动画和开发模式 CSS 回归测试。
- 将桌宠与助手迁移到单一透明窗口，修复拖动时两个原生窗口不同步和输入框下沉问题。
- 修复 LangChain 工具调用结果回传时 assistant `tool_calls` 消息未及时写入历史，导致模型拒绝后续 `tool` 消息的问题。
- 放宽工具调用 ID 的下划线校验，修复 LangChain `call_...` ID 点击允许时无法回传的问题。
- 增加 `~` 快捷命令菜单，减少用户重复输入“打开”；预留 `$` 作为后续 Skill 入口。

### 2026-07-19（阶段 3）

- 增加 `assistant.db` SQLite 存储，默认位于 PetDock 用户数据目录。
- 将 Runtime 会话历史从进程内字典迁移到 SQLite，支持重启后恢复上下文。
- 增加用户偏好、常用应用、常用目录和工具日志持久化。
- 增加受鉴权保护的记忆查询、单条删除、分类清理和全部清理接口。
- 增加助手记忆管理界面，复用透明窗口、左右停靠和五套主题。
- 增加会话恢复、路径脱敏和记忆数据 Runtime 测试。
- 补齐 Python Runtime 全部类/方法的中文 docstring，并将注释约定写入开发文档。
- 当前 Electron 开发模式冒烟测试受本机 GPU 进程和用户目录缓存权限影响，未能启动窗口；类型、单元、Runtime 测试和生产构建均通过。

### 2026-07-26（阶段 4）

- 引入 Chroma 持久化向量索引，并保留 SQLite 作为知识库业务主存储。
- 增加本地 embedding、FTS5 + 向量混合召回和结构化来源引用。
- 增加安全目录扫描、增量索引、暂停/恢复及知识库管理界面。
- 目录授权收口到 Electron Main 原生选择器，删除操作不触碰原始文件。

### 2026-07-26（阶段 5）

- 增加 Agent Skills 兼容清单、`skills.db`、元数据注册表和三级渐进式披露。
- 增加 `search_skills`、`activate_skill`、`read_skill_resource` 固定内部工具和最多 6 轮 Agent 循环。
- 支持本地目录及 GitHub 公共仓库预览、多候选选择、固定 commit、安全归档安装、更新和卸载。
- 增加 Skill 管理视图、`$` 菜单、结构化 `skillId` 调用和运行状态反馈。
- Skill 权限在 Runtime 侧收缩知识库、记忆和 OS 工具，外部 ToolCall 仍由 Electron Main 重新校验和审计。
- 第三方脚本首版仅标记为 `instruction-only`，不会执行任意脚本、Shell 或依赖安装。
- Runtime 改用受控构建脚本，Windows 下优先收集 System32 VC Runtime，打包版已通过真实本地 ONNX 模型启动验证。
- `npm.cmd run check` 覆盖 15 个 TypeScript 测试、30 个 Python Runtime 测试、RAG 评测和生产构建。
- `npm.cmd run test:runtime:packaged` 与 `npm.cmd run test:e2e:assistant:packaged` 验证独立 Runtime、Skill 管理界面和打包版链路。

### 2026-07-28（现状同步与方案基线）

- 核心功能阶段 1 至阶段 5 全部完成。
- 新增 `docs/features/CONVERSATION_RESOURCE_CAPABILITIES.md`，固定附件对话、文件输出、联网搜索、复杂文档和多文件修改的开发边界。
- 对话资源能力当前为 Not Started，C1 至 C5 只确定依赖顺序，不代表已经安排具体开发日期。
- RAG v2 已实现确定性路由、动态准入、结构化 Trace、统一 Embedding Provider 和模型管理界面。
- 本地 ONNX、在线 Embedding、独立向量空间、Hash 降级和切换失败回滚主体代码已落地。
- 固定评测工具当前包含 32 条基线用例；200 条以上评测集、完整性能报告和两个本地模型的打包版全链路验收仍未完成。
- 最新验证为 19 个 TypeScript 测试、30 个 Python Runtime 测试、RAG 基线评测、生产构建、打包 Runtime 冒烟和打包助手 E2E 全部通过。

### 2026-07-28（C1 附件对话）

- 完成 C1 共享协议、Main 受控暂存、Preload 安全拖拽、Runtime UTF-8 解析与附件数据库。
- 完成拖到收起桌宠自动展开、展开对话区投放、原生文件选择、附件标签、移除、只附件发送和历史恢复。
- 完成附件上下文安全边界、`attachment_sources` 结构化来源、会话绑定和全生命周期清理。
- `npm.cmd run typecheck`、22 个 TypeScript 测试、33 个 Python Runtime 测试和 RAG 固定评测通过。
- `npm.cmd run build`、`npm.cmd run test:e2e:assistant`、`npm.cmd run pack`、`npm.cmd run test:runtime:packaged` 与 `npm.cmd run test:e2e:assistant:packaged` 通过。
- C2 至 C5 保持 Not Started，下一阶段方向未改变。

### 2026-07-28（C1.1 附件文本预览）

- 增加草稿和历史附件纯文本预览弹窗、分页加载状态及解析失败状态。
- 增加 Runtime 附件预览接口和归属校验，Main/Preload/Renderer 全链路只使用附件 ID。
- 修复不支持格式拖到收起桌宠后未自动展开的问题，并清理 IPC 错误包装文本。
- 开发版 E2E 已覆盖不支持格式提示、草稿预览和历史附件预览；C2、C3 已完成验收，C5 尚未开始。

### 2026-07-28（C2 基础 Artifact 文件输出）

- 完成 `create_artifact`、Artifact 受控目录与数据库、SSE 事件、历史恢复、卡片、文本/表格预览和生命周期清理。
- 完成 Main 原生“另存为”、按 ID 读取、原子新建/覆盖、替换失败保留原目标和脱敏审计；Renderer 与 Preload 不接触 Artifact 真实路径。
- `npm.cmd run typecheck`、26 个 TypeScript 测试和 35 个 Python Runtime 测试通过。
- 开发版 E2E 已验证生成、卡片、预览和删除，独立 Runtime 打包形态测试通过；Windows 原生保存对话框自动化与完整 Electron 打包版保存闭环尚未稳定通过，C2 保持 In Progress，待验收收尾后再标记 Done。

### 2026-08-02（C3 联网搜索与网页引用）

- 默认 Search Provider 调整为火山引擎豆包搜索 Custom 版，固定使用官方 `web_search` POST API 和 Bearer 鉴权；Brave Search 作为兼容 Provider 保留。
- 联网默认关闭，API Key 由 Electron `safeStorage` 按 Provider 隔离加密；旧版 Brave 配置和密钥继续按 Brave 读取，Renderer 只读取启用和脱敏配置状态。
- 完成 `search_web`、`fetch_web_page`、任务配额、取消、SSRF/DNS 重绑定防护、逐次重定向校验、正文大小/超时/MIME 限制及 DOM 清洗。
- Runtime 将网页正文限制在当前任务内，持久化工具摘要时脱敏查询和 URL；最终回答只按实际 `[网页N]` 引用发出 `web_sources` 并保存短来源。
- 完成联网设置、火山引擎 API Key 管理页入口、首次启用隐私确认、连接测试、搜索摘要/已读取正文来源卡片和历史恢复；Skill 联网新增 `network.read` 权限。
- 当前 TypeScript 类型检查、60 项 TypeScript 全量测试（其中 32 项 C3 联网测试）和 37 项 Python Runtime 测试通过；生产构建、开发版/解包版联网设置与 `safeStorage` 脱敏 E2E、独立 Runtime 冒烟通过，生产依赖审计为 0 个漏洞。
- 修复 Node 22 以 `lookupOptions.all = true` 建立 HTTPS 连接时固定 DNS 回调返回单地址导致的 `Invalid IP address: undefined`；同步 Runtime 协议的 `volcengine` Provider 字面量，避免启用火山搜索后创建对话返回 422。
- 修复应用在 PyInstaller Runtime 冷启动期间退出时只终止外层进程、遗留内层 Runtime 的竞态，并增加“启动中退出”回归测试。
- 修复模型在单次响应中生成多个联网调用时任务直接失败的问题；Runtime 现在最多接收 6 个外部调用并逐项串行派发，每项仍独立经过 Main 策略、配额、审计和确认流程。
- 联网设置在 Provider 已保存密钥时显示固定掩码占位符，真实输入值仍为空；未配置状态显示输入提示，重新保存不会把掩码写成密钥。
- 有效火山引擎 Key 在最新解包版的真实搜索连接已返回 1 条结果，进程能够正常退出且无 Runtime 遗留；本地可控 Provider 的开发版/解包版完整搜索、抓取和引用 E2E 已通过。

### 2026-08-04（C4-C6 范围调整）

- C4 调整为复杂文档输入与图片理解，只负责 PDF、DOCX、XLSX、PPTX 和条件式图片输入，不再包含复杂格式 Artifact 输出。
- 附件与知识库必须共用 `DocumentParserRegistry`、`ParsedDocument`、结构块和位置协议；扫描 PDF 首版返回 `document_ocr_required`，不执行本地 OCR。
- 图片使用无工具、无记忆、无 Skill 权限的独立 Vision Analyzer。默认继承主模型地址、凭据引用和模型名，但必须使用本地随机测试图片主动探测能力；不可用且未配置独立视觉模型时拒绝图片输入。
- C5 收缩为多文件只读分析和会话级临时索引，只使用 C2 已有 TXT、Markdown、CSV、JSON 等基础 Artifact 交付结果。
- 新增 C6 规划，用于固定依赖和资源配额下的受控 Python 执行、复杂 PDF/Office/图片输出、重新读取验证和受控修改；当前状态为 Deferred，未排期。
- C2、C3 的实现和验收状态不因本次范围调整而改变。

### 2026-08-05（C2/C3 验收收尾）

- C2 增加开发版与解包版专用 Smoke：生成、预览、取消保存、受控实际保存内容校验、卡片状态和删除均通过；取消与保存继续分别写入脱敏 Artifact 审计日志。
- C3 增加本地可控 Provider Smoke：模拟 OpenAI 兼容模型依次请求 `search_web`、`fetch_web_page`，正文只在当前任务中使用，最终仅渲染实际引用的 `[网页1]`，来源标记为“已读取正文”。测试 Provider 只在 `PETDOCK_SMOKE_WEB_FIXTURE=1` 时注册。
- 新增 `test:e2e:assistant:c2`、`test:e2e:assistant:c2:packaged`、`test:e2e:assistant:c3` 和 `test:e2e:assistant:c3:packaged` 命令；生产保存和网络安全路径未改变。
- 当前 TypeScript 类型检查与 69 项测试、Python Runtime 现有测试、开发版/解包版 C2/C3 Smoke 均通过。

### 2026-08-04（C4 输入能力实现与验收）

- 完成 C4.0-C4.2：新增唯一 `DocumentParserRegistry`、`ParsedDocument`、结构块/位置/问题协议；PDF 文本层与页码、DOCX 标题/段落/列表/表格、XLSX 工作表/有效区域/单元格/公式文本、PPTX 标题/正文/备注均为只读输入。扫描 PDF 返回 `document_ocr_required`，不执行本地 OCR。
- 完成 C4.1：Office ZIP/XML 在第三方库前检查文件数、单项/总解压大小、压缩比、重复名称、路径穿越、符号链接、加密 OLE、DTD/ENTITY、宏/OLE/ActiveX、远程模板和外部关系；PDF 脚本/自动动作/嵌入对象拒绝；图片限制像素/帧数并去除 EXIF/GPS 后生成 PNG 派生图。
- 完成 C4.3-C4.4：Vision Analyzer 与主 Agent 隔离，无工具、记忆或 Skill 权限；支持继承主模型、同地址/凭据覆盖模型和独立地址/Key/模型。Renderer 提供脱敏配置、独立凭据和主动探测界面，不回填密钥。随机验证码主动探测区分 `unconfigured`、`untested`、`supported`、`unsupported`、`unavailable`、`invalid-credentials`；401/403、模型不存在、429、超时和 5xx 分类独立；摘要按图片哈希/视觉配置签名/提示版本缓存且不落图片 Base64。附件登记、预览、上下文和来源卡片已接入结构位置。
- 完成 C4.5：知识库索引改用同一 Registry，Chunk 增加可选 `location_json` 迁移列，检索来源透出 PDF 页码、DOCX 标题路径/段落、XLSX 工作表/区域和 PPTX 幻灯片位置；知识库图片索引默认关闭。
- 完成 C4.6：68 项 TypeScript 测试、64 项 Python Runtime 测试通过；最终解包目录中的 PyInstaller onefile 为 96,468,304 字节（基线 83,282,372，增加 13,185,932，15.83%），独立 Runtime 冷启动 3,725 ms，能力/正常四类文档解析/图片未探测拒绝/优雅退出通过；开发版和解包版 Electron E2E 均通过。
- 统一助手配置页已接入主模型、联网与图片理解、知识库和 Skill；Composer 能力入口收敛为新对话、附件、会话记忆和统一配置。主动探测成功后的稳定状态会按视觉配置签名持久化，重复保存未变化的配置不会重启 Runtime，程序重启后仍可恢复；真正修改视觉配置仍回到 `untested`。
- 图片附件登记已改为延迟视觉分析：拖入/选择阶段仅做本地安全校验和元数据解析，发送任务启动后才按附件顺序调用 Vision Analyzer，并在主模型推理前等待结果；知识库图片索引默认关闭不变。
- C4 输入依赖锁定为 `pypdf 6.14.2`（BSD-3-Clause）、`python-docx 1.2.0`（MIT）、`openpyxl 3.1.5`（MIT）、`python-pptx 1.0.2`（MIT）、`Pillow 12.3.0`（MIT-CMU）、`defusedxml 0.7.1`（PSFL）；必要传递依赖 `lxml 6.1.1`（BSD-3-Clause）、`XlsxWriter 3.2.9`（BSD-2-Clause）已锁定。未引入 reportlab、OCR 模型或复杂生成依赖。
- 真实视觉 Provider 的在线验证码探测和多端点兼容性仍需在具备可控视觉模型凭据的环境完成；C2/C3 已完成验收，C5 多文件只读分析仍未开始。

### 2026-08-10（C5 多文件只读分析与临时索引）

- 完成会话资料集汇总与 Token 决策：不超过 12,000 tokens 直接注入，超出后检索最多 8,000 tokens 的相关片段；后续轮次自动复用会话已绑定附件。
- 临时索引复用活动 Embedding Profile 和统一 Chunk 策略，但使用独立 SQLite/FTS5、Chroma 目录及 collection；内容指纹、Profile 签名和 Chunk 版本共同控制增量更新与重建。
- 多文件问题优先保留逐文件证据，来源事件和界面区分直接读取、命中片段、未命中文件及解析警告，并展示 C4 结构位置或文本行号。
- 删除会话、清空会话和 Profile 切换均有派生索引清理规则；向量不可用时降级 FTS5，索引整体故障时不终止对话且明确提示未读取范围。
- 类型检查、69 项 TypeScript 测试、73 项 Python Runtime 测试和生产构建通过；开发版与 Windows 解包版 C5 Smoke 均完成双文件检索、跨轮复用和来源展示验收。
