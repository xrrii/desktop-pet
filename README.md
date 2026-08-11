# PetDock

PetDock 是一个基于 Electron 的透明桌面宠物应用，并集成了本地 Python AI Assistant Runtime。桌宠负责常驻桌面、动画、拖拽、托盘和助手入口；AI 助手负责流式对话、受控工具调用、记忆、知识库检索、附件、Artifact 文件生成、联网搜索和 Skill 扩展。

当前项目优先支持 Windows，本地开发与打包流程也主要按 Windows PowerShell 设计。

## 当前能力

### 桌面宠物

- 透明、无边框、可置顶的 Electron 桌面窗口。
- Canvas 播放 spritesheet 图集动画，默认单帧尺寸为 `192 x 208`。
- 支持拖拽移动，并把桌宠限制在当前屏幕工作区内。
- 支持托盘菜单和桌宠右键菜单。
- 支持多桌宠资源切换，内置资源位于 `assets/pets`。
- 支持待机、挥手、跳跃、等待、工作中、完成检查、失败等动作。
- 支持点击穿透、始终置顶、重置位置、开机启动等设置。

### AI 助手

- 双击桌宠展开助手面板，收起后仍保持桌宠常驻。
- Electron Main 启动本地 Python Runtime，使用 `127.0.0.1:<random-port>` + 启动令牌通信。
- 未配置模型密钥时使用离线 Mock 后端；配置 OpenAI-compatible 模型后使用 LangChain 后端。
- 支持流式回复、Markdown 渲染、任务取消和 Runtime 状态展示。
- 支持受控工具调用：
  - `open_url`：打开 `http/https` 网页，自动执行。
  - `open_app`：打开白名单应用 `notepad`、`explorer`、`calculator`，需要用户确认。
  - `open_file_or_folder`：打开存在的文件或目录，需要用户确认。
  - `search_web` / `fetch_web_page`：在联网搜索启用后由 Main 统一执行。
- 支持附件对话：单轮最多 10 个文本、PDF、DOCX、XLSX、PPTX 或条件式图片附件，真实路径不暴露给 Renderer；会话资料集超过 12,000 tokens 时自动使用独立临时索引进行多文件只读分析。
- 支持 Artifact 生成：Runtime 只在应用受控目录写入白名单文本格式，Main 通过原生“另存为”对话框保存到用户选择位置。
- 支持记忆管理：会话历史、长期偏好、常用应用/目录、工具日志和记忆候选确认。
- 支持本地知识库：目录授权、索引、暂停、恢复、删除索引、来源引用。
- 支持 Embedding 配置：默认 Hash 离线基线，也可切换本地 ONNX 白名单模型或在线 OpenAI-compatible Embedding。
- 支持 Skill 系统：本地目录或 GitHub 公共仓库预览安装、启用/禁用、卸载、按需加载 `SKILL.md`。
- 支持联网搜索配置：当前 Provider 包括火山引擎豆包搜索和 Brave Search，API Key 使用 Electron `safeStorage` 加密保存。

## 技术栈

- Electron 43
- electron-vite 5
- TypeScript 5
- Vite 7
- Vitest
- Python 3.11+
- FastAPI + Uvicorn
- LangChain OpenAI-compatible 后端
- SQLite / FTS5
- Chroma
- ONNX Runtime
- PyInstaller
- electron-builder

## 项目结构

```text
desktop-pet/
  assets/
    app/                 应用图标
    assistant/           助手静态配置，例如 Embedding 白名单
    pets/                内置桌宠资源
  docs/                  设计、开发和阶段文档
  python-runtime/        Python Assistant Runtime
    app.py               Runtime 进程入口
    petdock_runtime/
      api/               FastAPI 路由与服务资源装配
      agent/             Agent 契约、编排、后端适配器和工具目录
      attachments/       会话附件存储、临时索引和资料集分析
      artifacts/         生成文件生命周期
      documents/         文档解析与分块
      knowledge/         长期知识库服务与元数据存储
      memory/            会话记忆与偏好提取
      providers/         Embedding 等外部能力适配器
      rag/               检索规划、评分与向量存储
      skills/            Skill 清单、注册、安装与持久化
      vision/            图片理解能力适配器
    tests/               Runtime 测试
  src/
    main/                Electron Main：窗口、托盘、安全边界、Runtime 管理
    preload/             受限 IPC API
    renderer/            桌宠和助手 UI
    shared/              Main / Preload / Renderer 共用类型
  tools/                 构建、冒烟测试和检索评估脚本
```

