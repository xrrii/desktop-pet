# PetDock Managed Service Phase 4 多能力开发方案

最后更新时间：2026-08-24

状态：`Decision Frozen`（架构、边界与实施顺序已冻结；具体 Provider、逻辑模型 Revision、额度和放量范围属于上线安全配置）

涉及仓库：`desktop-pet`、`petdock-cloud`、`petdock-web`

## 1. 目标

Phase 4 在 Phase 3 Managed Chat 已闭环的基础上，按独立纵向能力接入官方 Embedding、Vision、Web Search 和 Rerank，不建设第二套 Agent、知识库、附件系统或工具执行器。

本阶段完成后必须满足：

1. 四项能力分别具备独立契约、Feature Flag、Entitlement、配额、Provider 配置、可观测性、灰度和回滚路径。
2. Desktop 可以对每项能力独立选择 BYOK、Managed、Local 或 Disabled 中契约允许的来源，不因 Chat 来源变化自动联动其他能力。
3. 官方数据面只完成受控推理或搜索候选返回；Agent、Memory、RAG、附件、Skill、Artifact、本地工具和网页正文抓取继续位于用户设备。
4. Managed 故障不得自动消耗用户 BYOK Key；Embedding 只允许使用已存在且空间隔离的 Local Hash 影子索引降级，Rerank 只允许回退到现有本地排序。
5. 每项能力都能在不影响 Phase 3 Chat、登录、官网和 BYOK 的情况下单独关闭或回滚。

Phase 4 不是正式收费阶段。不可变 Usage Ledger、支付、按量结算、成本对账、自动补偿和生产级运营能力仍属于 Phase 5。

## 2. 当前基线

### 2.1 已具备能力

- Phase 3 Managed Chat 的 Runtime Token、JWKS、Redis 撤销失败关闭、内部服务认证、配额预占/结算、Usage Summary、FastAPI 数据面、生产容器和受限线上 Provider 冒烟均已完成。
- Runtime Token 的 `capabilities` 已允许 `chat`、`embedding`、`vision`、`rerank` 和 `web_search`。
- `ai-data-plane.yaml` 已包含四个 Phase 4 路径草案，但尚未达到实现门禁要求。
- Embedding 已有 `EmbeddingProvider`、Descriptor Signature、按签名隔离的 Chroma Collection、Local Hash 影子索引和切换失败回滚。
- Vision 已有图片安全派生、主动能力探测、摘要缓存和取消语义。
- Web Search 的 URL、DNS、SSRF、重定向、MIME、响应大小、正文预算和取消全部由 Electron Main 控制。
- RAG 已有本地 FTS5、向量召回、Weighted RRF、多信号准入和去重，但尚无独立 Rerank Provider 端口。

### 2.2 开发前缺口

现有 Phase 4 OpenAPI 只是草案，以下缺口必须由 `P4-00` 先闭合：

- Feature Flag 只有 `managed_chat_enabled`，缺少四项能力独立开关。
- 内部 Usage 预占仍把 `capability` 和 `logicalModel` 固定为 Chat，不能直接承载其他能力。
- `usage-event.schema.json` 的 `logicalModel` 仍固定为 `chat-standard`。
- Embedding Descriptor 的获取、Revision 变化和客户端兼容语义尚未冻结。
- 四项请求的精确字节、条目、Token、像素、并发、超时和指纹预算尚未进入权威契约。
- Vision 草案使用 Base64 JSON；正式传输格式、原始字节上限和解码后校验尚未冻结。
- Rerank 的本地准入前后顺序、候选裁剪和失败回退尚未形成机器可测契约。
- Nginx 当前只开放 Chat、Capabilities 和 Health；Phase 4 路径仍应返回 `404`。

在 `P4-00` 完成前，不新增生产数据库迁移，不开放 Phase 4 Nginx 路由，不连接真实 Provider，也不把任何 Phase 4 开关设为 `true`。

## 3. 范围边界

### 3.1 本期实现

