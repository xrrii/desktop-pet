# PetDock Skill 系统开发文档

## 1. 文档状态

```text
文档版本：1.1
状态：Implemented
适用阶段：AI 助手阶段 5
更新时间：2026-07-26
```

本文档是 PetDock AI 助手阶段 5 Skill 系统的实现基线。后续协议、存储、Runtime、Electron Main、Renderer、测试和打包工作均以本文档为准。

关联文档：

- `docs/AI_ASSISTANT_ARCHITECTURE.md`
- `docs/AI_ASSISTANT_PROGRESS.md`
- `docs/DEVELOPMENT.md`

如果实现过程中需要改变本文档中标记为“已决策”的内容，必须先更新本文档并记录原因，再修改代码。

## 2. 背景与目标

PetDock 已完成普通聊天、受控工具调用、长期记忆和本地 RAG。阶段 5 在现有安全边界上增加可安装、可启停、可审计的 Skill 系统，使用户能够通过本地目录或 GitHub 公共仓库扩展助手能力。

阶段 5 的核心目标：

- 兼容以 `SKILL.md` 为入口的 Agent Skills 风格开源 Skill。
- 支持从本地目录和 GitHub 公共仓库安装 Skill。
- 支持单仓库单 Skill 和单仓库多 Skill。
- 支持安装、启用、禁用、刷新、更新和卸载。
- 支持 `$` 菜单显式选择 Skill。
- 支持 Agent 根据 Skill 名称和描述自主激活 Skill。
- 使用渐进式披露，避免把所有 Skill 正文和资源塞入模型上下文。
- Skill 不能绕过 Electron Main 的工具权限、用户确认和审计链路。
- 安装或刷新后无需重启 PetDock 和 Python Runtime。

阶段 5 不等同于长期路线中的“v5 重 Agent”。多 Agent、后台长任务、跨设备同步和远程控制不属于本阶段。

## 3. 已决策范围

### 3.1 首版完整支持

- `SKILL.md` + YAML frontmatter。
- 可选的 `scripts/`、`references/`、`assets/` 目录识别。
- 可选的 PetDock 扩展清单 `skill.json`。
- 纯指令型 Skill。
- 引用资料型 Skill。
- 静态资源型 Skill。
- 本地目录安装。
- GitHub 公共仓库 HTTPS 安装。
- 手动检查和确认更新。
- Skill 元数据检索和渐进式披露。
- Skill 生命周期、调用状态和错误日志。

### 3.2 首版有限兼容

包含脚本、外部命令或额外依赖的开源 Skill 可以安装和展示，但只有指令、引用资料和静态资源部分可直接使用。管理界面必须明确展示兼容性状态和缺失能力。

示例状态：

```text
compatible             可直接使用
instruction-only       指令部分可用，脚本不会执行
missing-dependencies   缺少外部依赖
unsupported-runtime    使用当前不支持的运行方式
invalid                结构或元数据无效
```

### 3.3 首版明确不支持

- 自动执行第三方 Python、JavaScript、PowerShell、CMD 或二进制程序。
- Skill 自行执行任意 Shell 命令。
- Skill 自行安装 pip、npm 或系统依赖。
- 私有 GitHub 仓库和 GitHub Token。
- GitLab、Gitee 或任意 Git 仓库地址。
- Claude Plugin、MCP Server、Dify/Coze 插件协议。
- 远程插件市场和后台静默更新。
- Skill 签名和远程信任服务。
- Skill 嵌套调用其他 Skill。
- Skill 直接读写任意本地文件。

脚本执行必须在后续阶段完成独立的隔离、权限和资源限制设计后再开放。仅使用子进程并不能限制脚本以当前用户身份访问文件和网络，因此不能作为安全沙箱。

## 4. 术语