## 环境要求

- Windows 10/11
- Node.js `22.12+`
- Python `3.11+`
- npm

建议在 Windows 下使用 PowerShell，并优先执行 `npm.cmd`，避免 PowerShell 脚本策略拦截 `npm.ps1`。

## 快速开始

### 1. 安装 Node 依赖

```powershell
npm.cmd install
```

如果 Electron 或 electron-builder 下载失败，可以只在当前 PowerShell 会话设置镜像后重试：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm.cmd install
```

不要把镜像地址、代理凭据或 API Key 写入仓库。

### 2. 初始化 Python Runtime 环境

```powershell
python -m venv python-runtime\.venv
python-runtime\.venv\Scripts\python.exe -m pip install -r python-runtime\requirements.lock
```

### 3. 启动开发模式

```powershell
npm.cmd run dev
```

开发模式下，如果没有配置模型密钥，助手会以离线 Mock 后端工作。Mock 后端可以验证 UI、附件、工具确认、知识库和 Artifact 链路，但不会产生真实模型推理能力。

### 4. 可选：接入 OpenAI-compatible 模型

在启动 PetDock 的同一个 PowerShell 会话中设置：

```powershell
$env:PETDOCK_ASSISTANT_BACKEND = 'auto'
$env:PETDOCK_LLM_API_KEY = '<api-key>'
$env:PETDOCK_LLM_BASE_URL = '<optional-openai-compatible-base-url>'
$env:PETDOCK_LLM_MODEL = '<model-name>'
npm.cmd run dev
```

默认模型名为 `gpt-4o-mini`。`PETDOCK_ASSISTANT_BACKEND=auto` 时，有 `PETDOCK_LLM_API_KEY` 使用 LangChain 后端，否则使用 Mock 后端。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm.cmd run dev` | 启动 Electron 开发模式 |
| `npm.cmd run debug` | 启动开发模式并打开 DevTools |
| `npm.cmd run typecheck` | TypeScript 类型检查 |
| `npm.cmd test` | 运行 Vitest 单元测试 |
| `npm.cmd run test:runtime` | 运行 Python Runtime 测试 |
| `npm.cmd run test:retrieval` | 运行 RAG 检索评估 |
| `npm.cmd run build` | 构建 Electron Main / Preload / Renderer |
| `npm.cmd run build:runtime` | 使用 PyInstaller 构建 `petdock-assistant.exe` |
| `npm.cmd run check` | 执行类型检查、单测、Runtime 测试、检索评估和构建 |
| `npm.cmd run pack` | 构建解包版 Windows 应用 |
| `npm.cmd run dist` | 构建安装包和便携版 |

## 打包

首次打包前需要先完成 Node 依赖和 Python 虚拟环境初始化。

生成本地解包版：

```powershell
npm.cmd run pack
```

产物目录：

```text
release/win-unpacked/PetDock.exe
```

生成安装包和便携版：

```powershell
npm.cmd run dist
```

`dist` 会生成 NSIS 安装包和 portable 可执行文件，输出到 `release` 目录。

## 验证

提交功能代码前至少运行：

```powershell
npm.cmd run check
```

Runtime 打包后可以验证可执行文件：

```powershell
npm.cmd run test:runtime:packaged
```

助手端到端冒烟测试：

```powershell
npm.cmd run test:e2e:assistant
npm.cmd run test:e2e:assistant:packaged
npm.cmd run test:e2e:assistant:c5
npm.cmd run test:e2e:assistant:c5:packaged
```

如果要验证 LangChain 后端链路：

```powershell
npm.cmd run test:e2e:assistant:langchain
```

## 配置和本地数据

Electron 会把用户配置和 Runtime 数据放到 `app.getPath('userData')` 对应目录，主要包括：

- `settings.json`：桌宠 ID、位置、缩放、置顶、点击穿透、助手主题和选中的知识库。
- `assistant.db`：会话、记忆、附件元数据、Artifact 索引和工具日志。
- `knowledge.db`：知识库业务数据。
- `rag/chroma`：Chroma 向量索引。
- `skills.db`：Skill 状态。
- `skills/packages`：已安装 Skill 包。
- `assistant/attachments`：受控附件副本。
- `assistant/session-index`：按活动 Embedding Profile 隔离的会话附件临时索引。
- `assistant/artifacts`：应用内生成文件。
- `assistant/web-search*.json/bin`：联网搜索配置和加密 API Key。
- `pets`：用户自定义桌宠资源目录。

## 关键环境变量