| 领域 | 本期交付 |
| --- | --- |
| 共用契约 | 四项独立开关、逻辑能力 ID、Descriptor、严格请求/响应、错误、配额和固定样例 |
| Cloud 控制面 | 四项 Entitlement、Runtime Token Claims、配额事实、Usage Summary 和审计 |
| Cloud 数据面 | 四个独立 Provider Adapter、校验、取消/超时、用量闭合和低基数指标 |
| Desktop Runtime | Managed Embedding、Vision、Rerank Adapter，复用现有本地领域接口 |
| Electron Main | Managed Web Search Provider、Runtime Token 获取和现有网页安全抓取 |
| Desktop UI | 各能力独立来源、状态、隐私提示、切回本地/BYOK 和真实用量摘要 |
| Web | 只通过 Spring Boot Web Session 展示真实 Entitlement/Usage；不调用 AI 数据面 |
| 发布 | 每项能力独立的 Docker/Nginx 路由、配置、白名单门禁和回滚记录 |

### 3.2 明确不做

- 不把本地 Agent、Memory、RAG、知识库、附件、Skill、Artifact 或工具执行迁移到 Cloud。
- 不新增 `/ai/v1/web/fetch`，不让 Cloud 读取候选网页正文。
- 不让官方服务扫描用户磁盘、知识库目录或未主动加入会话的图片。
- 不在 Phase 4 建设 BYOK Rerank、本地视觉模型或新的通用 Embedding 抽象。
- 不自动从 Managed 切换到 BYOK，也不自动跨 Provider、跨区域或跨境故障切换。
- 不在客户端、公开契约、日志或 Usage 页面展示真实 Provider、内部模型名、密钥和成本。
- 不实现支付、充值、退款、发票、正式按量开通、不可变收费账本或管理员补偿后台。
- 不因为某项能力技术完成而自动开放普通用户流量。

## 4. 冻结决策

### 4.1 独立能力模型

| 能力 | 逻辑能力 ID | 允许来源 | Beta 计量单位 | 本地降级 |
| --- | --- | --- | --- | --- |
| Embedding | `embedding-standard` | `byok`、`managed`、`local` | `tokens` | 仅使用已就绪且独立 Signature 的 Local Hash 影子索引 |
| Vision | `vision-standard` | `byok`、`managed`、`disabled` | `tokens` | 无自动降级；用户手动切换或关闭 |
| Web Search | `web-search-standard` | `byok`、`managed`、`disabled` | `requests` | 无自动 BYOK；Main 返回稳定不可用状态 |
| Rerank | `rerank-standard` | `managed`、`disabled` | `tokens` | 回退到现有 Weighted RRF/本地评分 |

实际 Provider、模型、地址和凭据只存在于服务端安全配置。四项能力分别评审，不默认复用 Phase 3 Chat Provider，也不因使用同一供应商而共用开关、额度或故障状态。

### 4.2 独立开关与可用性

控制面新增以下向后兼容的可选字段，缺失、类型错误或请求失败一律按 `false`：

```text
managed_embedding_enabled
managed_vision_enabled
managed_web_search_enabled
managed_rerank_enabled
```

一次实际调用必须同时满足：

```text
客户端显式选择 Managed
  AND 对应 Feature Flag 开启
  AND Runtime Token Claims 包含对应 capability
  AND Entitlement 对应能力可用且额度足够
  AND 数据面 capability 状态 available
  AND 当前客户端版本受支持
```

任何一层失败都不得调用 Provider。`/ai/v1/capabilities` 返回实时可用性和公开逻辑 Descriptor，不返回真实 Provider、内部模型、密钥、成本或部署拓扑。

### 4.3 来源切换与数据一致性

- Chat、Embedding、Vision、Web Search 和 Rerank 的选择互不联动。
- Managed 失败不得静默使用 BYOK Key；切回 BYOK 必须由用户明确操作。
- Embedding Descriptor 的逻辑 ID、Revision、Dimensions、Tokenizer、归一化、Chunk 策略或阈值任一变化，都必须产生新的 Descriptor Signature。
- 不同 Signature 的向量禁止混写。切换到未就绪空间时，UI 必须显示重建状态，旧空间保留到新索引成功或用户明确清理。
- Vision 摘要缓存键继续包含图片哈希、来源配置签名和 Prompt 版本；来源或 Revision 变化不得命中旧缓存。
- Rerank 只改变已通过本地召回和准入的候选顺序，不得把本地已拒绝内容重新加入结果。
- Web Search 的候选 URL 仍必须经过 Main 的现有网络策略，Provider 返回结果不构成可信 URL 或可信正文。