```text
Skill Package
  一个包含 SKILL.md 及可选资源目录的技能包。

Skill Source
  Skill 的安装来源，首版为 local 或 github。

Skill Metadata
  从 YAML frontmatter 读取的 name 和 description。

Skill Instructions
  SKILL.md 中 YAML frontmatter 之后的 Markdown 正文。

Skill Resource
  Skill 根目录下 references/ 或 assets/ 中的文件。

Skill Activation
  当前任务选择某个 Skill，并加载其完整 Instructions。

Normalized Skill
  Runtime 将标准 Skill 和 PetDock 扩展 Skill 归一化后的内部结构。
```

## 5. Skill 包规范

### 5.1 标准目录

```text
weekly-report/
  SKILL.md
  skill.json          可选
  scripts/            可选，首版不执行
  references/         可选，按需读取
  assets/             可选，不自动进入模型上下文
```

目录和文件名区分大小写时，入口仍必须准确命名为 `SKILL.md`。扫描器不得把其他 Markdown 文件猜测为 Skill 入口。

### 5.2 SKILL.md frontmatter

最小合法示例：

```markdown
---
name: weekly-report
description: 根据工作记录整理结构化周报，适用于周报生成和工作总结。
---

# 周报生成

根据用户提供的工作记录生成本周完成事项、风险和下周计划。
```

字段约束：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `name` | 是 | 1 至 64 个字符；仅小写字母、数字和连字符；不能以连字符开头或结尾 |
| `description` | 是 | 1 至 1024 个字符；必须描述用途和适用场景 |

frontmatter 必须位于文件开头，使用 `---` 包围。首版只读取 `name` 和 `description`，未知字段保留但不参与权限判断。

解析器必须使用安全 YAML API，禁止构造任意对象。启动扫描只以流式方式读取文件开头，达到 frontmatter 大小上限仍未找到结束标记时直接判为无效，不能为了查找结束标记而读取整个 `SKILL.md` 正文。

### 5.3 PetDock 扩展清单

`skill.json` 是可选扩展，不能替代 `SKILL.md`，也不能覆盖 `name` 和 `description`。

```json
{
  "schemaVersion": 1,
  "permissions": ["knowledge.read"],
  "minimumPetDockVersion": "0.1.1",
  "parameters": {
    "type": "object",
    "properties": {
      "topic": {
        "type": "string",
        "description": "要处理的主题"
      }
    },
    "additionalProperties": false
  }
}
```

首版权限枚举：

```text
knowledge.read
memory.read
memory.write
network.read
tool.open_url
tool.open_app
tool.open_path
```

权限声明只用于缩小 Skill 可申请的能力，不能替代 Electron Main 的最终策略判断。

### 5.4 内部归一化结构

TypeScript 和 Python 使用等价结构：

```ts
interface NormalizedSkill {
  id: string
  name: string
  description: string
  rootPath: string
  instructionsPath: string
  source: SkillSource
  permissions: SkillPermission[]
  compatibility: SkillCompatibility
  enabled: boolean
  contentHash: string
  installedAt: string
  updatedAt: string
}
```

`rootPath` 和 `instructionsPath` 只在 Main 和 Runtime 内部使用，永远不返回 Renderer。Renderer 只获得脱敏来源信息。

### 5.5 ID 与冲突规则

- 首版使用 frontmatter `name` 作为用户可见 ID。
- ID 比较不区分大小写，但合法名称本身必须为小写。
- 内置 Skill 和用户 Skill 不允许同名覆盖。
- 已安装 Skill 同名时必须进入更新或替换流程，不能静默创建第二份。
- GitHub 多 Skill 仓库内出现重复名称时，整个安装候选视为无效。
- Skill 名称不能与 Runtime 内部工具保留名称冲突。

## 6. 渐进式披露

渐进式披露是阶段 5 的强制要求，分为三个层级。

### 6.1 第一级：启动元数据

PetDock 启动、安装、更新或刷新 Skill 时：

- 只读取 `SKILL.md` 开头受限大小的 frontmatter。
- 只解析 `name` 和 `description` 进入内存注册表。
- 不读取 Markdown 正文。
- 不扫描资源文件内容。
- 不读取 `references/`、`assets/` 和 `scripts/` 内容。
- 不把任何 Skill 正文加入系统提示词。

