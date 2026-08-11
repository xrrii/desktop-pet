# 第三方在线服务说明

PetDock 当前采用 BYOK 模式。用户自行选择、开通并配置第三方服务，PetDock 不
提供共享账号或转售第三方 API。使用相应能力前，用户仍需遵守服务提供方的最新
条款、隐私政策、配额和内容规则。

## OpenAI-compatible 模型服务

- 用途：对话生成、视觉分析和在线 Embedding。
- 可能发送：对话内容、用户选择的附件内容、知识库命中片段、工具结果、经过去除
  EXIF/GPS 的图片派生图，以及在线 Embedding 所需的文本片段和查询。
- 凭据：API Key 由 Electron `safeStorage` 加密保存，不写入普通配置或日志。
- 条款：实际约束取决于用户配置的服务提供方。使用 OpenAI 服务时参见
  <https://openai.com/policies/terms-of-use/>。

## 火山引擎豆包搜索

- 用途：联网搜索公开网页。
- 可能发送：用户问题派生的搜索关键词。
- 本地保留：最终回答实际引用的网页标题、URL、摘要和来源类型可能随会话保存；
  完整网页正文只在当前任务期间处理。
- 条款：<https://www.volcengine.com/docs/6256/64903>，产品专用条款以用户实际
  开通页面为准。

## Brave Search API

- 用途：兼容的联网搜索 Provider。
- 可能发送：用户问题派生的搜索关键词。
- 本地保留：最终回答实际引用的网页标题、URL、摘要和来源类型可能随会话保存。
- 条款：<https://api-dashboard.search.brave.com/documentation/resources/terms-of-service>。
- 注意：不同套餐对搜索结果缓存、再分发和最终用户约束可能有额外限制，启用前应
  核对当前套餐是否允许 PetDock 的会话历史行为。

## Hugging Face 与镜像源

- 用途：下载用户主动选择的本地 Embedding 模型文件。
- 校验：下载文件受白名单、固定 revision、文件大小和 SHA-256 限制。
- 来源及模型许可证记录在 `assets/assistant/embedding-model-whitelist.json`。
- 非官方镜像仅用于下载兼容，不能改变上游模型许可证或来源归属。

## 责任边界

第三方名称仅用于说明兼容性，不表示相关提供方对 PetDock 的认可、赞助或背书。
服务条款可能变更，正式发布前应重新核对；未来官方托管服务上线时，还需要单独的
用户协议、数据处理说明和服务端合规审查。
