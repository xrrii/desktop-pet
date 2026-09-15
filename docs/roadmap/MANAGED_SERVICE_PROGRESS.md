# desktop-pet 当前进度与交接

状态：Tracking。更新时间：2026-09-15。当前入口只保留现状、下一步和证据来源，旧阶段流水账见归档。

## 当前状态

| 范围 | 状态与证据 |
| --- | --- |
| Managed Phase 2～4 | 既有实现与阶段门禁已完成，详见 2026-08 历史记录；不据此声明本轮重新验收 |
| Desktop SSO | 已完成开发与本地 QA；用户随后确认成功上线。原 QA 的测试限制仍保留 |
| 官网管理与统计 | 功能已实现；原计划的生产统计专项验收限制不补写为已通过，采集状态以生产实际配置为准 |
| Jenkins | 用户已搭建并使用；默认分支与制品复用改动已推送，上传环境变量修复提交为 `46a0614`；修复后的生产重跑结果未在本次整理中确认 |
| Nacos 与桌面自动更新 | P0 独立底座与 Python SDK 本地门禁通过，服务器验收待执行；Chat 热更新与桌面更新尚未开发 |
| 正式支付、按量结算 | 仍为延后范围，不因为维护功能上线而标记完成 |

## 下一步

按 [Nacos 与桌面自动更新方案](../plans/NACOS_AND_DESKTOP_AUTO_UPDATE_PLAN.md) 推进下一轮：先按 [P0 部署指南](../../../petdock-office/petdock-cloud/docs/guides/NACOS_P0_DEPLOYMENT.md) 完成服务器资源、SSH 与备份恢复门禁，再接入 Chat 热切换。本地已验证 Nacos 2.5.4 / SDK 2.0.11 的读取、拒写、真实监听、重连及冷备隔离恢复。统一全量发布；Provider Key 留在 Secret；更新包计划使用腾讯云 COS；暂无 Windows 签名证书，先用开发电脑打包。

当前不把 Phase 5 正式收费自动作为下一任务。Nacos P0 版本与内嵌 Derby 已本地验证，真实 Jenkins 共存、长期日志和服务器恢复尚待现场验收；更新签名、对象存储实际费用及下载防护在对应阶段确定。

## 阅读入口与维护

- [文档索引](../README.md)
- [Jenkins 发布与升级](../../../petdock-office/petdock-cloud/docs/guides/JENKINS_SINGLE_SERVER_DEPLOYMENT.md)
- [原阶段进度与验收全文](../archive/2026-08/roadmap/MANAGED_SERVICE_PROGRESS.md)

新增进度必须区分“实现完成”“本地验证”“用户报告上线”和“代理实际生产验收”。长篇执行记录进入日期归档；现行协议仍以 Cloud contracts 为权威。
