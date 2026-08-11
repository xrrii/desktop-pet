# PetDock 本地向量模型白名单

更新日期：2026-07-28

## 1. 结论

PetDock 已经在不引入 PyTorch 的情况下接入用户下载的本地向量模型。当前 Python Runtime 通过 Chroma 间接包含 `onnxruntime 1.28.0` 和 `tokenizers 0.23.1`，并已实现 Hash、本地 ONNX 和 OpenAI-compatible 在线 Embedding Provider、白名单下载器、模型配置界面、独立索引签名及切换失败回滚。

白名单的机器可读来源为 `assets/assistant/embedding-model-whitelist.json`。下载器只能消费白名单内固定版本的文件，并且必须在加载前核对文件大小和 SHA-256。

## 2. 首批候选

| 模型 | 档位 | 下载体积 | 维度 | 主要用途 | 验证状态 |
| --- | --- | ---: | ---: | --- | --- |
| BGE Small 中文 v1.5 INT8 | 轻量 | 24.5 MB | 512 | 中文笔记、低配置设备 | Runtime 加载验证通过 |
| BGE Base 中文 v1.5 INT8 | 均衡 | 103.3 MB | 768 | 中文项目文档 | 元数据与同系列格式已核验 |
| Multilingual E5 Small INT8 | 均衡 | 135.4 MB | 384 | 中英文混合、跨语言资料 | Runtime 加载验证通过 |
| BGE Large 中文 v1.5 INT8 | 高质量 | 327.8 MB | 1024 | 大型中文知识库 | 元数据与同系列格式已核验 |

以上下载体积是白名单实际文件大小之和，采用十进制 MB。模型均为 MIT 上游模型的固定 ONNX INT8 转换版本。

## 3. 来源与许可证

- BGE 系列上游：[FlagEmbedding](https://github.com/FlagOpen/FlagEmbedding)，MIT。官方模型分别为 [small](https://huggingface.co/BAAI/bge-small-zh-v1.5)、[base](https://huggingface.co/BAAI/bge-base-zh-v1.5) 和 [large](https://huggingface.co/BAAI/bge-large-zh-v1.5)。
- Multilingual E5 Small 上游：[intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small)，MIT。
- ONNX INT8 文件来自 Xenova 转换仓库。白名单同时固定上游 revision、转换 revision 和每个下载文件的 SHA-256，避免仓库更新后静默替换模型。

Xenova 仓库属于第三方转换产物。正式发布前建议在 PetDock CI 中从固定上游权重自行导出 ONNX，完成向量一致性测试后托管经过审核的产物；当前转换文件适合开发验证和首版预览。

## 4. 推理规则

### BGE 中文 v1.5

- 最大输入：512 tokens。
- 池化：取最后隐藏层的 CLS 向量。
- 归一化：L2 normalization。
- 查询前缀：`为这个句子生成表示以用于检索相关文章：`。
- 文档前缀：无。

BGE 官方说明指出 v1.5 可以不带指令工作，但短查询检索长文档时仍建议添加查询指令。BGE 中文模型对纯中文资料合适，但对大量英文代码标识符的效果需要单独评测，不应仅凭模型体积设为默认。

### Multilingual E5 Small

- 最大输入：512 tokens。
- 池化：按 attention mask 对最后隐藏层做平均池化。
- 归一化：L2 normalization。
- 查询前缀：`query: `。
- 文档前缀：`passage: `。

E5 官方要求检索任务保留查询和文档前缀，否则会造成性能下降。该模型更适合中英文混合资料，但最终默认模型仍应由 PetDock 自有评测集决定。

## 5. 当前接入流程

1. Electron Main 从内置白名单读取模型，Renderer 只接收可展示字段，不接触任意下载 URL。
2. 用户选择模型后，Main 将文件下载为 `.partial`，支持暂停、续传和进度事件。
3. 每个文件下载完成后核对长度和 SHA-256；任一不一致都删除临时文件并标记失败。
4. 单个文件校验通过后从 `.partial` 原子重命名为目标文件；全部文件完成后写入安装清单。
5. Main 把模型目录和白名单推理配置传给 Python Runtime，Runtime 使用 `tokenizers` 和 `onnxruntime` 执行健康检查。
6. 健康检查至少验证输入名称、输出维度、有限数值和归一化结果，不能只判断文件能否打开。
7. 以模型 ID、revision、维度、池化方式、前缀和 Chunk 策略生成 `indexSignature`，不同签名使用独立 Chroma collection。
8. 切换 Provider 时重启 Runtime 并执行健康检查；启动失败则恢复原配置。检索或写入失败时保留业务数据，并降级到 FTS5 或独立 Hash 影子索引。

不同模型的向量空间不能混用。在线模型、本地 ONNX 模型和 Hash Embedding 必须分别使用独立 collection，不能在 API 失败时拿 Hash 查询其他模型生成的向量。

## 6. 上线前准入条件

模型进入用户可见下载列表前还需要满足：

- Windows x64 打包版 Runtime 加载测试通过。
- 100 条以上中文、英文和代码混合检索集评测完成。
- 记录 Recall@20、Precision@3、MRR、索引耗时、查询 P95 和峰值内存。
- 与 Hash Embedding 相比存在明确收益。
- 完成许可证展示、来源归属和删除模型流程。
- 下载源不可用时有清晰错误提示，不绕过摘要校验。

当前白名单、用户界面、下载管理器、ONNX/在线 Provider、索引隔离和配置回滚均已实现。尚未完成的是上线准入验收：至少一个 BGE 和一个 Multilingual E5 需要在打包版完成真实下载、索引、查询、切换和回滚闭环，固定评测集也需要继续扩充并补齐性能报告。上述事项当前未排期，默认模型仍保持待评测决定。
