# 桌面更新签名与 Lighthouse 下载边界

状态：Active。更新日期：2026-10-01。适用于 P3-B1 本地底座；正式公钥、源、下载服务及真实安装升级尚未接入，正式更新保持关闭。阶段进度见 [实施方案](../plans/NACOS_AND_DESKTOP_AUTO_UPDATE_PLAN.md) 第 19 节。

## 1. 已确认的分发选择

- Windows x64 NSIS 更新整个应用及随包 Python Runtime；Portable 只提示进入固定下载页。
- 统一 `stable` 渠道，用户主动下载、下载后再次选择重启；任务忙碌时延后，再次确认后安装。
- 用户已创建腾讯云轻量对象存储（Lighthouse 版）的广州桶。使用私有桶与受限匿名下载入口，暂不开 CDN。
- 暂不购买代码签名证书。独立应用层签名验证更新内容，但 EXE 仍有 Windows 未知发布者提示，不能解决首次安装的发布者信任问题。
- 10 元/月是目标，允许小幅超支，仍需告警、限流及暂停演练；签名 URL 与账单告警不保证硬封顶。

## 2. 签名协议

固定算法为 Ed25519。客户端公钥表和撤销列表随应用内置，远程清单不能添加公钥、算法或安装参数。正式 `DESKTOP_UPDATE_TRUST.keys` 当前为空，`DESKTOP_UPDATE_RELEASE` 的入口、桶主机、下载页均未配置，`trustReady=false`。测试生成的合成密钥不会进入正式信任表。

签名信封字段严格固定为：

```json
{
  "schemaVersion": 1,
  "keyId": "release-key-id",
  "manifest": "原始 UTF-8 清单字节的标准 Base64",
  "signature": "64 字节 Ed25519 签名的标准 Base64"
}
```

签名字节为 UTF-8 的 `PetDock desktop update manifest v1\n{keyId}\n` 后接清单原始字节。验证时直接使用这些字节，不重新序列化 JSON；`keyId` 也绑定到签名，不能用相同公钥的新标识改变签名上下文。

清单字段严格固定为：

```json
{
  "schemaVersion": 1,
  "appId": "com.local.petdock",
  "version": "0.2.2",
  "channel": "stable",
  "platform": "win32",
  "arch": "x64",
  "artifact": {
    "kind": "nsis",
    "fileName": "PetDock Setup 0.2.2.exe",
    "size": 123,
    "sha512": "64 字节 SHA-512 摘要的标准 Base64"
  },
  "issuedAt": "2026-10-01T00:00:00Z",
  "expiresAt": "2026-10-31T00:00:00Z"
}
```

上例仅说明结构，摘要与体积不能用于真实发布。清单最大 32 KiB，安装包为 1 字节至 2 GiB。版本必须是无前导零的正式三段整数；文件名为安全 ASCII basename，允许 builder 当前包名的内部空格，拒绝路径、双点、Windows 设备名和末尾空格/点。时间为 UTC 秒格式，签发时间最多领先客户端五分钟，有效期不超过 30 天，过期直接拒绝。

`latest.yml` 中候选版本、单一 NSIS 文件路径、大小和 SHA-512 必须与受信任清单一致；拒绝灰度字段和 Web Installer 包描述。检查成功不会下载制品。下载前和安装前重验时效、撤销和签名；下载完成及安装前流式重读缓存文件、核对大小和摘要，缓存命中不豁免。信任失败进入错误状态并恢复任务入口，要求重新检查下载。

此边界防护远程分发内容替换，不防护已能以当前用户权限修改应用或在验证后替换本机文件的攻击者。系统时钟正确性和首次引导安装包的可信传递仍是前提。

## 3. 离线签名工具

`tools/sign_desktop_update.mjs` 只从指定 PEM 文件读取 Ed25519 私钥，不支持在参数或环境变量中提供明文私钥。产物使用 UTF-8 无 BOM；目标已存在时拒绝覆盖。签名结果绑定最终安装包的流式 SHA-512 和大小，签完后不得再修改 EXE。

下面命令为路径和日期示例，执行前应使用受控签名机器上的实际路径和当前时间；本批没有创建生产密钥或真实发布清单：

```powershell
node tools/sign_desktop_update.mjs `
  --artifact 'release\PetDock Setup 0.2.2.exe' `
  --version 0.2.2 `
  --key-id release-key-id `
  --private-key '受控目录\desktop-update-private.pem' `
  --issued-at 2026-10-01T00:00:00Z `
  --expires-at 2026-10-31T00:00:00Z `
  --output '受控输出目录\0.2.2.json'
```

生产私钥须保存在仓库外的受限目录，仅可信发布操作者或专用签名任务可读；禁止进入桶、仓库、普通构建、日志、聊天或测试快照。离线备份和保管责任需在真实启用前落实。脚本不配置 Windows ACL、不加密 PEM，也不代替密钥保管流程。

轮换时先用旧密钥签发包含新旧公钥的过渡客户端，再切换到新密钥签发。撤销列表只随受信任应用更新，当前没有在线撤销协议；私钥泄露时须暂停下载，发布受控引导安装包并通知旧客户端手动迁移，不能宣称已能远程撤销旧客户端信任。

清单过期会阻止尚未下载或未安装的候选。即使没有新版本，也须在有效期结束前离线重签同一版本的清单，并验证后替换入口清单；客户端已经取得的过期候选需重新检查。刷新与发布编排留到 P4，本批没有调度任务。

## 4. 下载入口与存储对象

Lighthouse 版不支持自定义源站域名。`download.petdock.site` 规划为自有 HTTPS 受限入口，由入口读取批准版本登记并签发短时只读 URL，302 到确切的桶默认域名；大文件由对象存储直接下发。P3-B2 已实现 Cloud 服务和隔离部署模板，见 [部署与验收指南](../../../petdock-office/petdock-cloud/docs/guides/DESKTOP_DOWNLOAD_P3B2_DEPLOYMENT.md)；DNS/TLS 和生产接入尚未完成，不能把下面路径合同当成已上线接口。

以客户端源 `https://download.petdock.site/` 为例：