### 4.4 链路、认证与重试

- 继续复用 Phase 3 的 `trace_id`、`request_id`、`attempt_id`、Runtime Token 和撤销语义，不创建第二套链路 ID。
- Runtime 内的 Embedding、Vision、Rerank 从 `ManagedSessionStore` 读取内存 Lease；Main 的 Web Search 从现有 Runtime Token Broker 获取短期 Token。
- Token 过期只允许在 Provider 尚未调用、响应尚未向本地消费者提交时刷新一次；保持 `request_id`，更新 `attempt_id`。
- Provider 已调用后不自动重试，也不自动跨 Provider。用户重新操作必须生成新的 `request_id`。
- 客户端取消必须传播到数据面和 Provider；终态按照“未调用释放、可靠用量结算、用量未知保守失败”闭合。

### 4.5 数据与日志

允许发送到官方数据面的内容仅限：

| 能力 | 允许发送 | 禁止发送或持久化 |
| --- | --- | --- |
| Embedding | 用户已加入知识库/会话的 Chunk 文本或检索查询 | 文件路径、未选文件、正文日志、持久化请求正文 |
| Vision | 用户明确加入会话的安全派生图片和固定分析指令 | 原始路径、EXIF/GPS、未选图片、Base64/图片日志 |
| Web Search | 搜索词、结果数量和受控选项 | 网页正文、Cookie、浏览历史、本地上下文 |
| Rerank | 当前查询和已通过本地准入的候选片段 | 文件路径、完整文档、未入选候选、查询/片段日志 |

所有 Managed 用户数据继续只允许在中国大陆境内传输和处理。日志只记录链路 ID、能力、逻辑 ID、公开 Revision、预算区间、耗时、结果数量、用量、终态、稳定错误码和异常类型；禁止记录查询、Chunk、图片、摘要、URL 查询参数、网页正文、凭据或完整上游响应。

## 5. `P4-00` 契约闭合门禁

`petdock-cloud/contracts/managed-service/v1` 是唯一权威编辑源。`P4-00` 必须一次闭合以下内容，再整体同步 Desktop 快照：

1. 在 `DECISION_REGISTER.md` 增加 Phase 4 独立开关、调用所有权、来源切换、数据预算、配额和回滚决定。
2. 将 `ai-data-plane.yaml` 的四个草案操作升级为受控 Phase 4 操作，并为每项定义严格的请求体字节、条目、字符/Token、并发和超时上限。
3. 冻结公开逻辑 ID 与 Embedding Descriptor；Descriptor 至少包含 ID、Revision、Dimensions、Tokenizer、归一化、Chunk 策略、查询/文档前缀和检索阈值。
4. Vision 使用 `multipart/form-data` 传输单张安全派生图片；同时校验 MIME、魔数、解码后字节、宽高、总像素和动图策略，不接受客户端路径或远程 URL。
5. Rerank 请求只接受稳定候选 ID、查询和受限候选正文；响应只返回原候选 ID、有限数值分数和顺序，不返回改写正文。
6. Web Search 响应只返回标题、URL、短摘要和可选发布时间；契约测试继续禁止 `/ai/v1/web/fetch`。
7. 将内部 Usage 预占/终态契约从 Chat 常量扩展为五项受控能力和对应逻辑 ID，保留 Phase 3 Chat 的兼容语义。
8. 冻结计量映射：Embedding/Rerank 使用输入 Token，Vision 使用可靠输入/输出 Token，Web Search 每次成功 Provider 请求计一个 `request`；无可靠用量时沿用保守失败终态。
9. Feature Flag、Entitlement、Runtime Token、Usage Event、Desktop/Web Usage Summary 和错误码增加四项固定样例及 Python/TypeScript/Spring 跨语言断言。
10. 固定 `invalid_request`、`request_too_large`、`capability_disabled`、`capability_not_entitled`、`quota_exhausted`、`rate_limited`、`provider_timeout`、`provider_invalid_response`、`provider_unavailable`、`request_cancelled` 和通用未知错误降级。

完成标准：Cloud 权威契约、Desktop 快照和 Web 生成类型逐文件/逐类型一致；任何 Phase 4 生产开关仍为关闭，Nginx 路径仍返回 `404`。

