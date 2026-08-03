# Desktop Pets Electron 开发文档

## 1. 项目目标

基于 Electron 开发一个独立桌宠应用，首个角色使用现有 `hammer-dude` 素材：

- 桌宠名称：雷锤小人
- 素材：`spritesheet.webp`
- 素材尺寸：`1536 x 1872`
- 单帧尺寸：`192 x 208`
- 布局：`8` 列 x `9` 行
- 运行目标：Windows 优先，后续可扩展 macOS / Linux

第一版目标不是做复杂宠物系统，而是先把“透明桌面窗口 + 帧动画 + 拖拽 + 托盘控制 + 打包安装”跑通。

## 2. 技术选型

推荐使用 Electron。

原因：

- 对透明无边框窗口支持成熟。
- 能方便实现窗口置顶、拖拽、托盘菜单、右键菜单、开机启动。
- 用 HTML / CSS / Canvas 播放 spritesheet 很直接。
- 后续做设置面板、角色管理、动作编辑器也容易。

建议技术栈：

- Electron：桌面容器。
- TypeScript：主进程、预加载脚本、渲染层统一类型。
- Vite：渲染层开发服务器和构建。
- Canvas：播放 `spritesheet.webp`，精确控制帧裁切。
- electron-builder：Windows 安装包打包。

可选 UI：

- 设置页可以后续使用 React / Vue。
- 桌宠主体不需要框架，Canvas + 原生 DOM 更轻。

## 3. 项目目录结构

建议在 `E:\project\desktop-pets` 使用如下结构：

```text
desktop-pets/
  package.json
  electron.vite.config.ts
  tsconfig.json
  docs/
    DEVELOPMENT.md
  assets/
    pets/
      hammer-dude/
        pet.json
        spritesheet.webp
  src/
    main/
      index.ts
      tray.ts
      window.ts
      store.ts
    preload/
      index.ts
    renderer/
      index.html
      main.ts
      styles.css
      pet/
        animation.ts
        petManifest.ts
        stateMachine.ts
        drag.ts
```

职责划分：

- `src/main`：Electron 主进程，负责窗口、托盘、系统能力。
- `src/preload`：暴露安全 IPC API。
- `src/renderer`：桌宠画面和交互。
- `assets/pets`：角色资源，可以后续扩展多个宠物。
- `docs`：开发说明和后续设计记录。

## 4. 宠物素材协议

`pet.json` 建议扩展成应用自己的 manifest：

```json
{
  "id": "hammer-dude",
  "displayName": "雷锤小人",
  "description": "A chibi cartoon desktop pet holding a Thor-like hammer.",
  "spritesheetPath": "spritesheet.webp",
  "atlas": {
    "columns": 8,
    "rows": 9,
    "cellWidth": 192,
    "cellHeight": 208,
    "width": 1536,
    "height": 1872
  },
  "states": {
    "idle": { "row": 0, "frames": 6, "fps": 6 },
    "runningRight": { "row": 1, "frames": 8, "fps": 10 },
    "runningLeft": { "row": 2, "frames": 8, "fps": 10 },
    "waving": { "row": 3, "frames": 4, "fps": 6 },
    "jumping": { "row": 4, "frames": 5, "fps": 8 },
    "failed": { "row": 5, "frames": 8, "fps": 6 },
    "waiting": { "row": 6, "frames": 6, "fps": 5 },
    "running": { "row": 7, "frames": 6, "fps": 7 },
    "review": { "row": 8, "frames": 6, "fps": 6 }
  }
}
```

渲染时按如下方式裁切：

- `sx = frameIndex * cellWidth`
- `sy = row * cellHeight`
- `sw = cellWidth`
- `sh = cellHeight`

Canvas 显示尺寸建议第一版使用 1:1，即 `192 x 208`。后续可支持缩放，例如 1.25x / 1.5x / 2x。

## 5. Electron 窗口设计

桌宠窗口配置建议：

```ts
new BrowserWindow({
  width: 192,
  height: 208,
  frame: false,
  transparent: true,
  resizable: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  hasShadow: false,
  webPreferences: {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
})
```

