# PetDock 文档索引

## 1. 使用方式

本目录按文档职责组织。开始开发前，先根据任务类型找到对应基线；当多份文档存在交叉时，总体架构和开发规范优先，功能专项负责补充领域细节。

最后审阅日期：2026-08-15。

## 2. 状态说明

| 状态 | 含义 |
| --- | --- |
| Active | 当前生效的设计或开发基线 |
| Draft | 已形成方案，但对应能力尚未全部实现 |
| Tracking | 持续更新的进度和验收记录 |
| Archived | 仅保留历史，不再作为实现依据 |
| External | 外部供应商或第三方参考资料 |

## 3. 推荐阅读顺序

1. 阅读 [开发指南](guides/DEVELOPMENT.md)，了解环境、命令、测试和打包要求。
2. 阅读 [AI 助手总体架构](architecture/AI_ASSISTANT_ARCHITECTURE.md)，确认进程边界、安全边界和 Runtime 职责。
3. 根据任务进入相应功能专项文档。
4. 涉及 BYOK 与官方服务时，先阅读 [官方托管服务进度与交接记录](roadmap/MANAGED_SERVICE_PROGRESS.md)，再阅读 [双模式实施方案](architecture/MANAGED_SERVICE_IMPLEMENTATION_PLAN.md)。
5. 涉及跨端协议时，读取仓库根目录的 `contracts/managed-service/v1`，不从架构文档重新猜测字段。
6. 开始其他 AI 助手阶段开发或验收时，核对 [AI 助手进度记录](roadmap/AI_ASSISTANT_PROGRESS.md)。

## 4. 文档目录

### 4.1 架构

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| [AI_ASSISTANT_ARCHITECTURE.md](architecture/AI_ASSISTANT_ARCHITECTURE.md) | Active | 本地助手总体架构、通信方式、权限和 Runtime 边界 |
| [MANAGED_SERVICE_IMPLEMENTATION_PLAN.md](architecture/MANAGED_SERVICE_IMPLEMENTATION_PLAN.md) | Active | BYOK 与官方托管服务的冻结决策和分阶段实施基线 |
| [MANAGED_SERVICE_PROVIDER_INVENTORY.md](architecture/MANAGED_SERVICE_PROVIDER_INVENTORY.md) | Active | Phase 0 模型消费者、Provider、配置注入和 Phase 1 回归范围盘点 |

### 4.2 开发指南

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| [DEVELOPMENT.md](guides/DEVELOPMENT.md) | Active | 开发环境、代码规范、测试、构建和打包说明 |
| [MANAGED_SERVICE_SHARED_DEV_DEPLOYMENT.md](guides/MANAGED_SERVICE_SHARED_DEV_DEPLOYMENT.md) | Active | Phase 2 PostgreSQL、Redis、SSH 隧道和备份部署步骤 |
| [UI_STYLE_GUIDELINES.md](guides/UI_STYLE_GUIDELINES.md) | Active | Renderer 界面布局、组件和视觉风格约定 |

### 4.3 功能专项

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| [CONVERSATION_RESOURCE_CAPABILITIES.md](features/CONVERSATION_RESOURCE_CAPABILITIES.md) | Active | 附件、Artifact、联网搜索、复杂输入和多文件能力 |
| [RAG_RETRIEVAL_OPTIMIZATION.md](features/RAG_RETRIEVAL_OPTIMIZATION.md) | Active | 检索路由、召回、评分、Embedding 和评测基线 |
| [SKILL_SYSTEM_DEVELOPMENT.md](features/SKILL_SYSTEM_DEVELOPMENT.md) | Active | Skill 格式、安全边界、安装、激活和验收要求 |
| [EMBEDDING_MODEL_WHITELIST.md](features/EMBEDDING_MODEL_WHITELIST.md) | Active | 本地 Embedding 模型来源、校验和白名单规则 |
| [MANAGED_SERVICE_PHASE2_IDENTITY_AND_SESSION.md](features/MANAGED_SERVICE_PHASE2_IDENTITY_AND_SESSION.md) | Active | Phase 2 身份、设备、会话、共享开发环境和跨仓库实施细节 |

### 4.4 路线与进度

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| [AI_ASSISTANT_PROGRESS.md](roadmap/AI_ASSISTANT_PROGRESS.md) | Tracking | 已完成阶段、测试结果、遗留项和后续工作 |
| [MANAGED_SERVICE_PROGRESS.md](roadmap/MANAGED_SERVICE_PROGRESS.md) | Tracking | 官方托管服务当前阶段、跨仓库边界、验证事实和跨会话交接入口 |
| [MANAGED_SERVICE_BYOK_BASELINE_2026-08-13.md](roadmap/MANAGED_SERVICE_BYOK_BASELINE_2026-08-13.md) | Tracking | Managed 开发前的 BYOK、打包态 Runtime、C3/C5 和检索基线证据 |

## 5. 按任务选择文档

| 任务 | 必读文档 |
| --- | --- |
| 修改 Electron、Runtime 启动或打包 | 开发指南、AI 助手总体架构 |
| 修改 Agent、工具协议或进程通信 | AI 助手总体架构、开发指南 |
| 开发 BYOK 或官方托管服务 | 官方托管服务进度、双模式实施方案、AI 助手总体架构 |
| 开发 Managed Phase 2 登录、设备或 Token | Phase 2 身份与会话方案、Managed v1 契约、双模式实施方案 |
| 部署 Managed Phase 2 共享开发依赖 | Phase 2 身份与会话方案、Shared Dev 部署指南、部署基线契约 |
| 修改 Managed Service API、Token、错误码或 SSE | `contracts/managed-service/v1`、双模式实施方案、官方托管服务进度 |
| 修改附件、文件生成、视觉或联网搜索 | 对话资源能力、AI 助手总体架构 |
| 修改知识库、Embedding 或检索 | RAG 优化方案、Embedding 白名单 |
| 修改 Skill | Skill 系统开发文档、AI 助手总体架构 |
| 修改 Renderer UI | UI 风格约定、开发指南 |
| 更新阶段状态或验收数据 | 对应进度记录及专项文档；官方托管服务必须更新专用进度文档 |

## 6. 维护规则

- 新文档必须归入现有分类；只有确实出现新的文档职责时才增加一级目录。
- 新文档需要在本索引登记状态、用途和推荐阅读关系。
- 文档移动后必须同步更新仓库内全部引用，不保留重复兼容副本。
- `Active` 文档中的现行规则与历史记录混杂过多时，将历史内容移入 `archive/`，不要继续扩展同一文件。
- `External` 资料只作为供应商参考，项目自身的权限、隐私和网络安全规则优先。
- 文档、代码注释和日志继续使用中文；路径、接口和代码标识保持原始命名。