## 6. 共用 Cloud 基础

### 6.1 Spring Boot 控制面

- 复用现有 PostgreSQL Entitlement、Usage Reservation 和追加写 Usage Event，不建立能力专属的第二套账本。
- 数据库迁移使用向后兼容的 expand 方式增加能力、逻辑 ID 和额度事实；Phase 3 Chat 数据不得重写或删除。
- 每项能力独立配置 Beta Entitlement、周期额度和单位；没有授权的能力不进入 Runtime Token Claims。
- Usage Summary 按能力返回真实 `used`、`remaining` 和 `unit`；Web/Desktop 不自行推导额度。
- 内部服务认证继续失败关闭，不接受用户 JWT、Web Session 或公网来源访问内部预占接口。
- 审计记录开关变更、配额拒绝、幂等冲突和能力授权变化，不记录用户输入或 Provider 内容。

### 6.2 FastAPI AI 数据面

```text
app/
  providers/
    embedding/    单一 Managed Embedding Adapter
    vision/       单一 Managed Vision Adapter
    web_search/   单一 Managed Search Adapter
    rerank/       单一 Managed Rerank Adapter
  services/       各能力校验、配额、调用和终态编排
```

- 四个 Adapter 使用窄接口，不读取彼此配置，不复用 Chat 的隐式默认模型。
- 请求校验、Runtime Token、撤销、Entitlement 和预占都必须在 Provider 调用前完成。
- Provider Secret 继续使用只读文件或等价运行时 Secret 注入，不进入环境转储、镜像层和日志。
- 每项能力有独立连接、首响应/总时长、并发和正文预算；第一版不做自动重试或熔断切换。
- `/ai/v1/health` 只表示数据面进程就绪；具体能力是否可用以认证后的 `/ai/v1/capabilities` 为准。

### 6.3 配额状态机

继续复用 Phase 3 状态：

```text
reserved -> settled
reserved -> released
reserved -> failed
```

- 同一 `request_id`、用户、Session、能力、逻辑 ID 和请求指纹一致时可幂等重放终态。
- 同一 `request_id` 携带不同能力、逻辑 ID、主体或指纹时返回幂等冲突，不调用 Provider。
- Embedding 批次在调用前按受控 Tokenizer 或保守上界预占；单批不得拆成无法对账的隐式请求。
- Web Search 成功调用供应商后按一次请求结算，即使结果为空；明确未调用时释放。
- Rerank/Embedding/Vision 已调用但 Provider 未给出可靠用量时进入 `failed` 并保留预占量，补偿仍留给 Phase 5。

## 7. Managed Web Search（首个灰度能力）

### 7.1 工作项

- `P4-W01`：在 Main 的 `WebSearchService` 增加 Managed Provider，复用 Runtime Token Broker、现有任务预算、取消和错误映射。
- `P4-W02`：数据面实现查询/结果数量校验、单一 Search Adapter、配额闭合和候选规范化。
- `P4-W03`：Main 对每个候选继续执行协议、端口、凭据、DNS、公网 IP 固定、重定向、MIME、响应大小和正文预算检查。
- `P4-W04`：来源卡片和引用格式与 BYOK 保持一致，不暴露供应商或内部模型。
- `P4-W05`：增加独立设置、隐私提示、状态和手动切回 BYOK；未登录、未授权或服务失败时不修改现有 BYOK 配置。

### 7.2 完成门槛

- Cloud 永远不接收网页正文或待抓取 URL 列表，且不存在 `/web/fetch` 路由。
- 恶意、内网、重绑定、超大、错误 MIME 和重定向候选仍由 Main 拒绝。
- 搜索供应商故障不会自动使用用户 BYOK Key，Chat、Vision、Embedding 不受影响。
- 引用可以追溯到 Main 实际成功读取的来源，而不是仅以 Provider 候选冒充已读取来源。

## 8. Managed Vision

### 8.1 工作项