窗口行为：

- 默认显示在屏幕右下角。
- 窗口背景完全透明。
- 桌宠区域可拖拽。
- 鼠标右键打开菜单。
- 托盘菜单可控制退出、置顶、动作切换、设置。

第一版不建议默认点击穿透。点击穿透会影响拖拽和菜单，建议做成托盘菜单选项：

- 正常交互模式：可拖拽、可右键。
- 点击穿透模式：鼠标事件穿透到桌面，用快捷键或托盘恢复。

## 6. 动画播放方案

使用 `requestAnimationFrame` 驱动，但按每个状态的 `fps` 控制换帧。

核心数据：

```ts
type PetState =
  | 'idle'
  | 'runningRight'
  | 'runningLeft'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

interface AnimationState {
  row: number
  frames: number
  fps: number
}
```

播放逻辑：

1. 加载 spritesheet。
2. 根据当前状态找到 `row / frames / fps`。
3. 按时间累计切换 `frameIndex`。
4. `drawImage` 裁切对应 cell 到 Canvas。
5. 循环播放。

状态优先级建议：

```text
dragging > jumping > waving > failed > waiting > running > review > idle
```

状态切换建议：

- 默认 `idle`。
- 拖拽窗口时，如果横向移动速度为正，播放 `runningRight`。
- 横向移动速度为负，播放 `runningLeft`。
- 单击桌宠，播放 `waving` 一轮后回到 `idle`。
- 双击桌宠，播放 `jumping` 一轮后回到 `idle`。
- 托盘菜单可强制切换 `waiting / running / review / failed`。

## 7. 拖拽交互

推荐由渲染层监听鼠标事件，并通过 IPC 调主进程移动窗口。

流程：

1. `mousedown` 记录鼠标屏幕坐标和窗口坐标。
2. `mousemove` 计算偏移。
3. 通过 `window.api.moveBy(dx, dy)` 或 `window.api.setPosition(x, y)` 通知主进程。
4. 根据 `dx` 切换 `runningRight / runningLeft`。
5. `mouseup` 回到 `idle`。

注意：

- 不要使用 `-webkit-app-region: drag` 覆盖整个 Canvas，否则精细点击事件不好处理。
- Electron 主进程负责最终 `BrowserWindow.setPosition`。
- 需要做屏幕边界限制，避免宠物被拖出屏幕。

## 8. IPC 设计

预加载脚本只暴露必要 API：

```ts
contextBridge.exposeInMainWorld('desktopPet', {
  moveWindow: (x: number, y: number) => ipcRenderer.invoke('pet:move-window', x, y),
  getWindowPosition: () => ipcRenderer.invoke('pet:get-window-position'),
  setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke('pet:set-always-on-top', value),
  quit: () => ipcRenderer.invoke('app:quit')
})
```

安全要求：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- 渲染进程不直接访问 Node 文件系统。
- IPC channel 使用固定白名单。

## 9. 托盘和菜单

托盘菜单第一版：

```text
雷锤小人
---
动作
  待机
  挥手
  跳跃
  等待
  工作中
  完成检查
  失败
---
始终置顶 [x]
点击穿透 [ ]
开机启动 [ ]
---
退出
```

右键桌宠菜单可以更轻：

```text
挥手
跳一下
置顶 / 取消置顶
隐藏到托盘
退出
```

## 10. 配置存储

建议用一个简单 JSON 配置文件存储用户偏好：

```json
{
  "petId": "hammer-dude",
  "position": { "x": 1200, "y": 700 },
  "scale": 1,
  "alwaysOnTop": true,
  "clickThrough": false,
  "launchAtStartup": false
}
```

存储位置：

- Windows：`app.getPath('userData')/settings.json`

主进程启动时读取配置，窗口移动后节流保存。

## 11. 第一版开发里程碑

### M1：项目初始化

- 初始化 Electron + Vite + TypeScript。
- 创建透明无边框窗口。
- 加载本地 renderer 页面。

验收：

- 应用启动后显示一个透明窗口。
- DevTools 可在开发模式打开。

### M2：素材接入

