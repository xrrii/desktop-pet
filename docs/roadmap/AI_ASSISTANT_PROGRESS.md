# AI 助手当前进度

状态：Tracking。更新时间：2026-10-04。

原阶段 1～5、增强 C1～C5 的实现和验证记录已归档；C6 在原记录中为 Deferred，未因本次整理改变。现行规则见 [AI 架构](../architecture/AI_ASSISTANT_ARCHITECTURE.md)、[功能专项](../README.md) 和 [Managed 当前进度](MANAGED_SERVICE_PROGRESS.md)。

当前需求为 [Nacos 与桌面自动更新](../plans/NACOS_AND_DESKTOP_AUTO_UPDATE_PLAN.md)。用户已确认 P1 Chat 生产切源、模型热更新、真实 SSE/用量闭合和两种回退通过，P1 结束；P2 多能力迁移后置，不阻塞 P3。P3-A/P3-B1 已建立主动更新、忙碌互锁、优雅退出及 Ed25519 信任底座。P3-B2 已实现受限下载入口、COS 短链接、热暂停和持久限流/预算，用户已确认正式 `0.2.2` 的 HTTPS 整包摘要及暂停/恢复通过。P3-B3 已准备 `0.2.3` 手动引导版：内置正式源/公钥、等待提权 helper 成功退出、新增受限下载页和逐步安装验收指南。源码门禁通过，但本批未构建或安装 NSIS；专用只读身份、告警、私钥保管与真实两版本升级仍需现场留证。当前交接见计划第 22 节及 [P3-B3 验收指南](../guides/DESKTOP_UPDATE_P3B3_ACCEPTANCE.md)，规则见 [签名与 Lighthouse 下载边界](../features/DESKTOP_UPDATE_TRUST.md)。

本批不改变 BYOK、受控工具执行、用户正文保护及 Runtime 权限边界；新增更新互锁仅使用本机启动令牌。历史风险和验收细节见 [原进度全文](../archive/2026-08/roadmap/AI_ASSISTANT_PROGRESS.md)，不重新宣称旧测试已在当前代码上执行。
