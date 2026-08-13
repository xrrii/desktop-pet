# PetDock 契约消费快照

本目录是 `desktop-pet` 使用的契约快照，不是权威编辑源。Managed Service 契约的权威源位于独立 `petdock-cloud` 仓库的 `contracts/managed-service/v1`。

契约变更必须先在 `petdock-cloud` 完成评审和验证，再整体同步到本目录。禁止在两个仓库分别修改同一版本；同步后必须执行：

```powershell
npm.cmd run test:contracts
```

当前同步策略为逐文件快照和 SHA-256 内容校验。后续引入契约发布流水线时，应把快照来源绑定到明确的发布版本或提交。