Runtime 对模型提供紧凑的可用 Skill 目录：

```text
weekly-report：根据工作记录整理结构化周报。
project-review：检查项目结构、风险和待办事项。
```

启动注册和模型披露是两个概念：Runtime 可以持有全部已启用 Skill 的元数据，但每次模型请求只加入受预算限制的元数据集合。

### 6.2 元数据预算

- `$` 菜单始终在本地完整检索已启用 Skill，不消耗模型上下文。
- 元数据总长度未超过预算时，向模型披露全部 `name + description`。
- 超过预算时，根据用户输入做本地关键词检索，只披露最相关的 Skill。
- 模型仍可使用 `search_skills` 查询注册表，查询结果也只包含名称和描述。
- 元数据预算使用固定字符上限，不根据视口或 UI 状态变化。
- 排序必须确定性一致，避免相同输入在不同运行中产生随机 Skill 集合。

首版默认值：

```text
模型元数据预算：8,000 字符
单次候选上限：20 个 Skill
search_skills 返回上限：10 个 Skill
```

这些值集中定义在 Runtime 配置中，不散落在提示词和 UI 代码里。

### 6.3 第二级：激活完整指令

仅在以下情况加载完整 `SKILL.md` 正文：

- 用户通过 `$` 明确选择 Skill。
- 用户从 Skill 管理页点击使用。
- Agent 调用 `activate_skill`。

激活流程：

```text
请求激活 Skill
  -> Registry 校验存在、启用状态和内容摘要
  -> 校验当前任务尚未激活其他主 Skill
  -> 读取 SKILL.md 正文
  -> 检查正文大小和 UTF-8 编码
  -> 以受约束的 Skill Instructions 加入当前任务上下文
  -> 继续 Agent 推理
```

约束：

- 单次任务只能激活一个主 Skill。
- Skill 正文只对当前任务有效。
- Skill 指令优先级低于 PetDock 系统规则和权限策略。
- Skill 中声称“无需确认”“忽略系统规则”等内容无效。
- 任务完成、取消或失败后释放激活上下文。
- 会话历史只保存 Skill ID 和结果，不保存完整 Skill 正文副本。

### 6.4 第三级：按需读取资源

Skill 激活后仍不自动加载目录内容。Runtime 提供内部工具：

```text
read_skill_resource(skillName, resourcePath)
```

资源读取约束：

- 只允许读取当前已激活 Skill。
- 只允许 `references/` 和 `assets/` 下的相对路径。
- 拒绝绝对路径、`..`、符号链接和根目录逃逸。
- 文本资源必须为 UTF-8。
- 二进制资源不能直接注入模型文本上下文。
- 单文件和单任务累计读取量均有限制。
- 同一任务按内容摘要缓存已读取资源。
- `scripts/` 不能通过资源读取工具伪装成可执行内容。

首版默认值：

```text
SKILL.md 正文上限：256 KB
单个文本资源上限：512 KB
单次返回模型上限：64 KB
单任务资源累计上限：2 MB
```

## 7. Agent 工具注册与执行

### 7.1 工具目录与渐进式披露

固定工具 schema 统一维护在 `agent/tool_catalog.py`，执行逻辑按内部工具和 Electron Main 外部工具分离：

```text
Builtin OS Tools
+ Memory Tools
+ Skill Catalog Tools
= Tool Registry
```

Skill 不为每个包注册一份完整参数 schema，统一使用三个轻量内部工具：

```text
search_skills(query)
activate_skill(name)
read_skill_resource(skillName, resourcePath)
```

这样启动和每轮请求只需要披露 Skill 的名称、描述以及固定工具定义，不会把所有 Skill 的正文、参数和资源塞入上下文。

### 7.2 显式调用

Renderer 通过结构化字段提交 `$` 选择结果：

```ts
interface AssistantSkillInvocation {
  skillId: string
  input: string
}
```