- 将 `hammer-dude` 资源放入 `assets/pets/hammer-dude`。
- 编写 manifest 读取逻辑。
- Canvas 播放 `idle` 动画。

验收：

- 桌面显示雷锤小人待机动画。
- 背景透明，无黑底或白底。

### M3：交互动作

- 支持拖拽移动。
- 拖拽时按方向播放左右跑。
- 单击挥手，双击跳跃。

验收：

- 拖动流畅。
- 松手回到 idle。
- 点击动作会播放一轮再回 idle。

### M4：托盘和菜单

- 托盘图标。
- 托盘菜单切换动作。
- 退出应用。
- 置顶开关。

验收：

- 没有任务栏按钮。
- 托盘能控制应用。

### M5：设置和打包

- 保存窗口位置和置顶状态。
- electron-builder 打包 Windows 安装包。
- 生成便携版或安装版。

验收：

- 关闭重开后位置保持。
- 打包后的 exe 可独立运行。

## 12. 打包方案

使用 `electron-builder`。

建议 Windows 配置：

```json
{
  "build": {
    "appId": "com.local.desktopPets",
    "productName": "Desktop Pets",
    "directories": {
      "output": "release"
    },
    "files": [
      "dist/**",
      "dist-electron/**",
      "assets/**",
      "package.json"
    ],
    "win": {
      "target": ["nsis", "portable"]
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true
    }
  }
}
```

## 13. 已知风险和处理

### 透明窗口黑边

可能原因：

- Renderer 背景不是透明。
- Canvas 清屏颜色不透明。
- BrowserWindow 没有启用 `transparent: true`。

处理：

- CSS 设置 `html, body { background: transparent; }`
- Canvas 每帧使用 `clearRect`，不要填充背景。

### 拖拽和点击穿透冲突

处理：

- 第一版默认不启用点击穿透。
- 点击穿透只通过托盘菜单开启。
- 开启后托盘菜单提供关闭入口。

### 高 DPI 缩放模糊

处理：

- Canvas 内部尺寸乘以 `devicePixelRatio`。
- CSS 尺寸保持逻辑大小。
- `imageSmoothingEnabled = true` 或按用户偏好关闭。

### 动作尺寸跳动

素材本身每帧已居中在 `192 x 208` cell 内。播放时不要按透明 bbox 重新裁切，必须固定按 cell 裁切。

## 14. 当前开发基线

### Python Runtime 注释约定

Python Runtime 的代码必须重视注释质量：

- 每个类和方法都应有简洁的中文 docstring，说明职责、输入输出或生命周期行为。
- SQLite 迁移、鉴权、SSE 事件编排、工具调用、异步任务和敏感信息过滤等复杂逻辑，必须在关键分支前补充中文注释。
- 注释应解释“为什么这样做”和安全/并发约束，不重复描述显而易见的语法。
- 新增 Runtime 模块应先写模块级职责说明，再实现具体逻辑。
- 修改行为时同步更新注释，避免注释与实际协议或数据流不一致。

项目要求 Node.js `22.12+`。开发前安装依赖：

```powershell
npm.cmd install
```

