# Nacos 配置与桌面更新现行基线

状态：Active。更新于 2026-10-15。用户确认“没问题了”，要求整个“Nacos 配置中心与桌面自动更新实施方案”收尾；本方案已完成，后续进入日常发布与运维。完整过程保留在[实施方案归档](../archive/2026-10/plans/NACOS_AND_DESKTOP_AUTO_UPDATE_PLAN.md)，归档中的阶段待办不再代表当前任务。

## 1. 最终范围与验收依据

| 范围 | 最终结论 |
| --- | --- |
| P0 配置中心底座 | Nacos 2.5.4、Python SDK 2.0.11、单机 Derby；用户已确认服务器部署与 SDK 验收 |
| P1 Chat 配置闭环 | 用户已确认生产切源、模型热更新、真实 SSE/用量闭合、配置回退与显式切回 `.env` 通过 |
| P2 多能力配置迁移 | 用户取消本方案内的迁移，其他能力维持当前配置来源；与已有 Managed Phase 2～4 不是同一阶段编号 |
| P3 桌面整体更新 | Windows NSIS 两机首次/缓存升级、任务延后、取消、数据与 Runtime、Portable 提示及上线维护已按用户确认收尾 |
| P4 发布整合 | 沿用 `npm run release:desktop` 与 P1 Chat 运维；当前版独立续签及单版本目录调整已交付，用户确认整体收尾 |
| Jenkins 新接入 | 已取消；既有 Cloud/Web Jenkins 继续服务原有用途 |

实现与验证的收尾基线为 Desktop `eb901e7`、Cloud `6cf0b65`、Web `619c14d`。此前实际通过 Desktop 发布 56 项、Node/Python 集成 2 项、客户端相关 Vitest 61 项及 Cloud 171 项，见[归档第26节](../archive/2026-10/plans/NACOS_AND_DESKTOP_AUTO_UPDATE_PLAN.md#26-当前版目录与独立续签调整2026-10-15)。本次仅整理文档，不重跑这些业务测试，不读取正式凭据或连接生产服务器。Managed Service v1 契约未修改，不生成新消费快照。

整体关闭以用户确认及既有开发证据为依据，不补写未提供的机器、版本、任务注册或专项故障演练结果。原 P0 资源共存、SSH 和独立备份恢复等专项限制仍见归档，按实际运维变更另行验证；不据此重新开启本方案阶段。

## 2. Chat 配置运行边界

- Nacos 仅用于服务端 Chat 配置，桌面端不连接 Nacos、不保存其凭据，也不接收官方 Provider Key；BYOK 保留本机配置。
- 生产配置使用 Namespace `petdock-production`、Group `PETDOCK_AI_GATEWAY`、Data ID `chat-provider.json`。真实 Key 留在服务器 Secret，配置只引用已登记凭据。
- Gateway 对完整候选执行校验，按请求固定模型、预算、超时与 Provider 快照；有效配置热切换，旧请求排空，非法候选保留最后有效配置。
- 控制台只经现有受限访问方式管理；配置历史回退和紧急切回 `.env` 按 [Chat 生产运维指南](../../../petdock-office/petdock-cloud/docs/guides/NACOS_P1D_CHAT_SOURCE_MIGRATION.md)操作。

新环境的底座与影子接入分别见 [Nacos 部署指南](../../../petdock-office/petdock-cloud/docs/guides/NACOS_P0_DEPLOYMENT.md)和[影子监听指南](../../../petdock-office/petdock-cloud/docs/guides/NACOS_P1B_CHAT_SHADOW_DEPLOYMENT.md)。已有生产环境不重复初始化账号、Secret 或配置。

## 3. 桌面发布与续签边界

- Windows x64 NSIS 更新整个应用及随包 Python Runtime；Portable 只提示固定下载页。正式统一 `stable`，用户主动下载并选择重启，任务忙碌期间延后安装。
- 发布者在可信 Windows 电脑主动运行本地命令，完成构建、Ed25519 清单签名、COS 上传、一次确认与受控目录事务。原制品冻结，恢复不重新构建或覆盖同版本对象。
- 广州 Lighthouse 私有桶保存制品，`download.petdock.site` 提供受限 HTTPS 入口并签发短时只读链接；暂不开 CDN。客户端签名、公钥及地址边界见[更新信任基线](DESKTOP_UPDATE_TRUST.md)。
- 正式目录只包含 `currentVersion`；历史包保留 COS，原目录保留事务备份。旧版入口返回 404 后应重新检查更新，已签发短链可用至自身到期。
- `npm run release:desktop -- --renew` 只续签当前清单，保持版本、keyId 和制品绑定，不构建或上传。剩余不超过14天时，`--renew --if-due` 才续为29天；正常服务和客户端仍执行30天上限及过期拒绝。
- 可选 Windows 任务在每日10点及当前用户登录时检查；电脑长期离线仍可能过期。任务保留人工暂停，不自动发新版，不把私钥上传服务器，也不保证远程告警。

暂不购买 Windows 代码签名证书，Ed25519 不消除“未知发布者”提示，首次安装仍需可信传递。约10元/月是目标，云告警、限流、预算与暂停不能保证费用硬封顶。历史 COS 对象清理、前端资源热更新、灰度渠道和跨平台更新均不在本方案范围内。

## 4. 日常操作入口

| 操作 | 使用文档 |
| --- | --- |
| 发布新桌面版本、恢复或查询事务 | [Windows 发布指南](../guides/DESKTOP_RELEASE_AUTOMATION.md) |
| 安装或核对服务器受控发布入口 | [服务器发布工具指南](../../../petdock-office/petdock-cloud/docs/guides/DESKTOP_RELEASE_AUTOMATION.md) |
| 续签、过期恢复、旧多版本目录迁移、可选定时维护 | [当前清单维护指南](../../../petdock-office/petdock-cloud/docs/guides/DESKTOP_UPDATE_MANIFEST_RENEWAL.md) |
| 下载栈首次部署、TLS、暂停与故障恢复 | [下载服务部署与恢复](../../../petdock-office/petdock-cloud/docs/guides/DESKTOP_DOWNLOAD_P3B2_DEPLOYMENT.md) |
| 后续发行的 NSIS、数据与 Runtime 复验 | [桌面更新验收清单](../guides/DESKTOP_UPDATE_ACCEPTANCE.md) |
| Chat 配置发布和两种回退 | [Chat 生产运维指南](../../../petdock-office/petdock-cloud/docs/guides/NACOS_P1D_CHAT_SOURCE_MIGRATION.md) |

新发版继续一次人工确认，失败保持暂停并按原事务恢复；后续定期检查清单、TLS/凭据、维护任务运行结果、真实账单和预算。既有 Cloud/Web `site/all` 发布前仍要核对下载域名 snippet/include 已纳入受控候选，发布及回退后复验下载入口，详见 [Jenkins 日常指南](../../../petdock-office/petdock-cloud/docs/guides/JENKINS_SINGLE_SERVER_DEPLOYMENT.md)。