显式调用不需要模型再次猜测 Skill，但 Runtime 仍必须校验 Skill 是否存在、已启用且内容未失效。

### 7.3 Agent 自主激活

普通聊天中：

1. 模型先看到有限的 `name + description`。
2. 如果需要其他候选，调用 `search_skills`。
3. 决定使用某个 Skill 后调用 `activate_skill`。
4. Runtime 加载正文并继续同一任务的模型推理。
5. Skill 需要系统工具时，继续走既有外部 ToolCall 流程。

### 7.4 有限轮次

为支持“搜索 Skill -> 激活 -> 读取资源 -> 调用系统工具 -> 汇总”，LangChain 后端需要从当前单轮实现重构为有限状态循环。

首版限制：

```text
最大 Agent 推理轮次：6
最大 Skill 激活次数：1
最大内部 Skill 工具调用：8
最大外部系统工具调用：3
沿用当前任务取消机制和 ToolCall 超时
```

达到限制时返回结构化错误，不继续递归调用。

## 8. 安装来源

### 8.1 本地目录

本地安装只能通过 Electron Main 原生目录选择器发起：

```text
Renderer 请求安装
  -> Main 打开目录选择器
  -> Main 获得真实路径
  -> Main 将授权路径提交给带启动令牌的 Runtime
  -> Runtime 安全扫描和候选发现
  -> Renderer 只显示脱敏候选
  -> 用户确认
  -> Runtime 校验预览令牌并原子安装
  -> Runtime 刷新注册表
```

Renderer 不能提交任意本地路径。

### 8.2 GitHub 公共仓库

首版支持：

```text
https://github.com/{owner}/{repository}
https://github.com/{owner}/{repository}/tree/{ref}/{subdirectory}
```

限制：

- 只接受 HTTPS。
- 页面域名只接受 `github.com`。
- API 只访问 `api.github.com`。
- 归档重定向只接受 `codeload.github.com`。
- `owner`、`repository`、`ref` 和子目录必须逐段校验。
- 首版 URL 中的 `ref` 只支持单路径段；包含 `/` 的分支名后续通过独立 ref 输入支持。
- 只支持公开仓库，不接收访问令牌。
- 安装前把 ref 解析成不可变 commit SHA。
- 下载和安装记录固定 commit SHA，不能只记录 `main`。

### 8.3 GitHub 下载流程

```text
Main 解析并规范化 URL
  -> Main 校验 HTTPS、github.com 和无凭据
  -> Runtime 再次解析 URL
  -> GitHub API 查询仓库和 commit
  -> 下载 commit 对应 zipball
  -> 流式限制下载大小
  -> 解压到 PetDock 临时目录
  -> 校验归档路径和符号链接
  -> 定位指定子目录
  -> 扫描 SKILL.md 候选
  -> 展示来源、commit、Skill 列表和兼容性
  -> 用户确认安装
  -> 原子移动到正式目录
```

下载失败、校验失败或用户取消时清理临时目录，不修改已安装版本。

### 8.4 多 Skill 仓库

- 仓库根目录存在 `SKILL.md` 时，将根目录作为一个候选。
- 否则在允许深度内递归查找 `SKILL.md`。
- 默认最大扫描深度为 4。
- 忽略隐藏目录、`.git`、构建目录、依赖目录和符号链接。
- 候选数超过上限时拒绝安装并提示缩小子目录。
- UI 必须让用户勾选要安装的 Skill，不默认全部安装。

### 8.5 更新

- 更新必须由用户手动触发。
- Runtime 或 Main 查询来源仓库当前 ref 对应的 commit。
- commit 未变化时显示“已是最新版本”。
- commit 变化时重新下载和校验。
- 更新前展示新增、移除、权限变化和兼容性变化。
- 新增权限必须重新确认。
- 新版本安装失败时保留旧版本。
- 首版不做定时后台检查和静默更新。

## 9. 安装安全

### 9.1 归档与路径

