# Desktop 登录、SSO 与官网管理入口

状态：Active。最后核对：2026-09-14。本文记录现行行为，开发过程和旧验收结果见归档。

## 当前行为

- 桌面主动登录使用系统浏览器和 PKCE/loopback，每次提供账号选择；存在官网登录状态时可明确选择复用，也可选择其他账号。
- 官网 A、桌面选择 B 时，官网保持 A；相同权限已授权后不重复 Consent，但账号选择仍出现。
- 桌面重启通过已有 Refresh Token 恢复登录，不要求重新输入密码。
- 桌面提供固定的官网管理入口；返回应用后刷新脱敏状态。Web Session 与桌面 Token 保持隔离。
- 官网会话采用 24h 空闲超时；已有 Session 不因发版统一改期。生产配置由服务器维护。
- 回调页尝试自动关闭，但系统浏览器可能拒绝。用户已明确暂不改动该体验；不能据此判断登录失败。

## 部署与状态来源

用户在本次会话确认 SSO 成功上线。这是用户报告的生产结果；本次文档整理没有访问生产，也没有补做原 QA 报告未覆盖的测试。

服务端开关、精确 Origin、Cookie 隔离、回退与验收以 [Cloud SSO 部署指南](../../../petdock-office/petdock-cloud/docs/guides/DESKTOP_SSO_DEPLOYMENT.md) 和 [权威协议](../../../petdock-office/petdock-cloud/contracts/managed-service/v1/DESKTOP_SSO.md) 为准。普通发版沿用已配置的开关，不重复初始化。

## 历史证据

- [SSO 开发与本地验收记录](../archive/2026-09/plans/DESKTOP_SSO_ACCOUNT_SELECTION_PLAN.md)
- [独立审查记录](../archive/2026-09/reviews/DESKTOP_SSO_REVIEW.md)
- [Web 真实浏览器 QA](../../../petdock-office/petdock-web/docs/archive/2026-09/qa/DESKTOP_SSO_QA.md)
- [P2-11 官网管理入口原计划](../archive/2026-08/plans/P2_11_DESKTOP_MANAGEMENT_ENTRY_PLAN.md)