如果当前网络无法访问 Electron 的 GitHub release，可仅在当前 PowerShell 会话设置下载镜像：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm.cmd install
```

Electron 安装脚本仍会使用 npm 包内的官方 checksum 校验下载内容。不要把镜像地址写入全局 npm 配置或提交任何代理凭据。

常用命令：

```powershell
npm.cmd run dev
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check
```

### Windows 打包操作（提交前）

以下命令均在项目根目录的 PowerShell 中执行。Windows 下统一使用 `npm.cmd`，可以避免 PowerShell 的脚本执行策略拦截 `npm.ps1`。

1. 安装 Node.js `22.12+`，然后安装前端依赖：

```powershell
npm.cmd install
```

2. 首次使用或 Python 依赖有变更时，创建并更新 Runtime 虚拟环境：

```powershell
python -m venv python-runtime\.venv
python-runtime\.venv\Scripts\python.exe -m pip install -r python-runtime\requirements.lock
```

3. 生成 Windows 解包版（开发测试最常用）：

```powershell
npm.cmd run pack
```

`pack` 会依次执行前端构建、PyInstaller Runtime 构建和 `electron-builder --dir`。成功后运行：

```powershell
Start-Process .\release\win-unpacked\PetDock.exe
```

解包版产物目录为 `release\win-unpacked`，可直接用于本机验收或压缩分发。

`build:runtime` 统一通过 `tools/build_runtime.mjs` 调用 PyInstaller。该脚本会在 Windows 构建环境中把 System32 放到 `Path` 首位，防止 JDK 等工具目录中的旧版 `MSVCP140.dll`、`VCRUNTIME140.dll` 被误打入 Runtime；不要把脚本改回未经环境整理的裸 PyInstaller 命令。

4. 打包安装程序和便携版（需要发布给其他用户时使用）：

```powershell
npm.cmd run dist
```

产物位于 `release` 目录，通常包括 `PetDock Setup <version>.exe` 和 `PetDock Portable <version>.exe`。仅修改代码后准备提交时不需要执行 `dist`，执行 `pack` 并通过解包版验证即可。

5. 打包后运行助手冒烟测试：

```powershell
npm.cmd run test:e2e:assistant:packaged
```

测试通过会输出 `ASSISTANT_SMOKE_OK`，并在 `outputs` 目录生成截图。

打包故障处理：

- 执行前先关闭正在运行的 `PetDock.exe`，避免 Windows 锁定 `release\win-unpacked` 内的文件。
- 如果 PyInstaller 报 `WinError 5`（常见于读取用户 Python site-packages），使用“以管理员身份运行”的 PowerShell 重试 `npm.cmd run pack`；不要修改代码或把用户目录依赖复制进仓库。
- 如果 Electron 或 electron-builder 下载失败，仅在当前 PowerShell 会话设置镜像后重试：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm.cmd run pack
```

- `dist`、`release`、`python-runtime\build`、`python-runtime\dist` 和 `outputs` 是构建产物，不应提交到 Git；提交前用 `git status --short` 检查待提交文件。

提交功能代码前至少运行 `npm.cmd run check`，该命令依次执行严格类型检查、单元测试和生产构建。

安全基线：

- Renderer 必须保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 不允许重新添加全局 `no-sandbox`；如遇透明窗口兼容问题，应先定位具体原因。
- 新窗口使用独立 preload，只暴露完成该窗口职责所需的 IPC API。
- IPC handler 必须校验调用窗口身份并验证外部输入。
- 密钥和用户隐私数据不得写入仓库、普通配置文件或日志。

AI 助手后续开发以 `docs/AI_ASSISTANT_ARCHITECTURE.md` 和 `docs/AI_ASSISTANT_PROGRESS.md` 为准；附件对话、文件输出、联网搜索、复杂文档和多文件修改必须遵循 `docs/CONVERSATION_RESOURCE_CAPABILITIES.md`；阶段 5 Skill 系统必须遵循 `docs/SKILL_SYSTEM_DEVELOPMENT.md`；涉及 RAG 检索优化时还必须遵循 `docs/RAG_RETRIEVAL_OPTIMIZATION.md`，本地模型来源以 `docs/EMBEDDING_MODEL_WHITELIST.md` 和机器可读白名单为准。

对话资源能力当前进度：C1、C1.1 已完成，C2、C3 已完成实现并处于验收收尾，C4、C5 未开始。附件开发和回归可使用 `npm.cmd run test:e2e:assistant`；该脚本包含不支持格式投放后自动展开与错误提示、真实文本文件拖拽、草稿/历史预览、只附件发送、来源展示和联网设置脱敏状态验证，打包后使用 `npm.cmd run test:e2e:assistant:packaged` 验证同一链路。C2 可用 `$env:PETDOCK_SMOKE_DEV='1'; $env:PETDOCK_SMOKE_C2_ONLY='1'; node tools\assistant_smoke.mjs` 聚焦验证 Artifact 生成、卡片、预览和删除。C3 默认使用火山引擎豆包搜索，Brave Search 作为兼容 Provider；可用 `$env:PETDOCK_SMOKE_REAL_WEB='1'; $env:PETDOCK_SMOKE_EXECUTABLE='release\win-unpacked\PetDock.exe'; node tools\assistant_smoke.mjs` 复验当前脱敏配置的真实连接。真实火山连接和解包版设置 E2E 已通过，本地可控 Provider 的开发版/打包版完整搜索、抓取和引用 E2E 仍待验收，因此 C2、C3 暂不标记为 Done。