必须拒绝：

- Zip Slip 路径穿越。
- 绝对路径和 Windows 盘符路径。
- `..` 目录逃逸。
- 符号链接、junction 和其他重解析点。
- 设备路径和保留文件名。
- 大小写归一化后重名的文件。
- 解压后真实路径不在临时安装根目录内的文件。

### 9.2 资源限制

首版默认值：

```text
GitHub 归档下载上限：25 MB
解压后总大小上限：50 MB
单 Skill 文件数上限：500
单仓库候选 Skill 上限：50
单文件上限：5 MB
```

限制值必须集中定义并记录日志，不能由 Renderer 覆盖。

### 9.3 原子安装

```text
下载/复制到临时目录
  -> 完整校验
  -> 计算内容摘要
  -> 写入来源元数据
  -> 同卷原子重命名到正式目录
  -> 更新数据库
  -> 通知 Runtime 刷新
```

更新现有 Skill 时先准备完整新版本，再替换目录。替换失败必须保留旧版本可用。

### 9.4 内容不可信

GitHub Skill、SKILL.md 和资源文件都按不可信内容处理：

- 不能改变 Electron Main 策略。
- 不能授权自身访问目录或执行程序。
- 不能读取 Runtime 令牌、模型 Key 或 Electron 配置。
- 不能通过文字声明提升权限。
- Skill 指令发出的 OS ToolCall 必须重新经过 Main 校验。

## 10. 存储设计

### 10.1 文件布局

```text
PetDock userData/
  skills/
    packages/
      weekly-report/
        SKILL.md
        skill.json
        references/
        assets/
        .petdock-source.json
    temp/
  skills.db
```

`.petdock-source.json` 由 PetDock 生成，Skill 包不能自行提供或覆盖。

### 10.2 SQLite 表

```text
skills
  id
  name
  description
  source_type
  source_display
  repository
  subdirectory
  requested_ref
  resolved_commit
  content_hash
  compatibility
  enabled
  installed_at
  updated_at
  last_error

skill_permissions
  skill_id
  permission
  granted
  updated_at

skill_runs
  id
  task_id
  conversation_id
  skill_id
  trigger
  status
  error_code
  error_message
  duration_ms
  created_at
  completed_at

schema_meta
  key
  value
```

`trigger` 取值：

```text
explicit-menu
explicit-management
agent
```

数据库由 Python Runtime 独占管理。Main 不直接打开 `skills.db`，只通过带启动令牌的 Runtime API 访问。

## 11. Runtime 模块设计

已实现模块：

```text
python-runtime/petdock_runtime/
  skills/
    manifest.py
    registry.py
    store.py
    installer.py
```

职责：

```text
manifest.py
  解析 frontmatter、skill.json 和归一化元数据。

registry.py
  扫描、缓存、启停、冲突检测、渐进式披露、资源读取和热刷新。

store.py
  skills.db schema、状态和运行日志。

installer.py
  本地和 GitHub 预览、安全归档、来源元数据、原子安装、更新与卸载。
```

Agent 有限循环、激活上下文和权限收缩实现于 `agent/langchain_backend.py`，稳定事件契约位于 `agent/contracts.py`；安装器在 Runtime 内使用 `httpx` 和 `zipfile`，不调用系统 Git、Shell、PowerShell 或 CMD。

所有类和方法必须有中文 docstring。扫描、路径归一化、内容预算和 Agent 循环等复杂逻辑需要中文方法内注释，并在失败分支记录可排查但不泄露隐私的日志。

## 12. Electron Main 设计

阶段 5 复用并扩展现有 Main 模块：

```text
src/main/assistant/
  assistantManager.ts
  runtimeClient.ts
  runtimeProcess.ts
```

职责：

```text
assistantManager.ts
  校验结构化 Skill 调用、GitHub URL、预览令牌和 Skill ID，并编排 Runtime。

runtimeClient.ts
  只通过带启动令牌的结构化 HTTP API 访问 Runtime。

runtimeProcess.ts
  向 Runtime 注入 skills.db 和 packages 根目录；打包版允许 30 秒单文件冷启动。

src/main/index.ts
  使用原生目录选择器授权本地来源，并校验 Skill IPC 调用窗口和参数。
```