| 路径 | 入口职责 | 客户端约束 |
| --- | --- | --- |
| `/latest.yml` | 小型正式版本元数据 | 最大 64 KiB，可接受引擎单一 `noCache` 参数 |
| `/manifests/{version}.json` | 对应离线签名信封 | 最大 64 KiB，不向桶重定向元数据 |
| `/releases/{version}/{fileName}` | 已登记制品的短时链接签发 | 只允许已验证的候选制品 |

桶对象 key 对应 `releases/{version}/{fileName}`，`fileName` 是实际带空格文件名，URL 每个文件名段用 `encodeURIComponent` 编码。若源含前缀，则对象 key 同样带此前缀，不能独立改变路径。不能把 `%20` 字面写入对象 key 后假定等同于空格。

客户端只允许内置确切大陆桶默认主机，例如合成域名 `synthetic-1250000000.cos.ap-guangzhou.myqcloud.com`，不采用通配域名。用户确认真实主机 `petdock-1467993618.cos.ap-guangzhou.myqcloud.com`，本批已实际验证合成对象读取，仍未内置到正式工厂。所有初始请求及重定向均要求 HTTPS、固定路径、GET/HEAD，不携带 Cookie、Authorization 或自定义 Host，不允许其他端口、任意域名、明文降级及匿名桶链接。

COS URL 必须具有单一、格式正确的 SDK 查询签名字段，最多 30 分钟有效期，可包含临时凭据的 `x-cos-security-token`。客户端检查格式和边界，实际 COS 授权由存储端验证；URL 本身不作为发布者信任凭证。每操作最多 12 个请求，元数据请求截止 15 秒，制品请求截止 30 分钟，并限制响应大小。日志与界面不记录带签名 URL 或底层异常。

本批 Node 回环验证完整下载、HEAD/Range、403 后主动重试经过入口取新链接及越界拒绝；`npm.cmd run test:updates:transport` 另用真实 Electron net 验证本机原生重定向、完整下载、缓存篡改、响应上限和超时，实际应用/会话目录也放在临时目录并清理，不启动安装器。两者的 COS `q-signature` 均为合成值，不是真实 SDK 授权。完整下载期间断线或链接过期后，需要重新检查并主动重试；未实现自动断点续传、差量或 blockmap。

上段保留 P3-B1 证据。P3-B2 的 `--cloud-python` 模式使用真实 Cloud 服务与官方 SDK 1.9.44，覆盖普通/STS Token 参数、GET/HEAD/Range、发链预算及热暂停，COS 正文仍为回环。另经用户授权，在真实桶临时上传 46 字节合成对象，验证匿名拒读、HEAD/Range 和摘要一致、短链接到期拒读及新签恢复，随后删除。该结果不代表正式安装包、生产入口或最小权限身份已验收。

## 5. Lighthouse 接入与费用防护待办

腾讯云官方资料于 2026-10-01 核查：[能力限制](https://cloud.tencent.com/document/product/1207/108904)、[计费概述](https://cloud.tencent.com/document/product/1207/80959)、[产品定价](https://cloud.tencent.com/document/product/1207/88189)。这些页面可能调整，正式启用前应复核。

| 项目 | 当前基线及待办 |
| --- | --- |
| 地域/桶 | 已确认广州 `petdock-1467993618`；46 字节临时私有对象验证并删除，未核查全部桶对象/ACL |
| SDK | Lighthouse 支持 COS SDK；上传 `StorageClass` 省略或用 `DEFAULT`，不能套用 `STANDARD` |
| 高级功能 | 不依赖标准 COS 的生命周期、版本控制和自定义源站域名；版本保留用明确对象清单人工管理 |
| 下载权限 | 独立最小权限身份，只允许读取批准 `releases/` 对象；凭据通过服务器 Secret 配置，禁止进入聊天 |
| 上传权限 | 另设身份，只允许目标制品路径，禁止客户端持有上传或账户管理权限 |
| 入口防护 | 只读登记、固定 key/URL、单 IP/全局限流、有界并发、热暂停和持久月发链预算已实现；真实流量/账单观测仍需平台接入 |
| 可信代理 | 限流前核对反向代理信任范围，不能直接信任客户端可伪造的 `X-Forwarded-For` |
| 暂停效果 | 停止新签发后，旧 URL 在有效期内仍可复用，已开始的下载可能继续；需实际演练并留证 |
| 云告警 | 低额预算与下行异常告警阈值待设置；账单存在延迟，不能用告警代替硬限额 |
| 真实验收 | SDK 普通凭据真实对象签发/到期与回环 Electron/STS 已验证；生产 TLS、专用只读身份、实际两版本 NSIS 升级及 UAC 取消仍待留证 |

广州容量单价 `0.00393333 元/GB/日`，大陆下行 `0.5 元/GB`，Lighthouse 不另收请求费，容量/流量按 1024 进制计量，超套餐仍按量计费。按历史 Setup `200942357` 字节和 Portable `200577840` 字节，保留两种包各三版约 `1.12 GiB`；20 人每月四次 Setup 全量下载约 `14.97 GiB`。按 30 天估算容量约 `0.13 元`、下行约 `7.49 元`，合计约 `7.62 元/月`。

该估算不包含重试、新用户安装、额外 Portable 下载、未来包增大、桶内其他对象/流量、入口服务增量费用或云服务调整。短时链接可复用，限流签发次数不等于限制下载字节；预算只作为运维目标。