## 15. AI Assistant Runtime

首次开发需要创建 Python 虚拟环境并安装锁定依赖：

```powershell
python -m venv python-runtime\.venv
python-runtime\.venv\Scripts\python.exe -m pip install -r python-runtime\requirements.lock
```

默认未配置模型密钥时使用离线 mock backend。接入 OpenAI-compatible 模型时，在启动 PetDock 的同一 PowerShell 会话中设置：

```powershell
$env:PETDOCK_ASSISTANT_BACKEND = 'auto'
$env:PETDOCK_LLM_API_KEY = '<api-key>'
$env:PETDOCK_LLM_BASE_URL = '<optional-base-url>'
$env:PETDOCK_LLM_MODEL = '<model-name>'
npm.cmd run dev
```

不要把 API key 写入仓库、`settings.json`、命令输出或截图。Renderer 只能看到 Runtime 状态和对话事件。

Runtime 与阶段 1 验证命令：

```powershell
npm.cmd run test:runtime
npm.cmd run build:runtime
npm.cmd run test:e2e:assistant
npm.cmd run test:e2e:assistant:dev
npm.cmd run pack
npm.cmd run test:e2e:assistant:packaged
npm.cmd run test:e2e:assistant:langchain
```

`npm.cmd run check` 会执行 TypeScript 类型检查、TypeScript 单元测试、Python Runtime 测试和 Electron 生产构建。

C2 离线 Mock 可使用以下明确指令生成 Artifact：

```text
生成文件 | 文件名=report.md | 格式=md | 内容=# 报告
```

Runtime 只在 Main 注入的 Artifact 根目录生成白名单 UTF-8 文本文件，单个文件上限 25 MB；Renderer 只提交 Artifact ID 和会话 ID。保存时 Main 打开原生“另存为”对话框，再从 Runtime 获取完整内容并执行同目录临时写入和可恢复覆盖。当前单元/集成测试覆盖六种基础格式、文件名清理、会话隔离、生成/预览/读取/保存标记/清理、新建/覆盖和符号链接拒绝；原生保存对话框 E2E 稳定前仍需人工核对取消、另存和覆盖行为，不能只以生成/预览通过代替完整保存验收。

阶段 2 工具调用测试可在离线 Mock Runtime 中使用以下明确指令：

```text
打开网页 https://example.com
打开应用 notepad
打开文件夹 C:\\Users\\<用户名>\\Documents
```

助手输入框支持 `~` 快捷命令菜单：输入 `~` 后可选择“打开网站”或“打开应用”，再输入目标即可发送。菜单支持鼠标、上下方向键、回车和 Esc。输入 `$` 会检索本地已启用 Skill；选择后显示 Skill 标识，发送时提交结构化 `skillId`，不会把 Skill 正文拼接到用户输入。

应用和文件/文件夹会显示确认卡片。Renderer 只回传用户决策，工具参数由 Electron Main 保存并重新校验。`open_url` 只允许 `http` 和 `https`；未知应用、无效路径和未注册工具会被策略拒绝。工具审计日志位于 PetDock 用户数据目录下的 `logs/tools.log`。

助手与桌宠使用同一个透明无边框窗口。收起时窗口保持桌宠尺寸；展开时窗口根据可用空间向左或向右扩大，桌宠和输入框在同一坐标系内保持底部锚点。拖动展开状态的桌宠会移动整个组合窗口，松开后再重新判断停靠方向。对话区只绘制消息气泡，其余像素保持透明并允许鼠标穿透。助手提供五套可切换主题，主题 ID 保存在 `settings.json` 的 `assistantTheme` 字段，主题 CSS 只能修改可见控件，不得给 `html`、`body` 或桌宠画布添加背景。`test:e2e:assistant:dev` 会检查 CSS、透明背景、两种展开方向、锚点、收起尺寸和主题切换。