Main 必须使用结构化 URL 做来源校验；Runtime 使用结构化 GitHub API 和归档 API，不通过拼接 Shell 命令调用 `git clone`、PowerShell 或 CMD。Main 不直接打开 `skills.db`，也不接触归档临时目录。

## 13. 共享协议

### 13.1 共享类型

建议在 `src/shared/assistant.ts` 中增加：

```ts
type AssistantSkillSourceType = 'local' | 'github'
type AssistantSkillCompatibility =
  | 'compatible'
  | 'instruction-only'
  | 'missing-dependencies'
  | 'unsupported-runtime'
  | 'invalid'

interface AssistantSkillSummary {
  id: string
  name: string
  description: string
  sourceType: AssistantSkillSourceType
  sourceDisplay: string
  versionLabel: string | null
  resolvedCommit: string | null
  compatibility: AssistantSkillCompatibility
  permissions: AssistantSkillPermissionSummary[]
  enabled: boolean
  installedAt: string
  updatedAt: string
  lastError: string | null
}

interface AssistantSkillInvocation {
  skillId: string
  input: string
}
```

聊天请求中的 Skill 调用字段是可选的，普通聊天保持兼容。

### 13.2 Runtime API

```text
GET    /v1/skills
POST   /v1/skills/install/local/preview
POST   /v1/skills/install/github/preview
POST   /v1/skills/install
POST   /v1/skills/refresh
POST   /v1/skills/{skill_id}/enable
POST   /v1/skills/{skill_id}/disable
DELETE /v1/skills/{skill_id}
GET    /v1/skills/{skill_id}/runs
```

安装文件操作由 Runtime 完成，但接口只绑定回环地址并要求单次启动令牌。Renderer 不能提交本地路径：Main 只能把原生目录选择器返回的授权路径交给 Runtime。GitHub URL 先由 Main 校验，再由 Runtime 复核、固定 commit、下载和安装。

预览生成短期 `previewToken`，确认安装时只提交令牌和候选 Skill ID；Runtime 重新核对内容摘要，拒绝过期、变化或越权候选。

### 13.3 事件

新增事件：

```text
skill_started
skill_completed
skill_error
```

事件只包含 Skill ID、名称、状态、耗时和脱敏错误，不包含完整指令、真实安装路径或资源正文。

## 14. Renderer 交互

### 14.1 Skill 管理视图

助手单一透明窗口内增加 Skill 管理视图，不新增 BrowserWindow。

功能：

- 安装本地 Skill。
- 输入 GitHub URL 并预览候选。
- 多 Skill 仓库勾选安装。
- 查看名称、描述、来源、commit、兼容性和权限。
- 启用和禁用。
- 手动刷新。
- 手动检查更新。
- 卸载二次确认。
- 查看最近运行状态和错误。

不得在界面中显示真实 `userData` 路径、临时目录或 GitHub API 内部地址。

### 14.2 `$` 菜单

- `$` 只列出已启用且不是 `invalid` 的 Skill。
- 搜索匹配名称和描述。
- 菜单数据来自本地快照，不请求模型。
- 支持鼠标、上下方向键、回车和 Esc，沿用现有 `~` 菜单行为。
- 选择后显示明确 Skill 标识。
- 发送时提交结构化 `skillId`，不把 Skill 指令拼接进用户输入。
- Skill 在发送前被禁用或更新失败时，必须提示并阻止任务启动。

### 14.3 运行反馈

对话区域显示紧凑状态：

```text
正在使用：生成周报
已读取参考：report-format.md
技能执行完成
```

不展示完整系统提示词、Skill 正文、内部工具参数或模型推理过程。

## 15. 热刷新

