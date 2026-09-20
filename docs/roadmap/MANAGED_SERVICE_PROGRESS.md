# desktop-pet 当前进度与交接

状态：Tracking。更新时间：2026-09-20。当前入口只保留现状、下一步和证据来源，旧阶段流水账见归档。

## 当前状态

| 范围 | 状态与证据 |
| --- | --- |
| Managed Phase 2～4 | 既有实现与阶段门禁已完成，详见 2026-08 历史记录；不据此声明本轮重新验收 |
| Desktop SSO | 已完成开发与本地 QA；用户随后确认成功上线。原 QA 的测试限制仍保留 |
| 官网管理与统计 | 功能已实现；原计划的生产统计专项验收限制不补写为已通过，采集状态以生产实际配置为准 |
| Jenkins | 用户已搭建并使用；默认分支与制品复用改动已推送，上传环境变量修复提交为 `46a0614`；修复后的生产重跑结果未在本次整理中确认 |
| Nacos 与桌面自动更新 | P0 服务器部署与 SDK 真实验收已获用户确认；P1-A Chat 底座已完成本地验证与独立审查，生产仍使用 `.env`；桌面更新尚未开发 |
| 正式支付、按量结算 | 仍为延后范围，不因为维护功能上线而标记完成 |

## 下一步

按 [Nacos 与桌面自动更新方案](../plans/NACOS_AND_DESKTOP_AUTO_UPDATE_PLAN.md) 推进下一轮：下一批进行 P1-B 监听和影子校验，影子阶段不改变生产有效快照；按 [P0 部署指南](../../../petdock-office/petdock-cloud/docs/guides/NACOS_P0_DEPLOYMENT.md) 补充资源、SSH 与备份恢复专项证据。本地已验证 Nacos 2.5.4 / SDK 2.0.11 的读取、拒写、真实监听、重连及冷备隔离恢复。统一全量发布；Provider Key 留在 Secret；更新包计划使用腾讯云 COS；暂无 Windows 签名证书，先用开发电脑打包。

当前不把 Phase 5 正式收费自动作为下一任务。Nacos P0 版本与内嵌 Derby 已本地验证，真实 Jenkins 共存、长期日志和服务器恢复尚待现场验收；更新签名、对象存储实际费用及下载防护在对应阶段确定。

## P1-A 验证与交接（2026-09-20）

Cloud 实现提交：`d684453`。Chat 已具备严格完整配置、Secret 白名单、请求预算/超时/Provider 同快照、旧代排空与取消清理。生产仍用 `.env`，未接 Nacos 配置源，也未改其他模型能力或桌面更新。API Key 文件仍适配为 `secret://chat/default`。

Cloud Gateway 120 项、根测试 38 项通过；Ruff、Mypy 33 文件通过，v1 契约 57 文件 SHA-256 一致。独立审查及 Python 3.13 停机排空修复复核完成。详细命令、候选格式及未执行项见 [实施方案第 14 节](../plans/NACOS_AND_DESKTOP_AUTO_UPDATE_PLAN.md#14-p1-a-配置与请求生命周期交接2026-09-20)。

下一批只接监听与影子校验、重复/乱序保护和 stale 状态；生产源迁移、真实流式切换与显式回退步骤在后续单独交付。本批服务器无需改 `.env` 或重启 Nacos；如发布 Gateway 镜像，仍需现场验证健康、能力状态、合成 Chat SSE/用量和停机。尚未执行生产部署、真实上游调用或 Linux 容器内本批回归。

## 阅读入口与维护

- [文档索引](../README.md)
- [Jenkins 发布与升级](../../../petdock-office/petdock-cloud/docs/guides/JENKINS_SINGLE_SERVER_DEPLOYMENT.md)
- [原阶段进度与验收全文](../archive/2026-08/roadmap/MANAGED_SERVICE_PROGRESS.md)

新增进度必须区分“实现完成”“本地验证”“用户报告上线”和“代理实际生产验收”。长篇执行记录进入日期归档；现行协议仍以 Cloud contracts 为权威。
