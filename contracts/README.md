# PetDock 契约消费快照

本目录是 `desktop-pet` 使用的契约快照，不是权威编辑源。Managed Service 契约的权威源位于独立 `petdock-cloud` 仓库的 `contracts/managed-service/v1`。

契约变更必须先在 `petdock-cloud` 完成评审和验证，再整体同步到本目录。禁止在两个仓库分别修改同一版本；同步后必须执行：

```powershell
npm.cmd run test:contracts
```

当前同步策略为逐文件快照和 SHA-256 内容校验。快照包含 Python 权威测试及跨语言消费测试的固定样例资源；云端还可生成带源提交、文件摘要和归档摘要的 v1 ZIP 制品。后续引入契约发布流水线时，应把快照来源绑定到明确的发布版本或提交。

## 多端协作与提交前检查

- 先在 `petdock-cloud` 权威源修改和验证契约，再整体同步到 `desktop-pet`；禁止在两个仓库分别修改同一 v1 文件。
- 提交前检查待提交差异中没有 API Key、Token、Cookie、Bearer、私钥、真实 Provider 凭据、用户正文或本机绝对路径。
- 用 `git status --short --ignored` 和 `git check-ignore -v` 确认构建输出、Maven `target`、Python 虚拟环境、日志、数据库和临时目录不会进入提交。
- 新增跨语言测试必须读取权威固定样例；新增工具必须让其他开发者从干净 checkout 按 README 命令重建，不提交本机生成物。
- 阶段完成前必须记录 Python、TypeScript、Spring/JUnit、制品校验、桌面快照比对和桌面回归的实际结果。
