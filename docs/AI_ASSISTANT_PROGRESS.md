# PetDock AI 助手进度记录

本文档用于持续记录 PetDock AI 助手相关工作的完成情况。每次实现架构文档中的能力后，应同步更新本文档。

关联文档：

- `docs/AI_ASSISTANT_ARCHITECTURE.md`

状态约定：

```text
Not Started  尚未开始
In Progress  进行中
Blocked      阻塞
Done         已完成
Deferred     延后
```

## 1. 当前总览

更新时间：2026-07-19

```text
AI 助手总体状态：In Progress
架构设计状态：Done
AI 开工前工程基线：Done
桌宠基础能力：Done
Python LangChain Runtime：Done（阶段 1）
RAG 文档管理：Placeholder
Skill 系统：Placeholder
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

- [x] 编写 `docs/AI_ASSISTANT_ARCHITECTURE.md`。
- [x] 明确采用 Electron 桌宠 + Python Assistant Runtime 架构。
- [x] 明确 Python LangChain 作为 Agent Runtime。
- [x] 明确 Electron Main 作为权限和系统能力边界。
- [x] 补充能力列表和演进路线。
- [x] 补充 Skill 系统占位设计。
- [x] 补充 RAG 文档管理占位设计。
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

## 3. 近期计划

### 阶段 1：助手输入框 + 普通聊天

状态：Done

- [x] Assistant 与桌宠合并为单一透明窗口，不再显示完整页面。
- [x] 展开助手时扩大窗口，收起后恢复桌宠原始尺寸和屏幕位置。
- [x] 桌宠左侧空间充足时输入框从右向左展开，否则在右侧从左向右展开。
- [x] 展开状态拖动整个组合窗口，桌宠与输入框保持固定锚点。
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
- `npm.cmd run test:e2e:assistant:dev` 覆盖 electron-vite 开发模式、透明背景、CSS 加载和左右展开方向。
- `npm.cmd run pack` 通过，包含独立 `petdock-assistant.exe`。
- `npm.cmd run test:e2e:assistant:packaged` 通过。
- `npm.cmd run test:e2e:assistant:langchain` 通过，打包版 `ChatOpenAI.astream()` 已连接本地 OpenAI-compatible 测试服务。
- 端到端测试覆盖单窗口展开/收起、左右停靠、桌宠与输入框锚点、透明气泡样式、流式回复、取消和 Runtime 退出。

### 阶段 2：工具调用

状态：Not Started

- [ ] 设计工具调用协议。
- [ ] Python Runtime 生成 tool call。
- [ ] Electron Main 接收 tool call。
- [ ] Electron Main 做权限校验。
- [ ] 支持 `open_url`。
- [ ] 支持 `open_app`。
- [ ] 支持 `open_file_or_folder`。
- [ ] 高风险操作弹确认框。
- [ ] 记录工具执行日志。

验收标准：

- AI 能打开网页。
- AI 能打开白名单应用。
- AI 能打开指定文件或文件夹。
- 需要确认的操作不会直接执行。

### 阶段 3：记忆

状态：Not Started

- [ ] 设计 SQLite schema。
- [ ] 保存会话历史。
- [ ] 保存用户偏好。
- [ ] 保存常用应用。
- [ ] 保存常用目录。
- [ ] 保存工具执行日志。
- [ ] 支持清理记忆。

验收标准：

- AI 能引用最近对话上下文。
- AI 能记住常用应用和目录。
- 用户可以清理记忆数据。

## 4. 中长期占位

### RAG 文档管理

状态：Placeholder

- [ ] 知识库配置模型。
- [ ] 文档源配置。
- [ ] 允许索引目录管理。
- [ ] 文档扫描。
- [ ] 文档 chunk。
- [ ] embedding。
- [ ] 向量检索。
- [ ] 索引状态查看。
- [ ] 暂停/恢复索引。
- [ ] 删除知识库和索引数据。

待决策：

- 向量库选型。
- embedding 模型选型。
- 是否支持 PDF/DOCX/PPTX。
- 是否使用文件系统 watcher。
- 文档内容是否允许发给云端模型。

### Skill 系统

状态：Placeholder

- [ ] skill manifest 规范。
- [ ] skill 目录扫描。
- [ ] skill 启用/禁用。
- [ ] skill 权限声明。
- [ ] skill 参数 schema。
- [ ] skill 注册为 Agent tool。
- [ ] skill 日志展示。
- [ ] skill 安装来源校验。

待决策：

- skill runtime 类型。
- 是否允许 Python skill。
- 是否允许 HTTP skill。
- 是否允许联网。
- 是否允许执行本地进程。
- 是否需要签名或来源校验。

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