本阶段“热加载”的定义是：安装、更新、启停或用户点击刷新后，无需重启应用和 Runtime 即可生效。

首版不依赖持续文件系统 watcher：

- 安装和更新完成后由 Main 主动请求 Runtime 刷新。
- 启用和禁用直接更新 Runtime 注册表。
- 管理页提供手动刷新，支持用户在扩展目录外部修改文件后的重新扫描。
- 每次任务激活前重新核对内容摘要，防止缓存正文与磁盘内容不一致。

持续 watcher 延后，避免 Windows 文件事件重复、编辑中间态和大仓库扫描造成不稳定。

## 16. 权限模型

### 16.1 双重校验

```text
Skill 声明权限
  -> Runtime 仅向 Skill 暴露允许的工具
  -> Skill 产生 ToolCall
  -> Electron Main 忽略 Runtime 自报风险并重新计算
  -> 必要时用户确认
  -> Tool Host 执行
```

Runtime 校验是能力收缩，Electron Main 校验是最终安全边界。

### 16.2 未声明权限

- 没有 `skill.json` 的标准 Skill 默认只拥有纯指令能力。
- 可以读取自身 `references/` 和 `assets/`，但不能读取 Skill 根目录外文件。
- 使用 RAG、记忆或 OS 工具前必须有对应 PetDock 扩展权限。
- Agent 尝试调用未声明工具时，Runtime 返回 `skill_permission_denied`。
- 权限变化必须展示给用户，新增权限需要重新确认。

### 16.3 GitHub 内容与工具权限

从 GitHub 安装只代表用户允许保存该 Skill，不代表允许它访问文件、记忆、知识库、网络或系统程序。安装授权与运行权限必须分开。

## 17. 错误与日志

### 17.1 错误码

```text
skill_not_found
skill_disabled
skill_invalid_manifest
skill_name_conflict
skill_incompatible
skill_content_changed
skill_instruction_too_large
skill_resource_not_found
skill_resource_denied
skill_resource_too_large
skill_permission_denied
skill_activation_limit
skill_tool_limit
github_url_invalid
github_repository_unavailable
github_rate_limited
github_commit_unresolved
github_download_too_large
github_archive_invalid
skill_install_failed
skill_update_failed
```

### 17.2 日志要求

记录：

- 扫描开始、结束、候选数和耗时。
- 安装来源类型、脱敏仓库名、commit 和结果。
- 启用、禁用、刷新、更新和卸载。
- Skill 激活、资源读取、完成、取消和失败。
- 权限拒绝和 Agent 轮次超限。

不记录：

- API Key、Runtime 启动令牌和 GitHub 凭据。
- 完整 Skill 正文和资源正文。
- 未脱敏本地绝对路径。
- 模型完整提示词。
- 用户输入中的敏感内容。

## 18. 测试方案

### 18.1 Manifest 单元测试

- 合法最小 `SKILL.md`。
- frontmatter 缺失或未闭合。
- name 大小写、非法字符、过长和重复。
- description 缺失、空值和过长。
- `skill.json` schema 版本和未知权限。
- UTF-8 与非 UTF-8 文件。
- 正文和资源大小限制。

### 18.2 安装安全测试

- 本地目录正常安装。
- GitHub URL 各合法形式。
- HTTP、伪 GitHub 域名和用户信息 URL 拒绝。
- Zip Slip、绝对路径、盘符路径和重解析点拒绝。
- 文件数、单文件、压缩包和解压总大小限制。
- 同名冲突和多 Skill 选择。
- 安装失败保留旧版本。
- commit 固定和更新权限变化。

GitHub 测试使用本地固定 HTTP fixture，不依赖测试期间的真实网络。

### 18.3 渐进式披露测试

- Runtime 启动只读取 frontmatter，不读取正文。
- 未激活 Skill 的正文不进入模型消息。
- 元数据超过预算时只披露确定性候选。
- `$` 显式选择只加载目标 Skill。
- `activate_skill` 后才读取正文。
- 未请求资源不被读取。
- `read_skill_resource` 只能读取当前 Skill 允许目录。
- 任务结束后不复用上次 Skill 正文。
- 会话数据库不保存完整 Skill 正文。