| 变量 | 说明 |
| --- | --- |
| `PETDOCK_ASSISTANT_BACKEND` | `auto`、`mock` 或 `langchain` |
| `PETDOCK_LLM_API_KEY` | OpenAI-compatible 聊天模型密钥 |
| `PETDOCK_LLM_BASE_URL` | 可选的 OpenAI-compatible Base URL |
| `PETDOCK_LLM_MODEL` | 聊天模型名，默认 `gpt-4o-mini` |
| `PETDOCK_PYTHON` | 开发模式下指定 Python 解释器 |
| `PETDOCK_EMBEDDING_PROVIDER` | Runtime 内部使用的 `hash`、`local` 或 `online` |
| `PETDOCK_EMBEDDING_API_KEY` | 在线 Embedding Provider 密钥 |
| `PETDOCK_EMBEDDING_BASE_URL` | 在线 Embedding Base URL |
| `PETDOCK_EMBEDDING_MODEL` | 在线 Embedding 模型名 |
| `PETDOCK_EMBEDDING_DIMENSIONS` | 在线 Embedding 维度 |

`PETDOCK_RUNTIME_TOKEN`、数据库路径、附件根目录、Artifact 根目录、Skill 根目录等由 Electron Main 在启动 Runtime 时注入，普通开发不需要手动设置。

## 桌宠资源协议

桌宠资源目录形如：

```text
assets/pets/<pet-id>/
  pet.json
  spritesheet.webp
```

`pet.json` 最小示例：

```json
{
  "id": "hammer-dude",
  "displayName": "雷锤小人",
  "description": "A chibi cartoon desktop pet based on the supplied portrait, holding a Thor-like hammer.",
  "spritesheetPath": "spritesheet.webp"
}
```

未声明 `atlas` 和 `states` 时使用默认协议：

- 图集：`8` 列 x `9` 行
- 单帧：`192 x 208`
- 总尺寸：`1536 x 1872`
- 状态：`idle`、`runningRight`、`runningLeft`、`waving`、`jumping`、`failed`、`waiting`、`running`、`review`

用户自定义桌宠可以放到用户数据目录下的 `pets` 文件夹，也可以通过托盘菜单打开该目录。

## 安全边界

- Renderer 不直接访问 Node 文件系统、模型密钥、Runtime 端口或启动令牌。
- Preload 只暴露固定白名单 IPC API。
- Electron Main 校验 IPC 调用来源，重新计算所有外部工具调用风险。
- Python Runtime 可以规划工具，但系统操作必须回到 Electron Main 执行。
- 文件、应用、联网、Artifact、附件、知识库和 Skill 都有独立的校验与脱敏边界。
- API Key 不写入仓库、普通配置、日志、IPC payload 或截图。
- 知识库删除只删除索引数据，不删除用户来源文件。
- Artifact 删除只删除应用内受控副本，不影响用户已另存的外部文件。

## 参考文档

- `docs/README.md`：文档索引、状态和推荐阅读顺序。
- `docs/guides/DEVELOPMENT.md`：开发、测试和打包基线。
- `docs/architecture/AI_ASSISTANT_ARCHITECTURE.md`：AI 助手总体架构。
- `docs/architecture/MANAGED_SERVICE_IMPLEMENTATION_PLAN.md`：BYOK 与官方服务双模式实施方案。

## 许可证与隐私

- PetDock 自有代码和文档使用 [MIT License](LICENSE)，版权主体为 `xrrii`。
- 图片、图标和桌宠动画不自动适用 MIT，逐文件状态见 [素材授权说明](ASSET_LICENSES.md)。
- 第三方依赖摘要见 [第三方依赖声明](THIRD_PARTY_NOTICES.md)，完整许可证由
  `npm.cmd run licenses` 生成到 `THIRD_PARTY_LICENSES.txt`。
- 第三方在线服务和数据范围见 [第三方在线服务说明](THIRD_PARTY_SERVICES.md)。
- 当前本地 BYOK 版本的数据处理方式见 [隐私说明](PRIVACY.md)。

## 开发约定

- TypeScript、Python 和文档统一优先使用 UTF-8 无 BOM。
- 新增 Runtime 类、方法和复杂逻辑应补充中文注释或 docstring。
- 涉及安全边界、文件生命周期、权限确认和索引流程时，需要保留可排查的日志。
- 不提交 `release`、`dist`、`outputs`、`python-runtime/build`、`python-runtime/dist` 等构建产物。
- 不提交任何模型密钥、搜索 API Key、用户数据目录内容或本地索引数据。
