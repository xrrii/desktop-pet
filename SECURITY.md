# 安全策略

## 漏洞报告

请优先使用 GitHub 仓库的 **Security / Report a vulnerability** 私密报告入口，不要在
公开 Issue 中提交可直接利用的细节、密钥、用户数据或恶意样本。报告至少应包含受影响
版本、复现条件、影响范围和建议修复方式。

## 当前支持范围

安全修复优先应用于最新的 `0.1.x` 版本。尚未发布的开发快照不承诺长期维护，但确认的
安全问题仍会在当前开发分支处理。

## ChromaDB 临时隔离

当前锁定的 `chromadb==1.5.9` 受到
[GHSA-f4j7-r4q5-qw2c](https://github.com/advisories/GHSA-f4j7-r4q5-qw2c) 影响，
上游暂未提供修复版本。该公告的远程攻击入口依赖 Chroma HTTP Server 或连接到已被
污染的远程 Chroma 服务；PetDock 当前只允许本地嵌入式模式：

- 仅创建 `EphemeralClient` 或 `PersistentClient`；
- 不允许创建 `HttpClient`，也不启动或挂载 Chroma HTTP Server；
- 文档向量由 PetDock 的受控 Embedding Provider 生成后显式写入；
- 打包 Runtime 明确排除 `chromadb.server` 模块；
- 自动测试会阻止向量存储误接远程 Chroma 客户端。

在上游修复版本发布前，不得将当前 Runtime 改造成可从网络访问的 Chroma 服务，也不得
导入来源不可信的 Chroma 数据目录。修复版本可用后，应优先升级并重新执行依赖审计、
Runtime 测试和打包 Smoke；如果业务未来必须使用远程向量数据库，应先替换当前隔离方案
并进行独立安全评审。