- `P4-V01`：将 `VisionAnalyzer` 的远程调用抽为 BYOK/Managed Adapter，保留现有探测、状态、缓存和取消所有权。
- `P4-V02`：只读取 Attachment Store 中用户明确加入当前会话的安全派生图；上传前再次确认会话归属和派生状态。
- `P4-V03`：数据面执行 MIME、魔数、字节、宽高、像素和解码预算校验，拒绝路径、URL、多图和不受支持格式。
- `P4-V04`：摘要缓存键加入 Managed Descriptor Revision；缓存只保存结构化摘要，不保存图片或 Base64。
- `P4-V05`：设置页允许单独关闭 Vision；关闭或取消时清理内存请求状态和临时上传对象。

### 8.2 完成门槛

- 未主动加入会话的图片、原始路径和 EXIF/GPS 不离开设备。
- 图片、Base64、视觉 Prompt 和摘要正文不进入默认日志、指标、数据库或 Usage Event。
- 取消、超时、无效图片、Provider 拒绝和用量未知进入确定终态。
- Managed Vision 关闭后，BYOK Chat 和纯文本 Chat 继续可用。

## 9. Managed Embedding

### 9.1 工作项

- `P4-E01`：由 `/ai/v1/capabilities` 提供官方 Embedding Descriptor，并在 Runtime 映射为现有 `EmbeddingDescriptor`。
- `P4-E02`：实现 `ManagedEmbeddingProvider`，继续满足现有 `EmbeddingProvider` 的健康检查、文档/查询向量和 Token 计数接口。
- `P4-E03`：按契约限制批量大小、单文本长度、总 Token、响应维度、有限数值和并发；向量数量和顺序必须与输入一一对应。
- `P4-E04`：Descriptor Signature 变化时创建新 Collection，并通过现有索引状态显式重建；禁止覆盖或混写旧空间。
- `P4-E05`：维持独立 Local Hash 影子索引。Managed 查询失败时只有在影子索引已就绪时才能降级，并在 Retrieval Trace/UI 中明确标记。
- `P4-E06`：知识库、会话附件索引、删除、切换、失败回滚和应用重启恢复均覆盖 Managed Signature。

### 9.2 完成门槛

- Descriptor Revision 或 Dimensions 变化不会让旧知识库静默产生错误结果。
- Provider 返回空向量、NaN/Infinity、维度错误、数量错误或顺序错误时整批失败，不写入 Chroma。
- 索引失败保留旧可用空间，不删除用户原文，不自动改用 BYOK。
- 至少覆盖新建索引、增量索引、切换、重启恢复、取消、额度耗尽和 Local Hash 影子查询。

## 10. Managed Rerank

### 10.1 工作项

- `P4-R01`：新增窄 `RerankProvider` 接口，只接受查询与已通过本地准入的稳定候选 ID/正文。
- `P4-R02`：在 Weighted RRF、多信号准入和去重之后、最终截断之前调用；不得替代 FTS5/向量召回或本地准入。
- `P4-R03`：限制候选数量、单片段字符、总字符/Token 和请求并发；发送前去除本地路径及不必要元数据。
- `P4-R04`：只接受原候选 ID 的唯一有限分数；未知、重复、遗漏或非法分数使本次 Rerank 失败。
- `P4-R05`：失败、关闭、未授权、超时或额度耗尽时回退现有本地顺序，并在 Retrieval Trace 中记录固定原因。
- `P4-R06`：使用固定评测集证明相关性收益，并记录延迟、回退率和对最终准入结果的影响。

### 10.2 完成门槛

- Rerank 不得新增候选、不修改候选正文、不绕过本地最低分和来源去重。
- 故障时查询仍由本地检索完成，结果可解释且不依赖 BYOK。
- 在固定评测集未证明收益前，生产 `managed_rerank_enabled` 保持关闭。

## 11. Desktop 与 Web 产品入口

### 11.1 Desktop

- 设置页按能力显示“我的配置 / 官方服务 / 本地 / 关闭”中实际允许的选项，不使用一个总开关联动全部能力。
- 每项 Managed 选择都显示将发送的数据类别；Embedding 索引重建和 Vision 图片上传必须有明确状态。
- Renderer 只接收脱敏来源、状态、Revision、索引进度和用量，不接收 Runtime Token、Provider、内部模型、用户/设备/Session ID。
- Entitlement 或实时能力不可用时保留用户选择，但 `effectiveSource` 进入不可用或本地降级状态，不静默改写配置。
- “切回我的配置”只修改对应能力，不删除本地模型、BYOK Key、知识库、附件或会话。

