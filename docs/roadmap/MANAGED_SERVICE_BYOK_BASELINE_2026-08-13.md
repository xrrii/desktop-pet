# PetDock Managed Service Phase 0 BYOK 基线报告

本报告记录 `P0-04` 在 Managed 功能开发前的桌面端 BYOK、Local 和 Mock 行为基线。后续 Provider 抽象、配置迁移和 Managed 接入必须以此作为最低回归范围。

## 1. 基线信息

```text
验证日期：2026-08-13
Git 提交：e778eec8613dedbb892e3242628713fec1974394
Git 分支：master
工作区说明：验证时只有本轮文档改动，应用与 Runtime 源码相对上述提交未修改
操作系统：Microsoft Windows NT 10.0.19045.0
Node.js：v24.16.0
npm：11.13.0
项目虚拟环境 Python：3.14.5
PyInstaller：6.21.0
```

## 2. 验证结果

| 命令 | 结果 | 关键数据 |
| --- | --- | --- |
| `npm.cmd run check` | 通过 | TypeScript 18 个测试文件、74 项测试；Python Runtime 74 项测试；检索评测通过；生产构建成功 |
| `npm.cmd run build:runtime` | 通过 | 使用 Python 3.14.5 和 PyInstaller 6.21.0 生成独立 Runtime |
| `npm.cmd run test:runtime:packaged` | 通过 | `RUNTIME_SMOKE_OK`，冷启动 `6494 ms` |
| `npm.cmd run test:e2e:assistant:c3` | 通过 | `ASSISTANT_C3_SMOKE_OK` |
| `npm.cmd run test:e2e:assistant:c5` | 通过 | `ASSISTANT_C5_SMOKE_OK` |

新生成 Runtime：

```text
路径：python-runtime/dist/petdock-assistant.exe
大小：99,104,267 字节
生成时间：2026-08-13 15:26:19（Asia/Shanghai）
```

## 3. 检索评测

`npm.cmd run check` 中的固定检索评测结果：

```json
{
  "routeAccuracy": 1.0,
  "toolFalseRetrievalRate": 0.0,
  "zeroResultAccuracy": 1.0,
  "finalDocumentRecall": 1.0,
  "precisionAt3": 1.0,
  "mrrAt3": 1.0
}
```

报告路径：`outputs/rag-eval/rag-v2.json`。

## 4. 已知非阻塞警告

- Chroma/OpenTelemetry 使用的 `asyncio.iscoroutinefunction` 在 Python 3.14 中产生弃用警告，计划在 Python 3.16 移除。
- 文档解析安全测试故意构造重复 ZIP 项，Python `zipfile` 输出一次 `Duplicate name` 警告。
- PyInstaller 报告缺少可选隐藏导入 `importlib_resources.trees`，独立 Runtime 构建和打包态冒烟仍通过。

这些警告未导致本次基线失败。若后续升级 Python、Chroma、PyInstaller 或文档解析依赖，应重新评估。

## 5. 回归门槛

Phase 1 及后续桌面端改动至少必须满足：

- 未登录且未启用 Managed 时，Mock、BYOK Chat、Embedding、Vision 和 Web Search 的现有配置可以继续读取。
- 旧密钥不迁移位置、不要求用户重新输入，也不进入 Renderer 或日志。
- 本地 Runtime HTTP/SSE、工具执行权限和事件序号保持兼容。
- C3 搜索、网页抓取和引用闭环继续通过。
- C5 多文件分析、临时索引和跨轮复用继续通过。
- Embedding Signature 和独立向量空间不发生静默混用。

任何基线失败都必须先记录失败命令、日志位置和影响范围，不得通过删除旧配置或降低安全校验规避。
