# 桌面更新发行复验与故障记录

状态：Active。更新于 2026-10-15。Nacos 与桌面自动更新方案已按用户确认收尾，现行范围见[最终基线](../features/NACOS_AND_DESKTOP_AUTO_UPDATE.md)。本指南用于后续发行复验；原 P3-B3 构建、手工登记与现场过程已[归档](../archive/2026-10/validation/DESKTOP_UPDATE_P3B3_ACCEPTANCE.md)，不再照抄历史版本或目录合并命令。

## 1. 发布前核对

使用真实批准的旧版与更高目标版本，不覆盖已发布的同版本对象，也不放开降级。源码版本以 `package.json` 和锁文件根版本为准，不能把本机源码升版当作已发布。

新版本按 [Windows 发布指南](DESKTOP_RELEASE_AUTOMATION.md)完成检查、构建、签名、上传、人工确认、目录事务及完整 HTTPS 制品验收。正常目录只保留最新版；只续签时按[清单维护指南](../../../petdock-office/petdock-cloud/docs/guides/DESKTOP_UPDATE_MANIFEST_RENEWAL.md)执行，不重复构建或下载整包。

在隔离测试账号或可恢复快照中保留合成设置、宠物、会话、附件、知识库和 Skill 基线。记录实际安装版本、Main/Runtime 进程、目标包及 Runtime 摘要；登录凭据不导出、不对比或记录密文。测试隔离不代表另设灰度渠道。

## 2. 发行复验矩阵

| 场景 | 预期结果 |
| --- | --- |
| 检查更新 | 只获取元数据和已验签清单，不自动下载；目标版本和摘要一致 |
| 首次下载与安装 | Windows NSIS 两台测试机各点击一次重启安装即可出现窗口；窗口确认后当前应用退出，无需再次启动重复安装 |
| 缓存路径 | 下载后稍后安装、退出再打开，缓存仍重新校验大小、摘要、签名和时效；首次点击可进入安装 |
| 任务忙碌 | 延后安装，任务完成后由用户再次选择重启，不中断正在执行的任务 |
| 取消与失败 | 取消 UAC/安装或启动观察失败时旧版可继续使用；安装器退出状态未确定时保持互锁，避免重复启动 |
| 安装后 | 实际版本与目标一致，旧 Main/Runtime 已退出，重复启动仍为单实例；Runtime 与目标制品一致 |
| 数据与登录 | 合成设置、宠物、会话、附件、知识库、Skill 可用，同机同用户登录正常，允许 Token 正常轮换 |
| Portable | 仅提示打开固定 `/download`，不启动 NSIS 或原地替换自身；当前下载页提供 NSIS，不把它称为 Portable 制品 |
| 离线与信任失败 | 断网、暂停、过期、坏签名或缓存篡改均拒绝安装，旧版仍可运行；恢复后重新检查并主动重试 |
| 下载入口 | 正式 HTTPS 元数据、当前清单、制品入口及摘要有效；暂停阻止新发链，已签发短链可持续到自身到期 |

窗口出现不等于安装完成，仍须核对安装后版本、数据与 Runtime。更换 Electron、NSIS 或提权 helper 时，重新核对退出与窗口语义，不能沿用历史工具链结论。

## 3. 首次安装窗口异常

先确认**发起升级的旧客户端**包含窗口观察修复。仅上传新版 EXE 不会修改已经运行的旧版退出逻辑；历史 `0.2.4` 到 `0.2.5` 的复现与修复证据见[原记录](../archive/2026-10/validation/DESKTOP_UPDATE_P3B3_ACCEPTANCE.md#62-旧-024-升级到-025-的现场复现2026-10-15)。需要手动引导时从可信发布归档取得已核对安装包，再从该版本测试更高正式版本。

当前普通 NSIS 分支等待确切 PID 的可见顶层窗口，系统 PowerShell 或 Win32 查询受限时拒绝提前退出应用。helper 成功退出仅代表接受启动，不等于内层安装完成。窗口确认失败后核对本次安装器的 PID、路径与启动时间，不能批量结束不相关进程或再次反复启动安装。

诊断只提取实际用户数据目录 `logs/main.log` 中“桌面更新”的固定阶段、PID、退出码，以及首次/重试时间。不要发送完整日志、带签名 URL、Token、私钥、COS Secret 或用户正文。信任边界见[更新签名与下载基线](../features/DESKTOP_UPDATE_TRUST.md)。

## 4. 恢复与留证

- 下载或验签失败：保持旧版，按[清单维护指南](../../../petdock-office/petdock-cloud/docs/guides/DESKTOP_UPDATE_MANIFEST_RENEWAL.md)检查时效、暂停和事务；不修改公钥或放宽校验。
- 发布中断：用原 UUID 查询或恢复，保留冻结制品与事务；不重新构建覆盖同版本对象。
- 入口或安装异常：先暂停新分发，按[服务器发布工具指南](../../../petdock-office/petdock-cloud/docs/guides/DESKTOP_RELEASE_AUTOMATION.md)及[下载栈恢复指南](../../../petdock-office/petdock-cloud/docs/guides/DESKTOP_DOWNLOAD_P3B2_DEPLOYMENT.md)处理，保留最新预算数据库；撤下版本不会自动降级已安装客户端。

每次记录 Desktop/Cloud 提交、真实源/目标版本、制品与 Runtime 摘要、Windows 安装模式、矩阵实际结果和恢复结果。明确区分用户现场确认、本地合成检查及未执行项；既有验收结论见[归档 P3 收尾记录](../archive/2026-10/validation/DESKTOP_UPDATE_P3B3_ACCEPTANCE.md#63-p3-验收收尾2026-10-15)，不补写缺少的明细。
