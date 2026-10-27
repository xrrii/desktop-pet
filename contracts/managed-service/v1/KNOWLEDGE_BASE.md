# 知识库增强增量契约

2026-10-26 开始实施。保留 v1 现有字段；新增接口和字段均为兼容扩展。

- 产品能力组为 `knowledge_base`，内部操作为 `route / embedding / rerank`。操作分别审计，用户只管理一个开关和共享 Token 额度。
- `POST /ai/v1/knowledge/route` 使用 Runtime Token 和现有五个请求身份头。请求仅包含 `logicalModel: route-standard`、`input` 和 `selectedLibraryCount`（1–20）；不上传知识库 ID、文件路径或完整会话历史。
- 成功响应包含 `route`（`SKIP / RETRIEVE / BOTH / CLARIFY`）、`confidence`、完整四选项 `probabilities` 和 `usage: {inputUnits, outputUnits}`。置信度和概率均为有限的 0–1 数值。客户端不以低置信度触发正则覆盖。
- Jev 可用时独立完成语义判断；关闭、未授权、额度不足、网络错误、超时、限流或无效响应时才执行本地正则。取消任务立即终止，不启动降级。
- `route` 与 `route-standard` 是内部 Usage 能力和逻辑模型，不是新的用户可见开关。成功的 `SKIP / CLARIFY` 仍结算真实用量；调用已发出但用量未知时保留预占并写入失败终态。
- 上游地址由服务端配置，当前用户指定为 `https://api.xrrii.xyz`，调用路径为 `/v1/systemone`。上游密钥只读取服务器 Secret 文件，不下发到 Desktop/Web，不在日志中记录。
- 未配置上游 Secret 时路由失败关闭，本地正则仍可用；本地/BYOK 继续兼容原有行为。

## 共享额度与兼容

- 用户确认按 1:1 合并旧 `embedding + rerank` 剩余额度，不增加兑换权重。V11 同时将两项套餐月额度求和，合并后产品余额上限为 40 亿；其他能力仍为 20 亿。历史 Usage Event 保持原操作类型。V10 保留为已有官网统计迁移。
- 预占、补扣、退款和余额查询将三个内部操作映射到同一 `knowledge_base` 行；迁移前已发出的向量与重排请求也退款到此行。已扣预占不再重复计入迁移余额。
- 新 Entitlement 返回 `knowledge_base`，同时保留 `embedding / rerank` 别名；别名余额指向同一共享额度，新客户端不得再次相加。旧服务端没有聚合字段时，新客户端才将两项独立余额和历史用量相加。
- 用户偏好 API 仍保持五项兼容；新知识库开关一次更新 `embedding / rerank` 偏好。Runtime Token 将产品授权展开为三个内部 Claims，各操作仍受独立部署开关控制，两个知识库偏好都关闭时不签发 route。
- 向量与重排继续使用既有字符等价用量，Jev 使用实际 input/output tokens，均按 1:1 扣共享池；用户单位仍为 tokens。没有更改现有向量计量规则。
- 路由总时限默认 15 秒（含排队）、并发 4、单次输入最多 8192 字符；没有重试或跨 Provider 自动切换。固定规则及输入 UTF-8 字节数用于保守预占，输出预占 128，成功后按上游实际用量结算。

## 部署与验收

服务端配置与升级顺序见 Cloud 仓库 `docs/guides/KNOWLEDGE_BASE_ENHANCEMENT.md`。新增路由默认关闭，空 Secret 仅使路由不可用。数据库迁移必须在停止旧版本写入、备份之后进行；不能把旧服务端直接接回已迁移的数据库。

当前独立 Provider 并发和现有小批次建库继续生效；尚未定义交互查询额度保留比例，也未在 Usage Event 新增 query/index 字段，不能将本轮基础限流等同于完整公平调度。
