# Desktop SSO 独立审查记录

状态：Archived。归档日期：2026-09-14。本文保留当时的计划、验证和限制，不代表当前实现或当前上线状态；现行入口见 [文档索引](../../../README.md)。历史正文中的“当前”“待部署”“下一步”均指原记录时点。

日期：2026-09-13。任务：SSO-REVIEW-01。角色：Reviewer；主代理整理交付。

结论：本次范围内未发现可确认问题。该结论是指定工作区差异的只读审查，不代表所有运行场景均已测试。

## 审查范围

- Desktop 相对 `d451a5d`、Cloud 相对 `25d49eb`、Web 相对 `dd9d398` 的本次 SSO 未提交变更与新增文件。
- Cloud 来源 Session、精确 Origin、目标浏览器绑定、一次性凭证和 Redis 原子消费、源会话撤销核验。
- 账号选择、独立密码分支、Session 轮换、多标签 Consent 身份固定、恢复参数校验与旧登录兼容。
- Web 页面、API 接入、固定表单目标、生产精确路由、安全响应头与统计排除。
- Desktop `prompt=select_account` 接入、权威契约与消费快照、上线开关及回退说明。

审查包含现有测试源码与真实 HTTPS QA 脱敏报告；Reviewer 没有修改源码或重新执行测试。主代理在审查期间仅整理文档和清理已完成的临时 QA 资源。

## 验证边界

真实 QA 已完成 11 组 Chrome、三主机 HTTPS、Cloud、PostgreSQL、Redis、loopback 与 PKCE 验收。QA 发现的 `no-referrer` 导致原生表单 `Origin: null` 问题已改为选择页 `strict-origin` 并复验，后端不接受 null Origin。

下列事项未实测，不作为已确认代码缺陷：

- 源账号改密／删除的专项真实浏览器场景。
- Redis 操作超过 60 秒互斥锁租约时的故障并发。
- 生产完整反代与正式 CA 验收、签名安装包的操作系统浏览器唤起及回调链路。

开发自测、本地真实 QA、生产部署和安装包发布分别记录；不能以本审查替代后两者。完整实施及验证记录见 [Desktop SSO 方案与实施记录](../plans/DESKTOP_SSO_ACCOUNT_SELECTION_PLAN.md)，QA 报告位于 Web 仓库 `docs/archive/2026-09/qa/DESKTOP_SSO_QA.md`。