阶段 3 的助手记忆数据保存在同一用户数据目录下的 `assistant.db`。SQLite 由 Python Runtime 独占管理，Electron Main 只通过带启动令牌的 Runtime 接口访问。数据库保存会话消息、明确记录的用户偏好、成功使用过的应用和目录以及工具执行日志；返回 Renderer 的目录和工具参数会先脱敏。助手面板中的“记忆管理”提供会话历史恢复、长期记忆查看、使用记录查看、单条删除、分类清理和全部清理。

在线模型可以使用 Runtime 内部的 `remember_preference`、`forget_memory` 和 `list_memories` 工具。每轮主任务完成后，独立记忆分析器会异步分析本轮对话并生成待确认候选，不阻塞主代理回复；用户在“长期记忆”页点击“记住”后候选才会写入正式记忆。离线 Mock 仅使用明确记忆表达作为兜底。

阶段 4 的知识库业务数据保存在用户数据目录的 `knowledge.db`，Chroma 向量索引保存在 `rag/chroma`。用户只能通过助手内“知识库”界面调用 Electron Main 原生目录选择器授权来源；Renderer 不接触真实路径。管理界面支持索引进度、暂停、继续、刷新和删除，删除索引不会删除来源文件。

当前索引支持 UTF-8 文本、Markdown、JSON/YAML/TOML、常见源码和脚本文件。默认跳过隐藏目录、构建产物、依赖目录、符号链接、敏感凭据文件、超过 2 MB 的文件和非 UTF-8 内容。检索使用 SQLite FTS5 与 Chroma 向量结果的 Weighted RRF 和多信号准入；Hash Embedding 是零下载离线基线，用户也可以在知识库界面选择白名单本地 ONNX 模型或配置 OpenAI-compatible 在线 Embedding。不同 Provider 使用独立 Index Signature 和 Chroma collection，失败时只能降级到独立 Hash 影子索引及 FTS5。

知识库前的复选框决定该库是否参与对话检索，默认不选；选择结果由 Electron Main 持久化到 `settings.json`，用户主动勾选后命中片段才可能进入当前模型上下文。Runtime 会通过独立 `retrieval_sources` 事件返回来源，Renderer 展示知识库、相对路径和片段。检索到的文档始终按不可信资料处理，其中的指令不能授权系统工具。

### 阶段 5 Skill 系统

Skill 状态保存在 PetDock 用户数据目录的 `skills.db`，安装包位于 `skills/packages`。Runtime 启动或刷新时只解析各 Skill 的 `name` 和 `description`；只有用户通过 `$` 明确选择或 Agent 调用 `activate_skill` 后才读取目标 `SKILL.md` 正文，`references/` 和 `assets/` 资源继续通过 `read_skill_resource` 按需读取。

本地 Skill 必须经 Electron Main 原生目录选择器授权。GitHub 安装只接受无凭据的 `https://github.com/{owner}/{repo}` 或 `/tree/{ref}/{subdirectory}` 公共仓库 URL；Runtime 会把来源固定到 commit，限制下载和解压大小，并拒绝路径穿越、符号链接、Windows 保留名及大小写重名。Renderer 只接收脱敏候选和短期预览令牌，不接触真实安装路径。

首版兼容纯指令、引用资料和静态资源型 Agent Skills。存在 `scripts/`、外部命令或额外依赖的包会显示为 `instruction-only`，可以使用其指令和安全资源，但不会执行第三方脚本、安装依赖或绕过 Electron Main 工具权限。`skill.json` 中的权限声明只会缩小可用能力，不会自动授权系统操作。

阶段 5 重点验证命令：

```powershell
python-runtime\.venv\Scripts\python.exe -m pytest -q python-runtime\tests\test_skills.py
npm.cmd run check
npm.cmd run build:runtime
npm.cmd run test:runtime:packaged
npm.cmd run pack
npm.cmd run test:e2e:assistant:packaged
```