### 11.2 Web

- Web 继续只调用 Spring Boot Web API，不持有 Runtime Token，不调用 FastAPI，也不上传图片、Chunk、查询或候选。
- `/account/usage` 在 Cloud 返回真实四项摘要后按能力展示名称、已用、剩余和单位；服务端未返回的能力不展示假数据。
- Phase 4 不增加 Provider、模型、价格、成本、请求明细、支付或按量开通页面。

## 12. Docker、Nginx 与发布

- AI Gateway 继续使用非 root、只读文件系统、`cap_drop: ALL`、无宿主机端口和受限 `provider-egress` 网络。
- 四项能力各自使用独立服务端开关和 Provider 模式；生产环境禁止假 Provider。
- Nginx 每次只增加当前灰度能力的精确路径和方法，未启用能力、错误方法、内部接口、文档 UI、调试端点和未知路径保持 `404`。
- 每个能力先完成关闭态、假 Provider、受限真实 Provider、白名单账号、取消/超时/额度和回滚门禁，再决定是否扩大流量。
- 上一能力的上线不是下一能力的前置授权；任何能力回滚时 Chat、登录、官网、BYOK 和其他已稳定能力继续运行。

## 13. 实施顺序

### 门禁 A：`P4-00` 契约闭合

完成第 5 节所有决定、OpenAPI、Schema、错误、样例、生成类型和快照比对。所有 Phase 4 开关保持关闭。

### 波次 B：共用 Cloud 能力底座

1. 扩展 Entitlement、Runtime Claims、Usage Reservation/Event/Summary 和内部服务校验。
2. 在 AI Gateway 建立四个窄 Adapter 端口、共用验证/配额编排和独立配置对象。
3. 补齐生产 Compose、Secret、低基数指标和精确路由模板，但不开放真实流量。

### 波次 C：Managed Web Search

以最小数据面和最小持久化影响验证通用鉴权、配额、Main Token、候选不可信、Nginx 与独立回滚链路。

### 波次 D：Managed Vision

验证二进制上传、图片安全派生、取消、缓存签名和敏感内容不落日志。

### 波次 E：Managed Embedding

验证 Descriptor、批处理、持久化向量空间、索引重建、影子索引和恢复，避免早期能力缺陷污染用户知识库。

### 波次 F：Managed Rerank

在 Embedding/RAG 基线稳定后接入可选重排，以固定评测集决定是否进入生产白名单。

### 门禁 G：产品入口与受限线上验收

Desktop/Web 只展示已经拥有真实服务端事实的能力。四项分别完成自动门禁、打包态、受限正式 HTTPS、真实 Provider、撤销传播、额度、取消和回滚验证。

`P4-00` 后各纵向能力允许并行开发，但发布顺序默认 `Web Search -> Vision -> Embedding -> Rerank`。变更顺序必须记录原因，不能跳过该能力自己的门禁。

## 14. 测试矩阵

### 14.1 契约与 Cloud

- 四项 Feature Flag 缺失/错误时失败关闭，旧版客户端仍可使用 Phase 3 Chat。
- Runtime Token capability、Entitlement、实时 capability 和开关组合矩阵。
- 每项请求的重复键、未知字段、字节、条目、Token、并发和超时边界。
- 预占、结算、释放、失败、幂等重放、冲突、额度耗尽和数据库并发。
- Provider 未调用、已调用有可靠用量、已调用用量未知、取消和内部服务不可用。
- JWKS 未知 `kid` 单次刷新、Redis 撤销、设备撤销、Session 过期和客户端版本拒绝。
- 日志、指标、审计、数据库和构建产物敏感内容扫描。

### 14.2 Desktop

- 五项能力来源独立迁移和设置损坏恢复，不丢失 BYOK Key 或本地配置。
- Runtime Token 刷新只在安全点发生一次；取消可穿透 Main/Runtime/数据面。
- Embedding Signature、Collection 隔离、重建、重启、失败回滚和 Hash 影子索引。
- Vision 会话归属、安全派生图、缓存签名、取消和临时状态清理。
- Web Search 候选 SSRF/DNS/重定向/MIME/大小/正文预算与来源引用。
- Rerank 候选准入顺序、非法响应、本地回退和评测指标。
- Renderer、日志和生产制品无 Token、Provider、内部模型、路径和用户正文。