### 18.4 Agent 与权限测试

- Agent 根据 name 和 description 激活正确 Skill。
- 禁用 Skill 不进入候选且不能激活。
- Skill 无法申请未声明工具。
- Skill 中的越权文字不能绕过 Main policy。
- OS ToolCall 继续触发确认卡片。
- Agent 轮次、内部工具和外部工具次数限制。
- 取消任务时停止 Skill 执行并释放状态。

### 18.5 UI 与打包测试

- 本地安装、GitHub 预览、多 Skill 选择和卸载确认。
- 启用、禁用、兼容性和错误状态。
- `$` 菜单搜索、键盘和鼠标操作。
- 五套主题下 Skill 管理视图可用。
- 左右停靠、透明背景和窗口锚点不回归。
- 开发模式和打包版 Runtime 均能加载 Skill。
- 打包版不依赖系统 Git 或系统 Python。

## 19. 开发阶段

### 阶段 5A：规范与注册表

- Skill 共享类型。
- frontmatter 和 `skill.json` 校验。
- `skills.db` 和迁移。
- 本地扫描、冲突检测、兼容性判断。
- 元数据缓存和预算检索。

完成门槛：合法 Skill 可归一化，非法 Skill 有稳定错误码，Runtime 启动不读取正文。

### 阶段 5B：Agent 渐进式披露

- 动态 Tool Registry。
- `search_skills`、`activate_skill` 和 `read_skill_resource`。
- 显式 Skill 调用协议。
- 有限 Agent 循环。
- Skill 状态事件和运行日志。

完成门槛：显式和自主激活均可工作，正文及资源严格按需加载。

### 阶段 5C：安装和生命周期

- 本地目录安装。
- GitHub URL、commit 解析和安全归档安装。
- 多 Skill 仓库选择。
- 启用、禁用、刷新、更新和卸载。
- 权限变化确认和原子替换。

完成门槛：失败安装不污染正式目录，更新失败保留旧版本，无需重启即可生效。

### 阶段 5D：Renderer 与验收

- Skill 管理视图。
- `$` 菜单。
- 运行状态和错误展示。
- 单元、Runtime、E2E、打包和安全测试。
- 更新进度和开发文档。

完成门槛：所有验收标准通过，开发版和打包版行为一致。

## 20. 验收标准

- 用户可以从本地目录安装标准 `SKILL.md` Skill。
- 用户可以从 GitHub 公共仓库 URL 安装一个或多个 Skill。
- GitHub 安装固定到明确 commit，更新必须手动确认。
- 用户可以启用、禁用、刷新、更新和卸载 Skill。
- `$` 菜单只显示当前可用 Skill，并提交结构化 Skill ID。
- Runtime 启动时只解析 `name` 和 `description`，不加载所有正文。
- 未激活 Skill 的正文和资源不会进入模型上下文。
- Skill 激活后只按需加载正文和目标资源。
- Skill 不能读取自身目录以外的资源。
- Skill 不能执行第三方脚本或任意 Shell。
- Skill 不能绕过 Electron Main 工具策略和用户确认。
- 安装、更新、调用和错误均有脱敏日志。
- 修改 Skill 状态或刷新后无需重启应用。
- `npm.cmd run check`、Runtime 打包冒烟测试和助手 E2E 测试通过。

## 21. 完成定义

阶段 5 只有在以下事项全部完成后才能在进度文档中标记为 Done：

```text
[x] Skill v1 格式和兼容层已实现
[x] 本地与 GitHub 安装已实现
[x] 三级渐进式披露已通过测试证明
[x] Agent 显式和自主激活已实现
[x] Skill 管理和 $ 菜单已完成
[x] 权限、路径和归档安全测试已通过
[x] 开发版与打包版验证通过
[x] 文档、测试命令和变更记录已更新
```