### 14.3 Web

- 只读取真实 Entitlement/Usage，正确处理未登录、未授权、耗尽和服务失败。
- 浏览器不能访问 AI 数据面、内部配额接口或 Desktop Token。
- 新增能力名称和单位在桌面/移动视口下可读，不展示价格、Provider 或请求明细。

### 14.4 跨端与线上

- 每项能力分别验证关闭、白名单开启、撤销、额度耗尽、Provider 超时、无效响应、取消和回滚。
- 单项故障或关闭不影响其他 Managed 能力、BYOK、登录、设备和官网。
- Nginx 只开放已批准路径；`/web/fetch`、错误方法、内部接口和未知路径稳定拒绝。
- 真实 Provider 数据驻留、保留策略、境内地址和 Secret 注入证据在放量前完成审查。

## 15. 验证命令

Desktop：

```powershell
npm run typecheck
npm test
npm run test:contracts
npm run test:runtime
npm run test:retrieval
npm run build
npm audit --omit=dev --audit-level=high
```

涉及打包态时继续执行 `npm run dist`、Runtime packaged smoke 和对应能力 E2E。

Web：

```powershell
npm run typecheck
npm test
npm run build
npm run check:nginx
npm run test:e2e
npm audit --omit=dev --audit-level=high
```

Cloud：

```powershell
python -m pytest
python tools/compare_contract_snapshot.py ..\..\desktop-pet
```

```powershell
cd services\ai-gateway
python -m pytest
python -m ruff check app tests
python -m mypy app
```

```powershell
cd services\control-plane
.\mvnw.cmd -q test
```

三仓最终执行 `git diff --check`、`git status --short --ignored`、契约 SHA-256 比对、生产制品扫描和敏感内容扫描。验证记录不得包含 Token、Cookie、Provider Secret、查询、Chunk、图片、摘要、候选正文、真实账号或生产日志正文。

## 16. 完成定义

单项能力只有同时满足以下条件才能标记为 `Done`：

- 权威契约、Cloud 实现、Desktop 消费、Web 真实摘要和生产路由一致。
- 独立开关、Entitlement、配额、Provider 配置、监控、灰度和回滚均可执行。
- 自动测试、打包态和受限正式 HTTPS 真实 Provider 验收通过，未运行项明确记录。
- 故障不会自动使用 BYOK，不影响其他能力，也不破坏本地数据或索引。
- 数据驻留、日志脱敏、Secret 注入和生产制品扫描通过。

Phase 4 只有 E/V/W/R 四项都完成各自门禁后才可整体标记为 `Done`。部分能力完成时只更新对应工作项，不得把阶段整体提前标记为完成。

## 17. 回滚

1. 先关闭目标能力对应的服务端 Feature Flag 和 Provider 开关，不修改其他能力。
2. 等待或取消目标能力在途请求，确认 Usage 进入 `settled`、`released` 或 `failed` 终态。
3. 移除或关闭该能力的 Nginx 精确路由，再回滚 AI Gateway/Control Plane 镜像。
4. 数据库只执行向后兼容迁移；不删除 Entitlement、Usage Event、用户知识库、附件、索引或本地配置。
5. Embedding 回滚保留旧/新 Signature Collection，由用户或后续清理任务显式处理，不自动混写或删除。
6. 回滚后复验 Phase 3 Chat、OAuth、设备撤销、官网、BYOK 和其他已开放能力。

## 18. 上线前必须确认的安全配置

以下值不进入公开契约，必须按能力由项目负责人在真实 Provider 联调前提供：

- 实际 Provider、境内 API 地址、模型/服务 Revision 和凭据。
- Provider 对输入、输出、图片和搜索词的数据驻留、训练使用与保留证明。
- 请求字节、Token、批量、图片像素、候选数量、并发和超时的生产值。
- Beta 月额度、白名单账号、放量比例和最低客户端版本。
- 独立 Feature Flag、Provider 开关、Secret 文件、监控阈值和回滚负责人。

缺少这些真实值不阻塞 `P4-00`、假 Provider、客户端 Adapter 和自动测试，但阻塞真实 Provider 调用、受限线上验收与任何用户放量。
