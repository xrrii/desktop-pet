# P3-B3 桌面正式信任与安装更新验收

状态：Tracking。2026-10-04 开始。代码准备不是安装升级通过；本轮 `npm run dist`、安装与生产登记由用户执行。P1 已完成、P2 后置，P4 Jenkins 发布整合另行开展。

## 1. 已有证据与本批目标

用户已在服务器完成 `0.2.2` 私有 COS 对象 HEAD/Range、正式 HTTPS 元数据/清单/制品入口、完整包大小与 SHA-512、暂停 503/恢复 200 验收；root WAL/SHM 属主阻断已按 Cloud `f3356cd` 修复。现有 `0.2.2` 包没有内置正式更新配置，不能用它证明客户端自动更新。

本批准备 `0.2.3` 引导版手动安装，再以 `0.2.4` 验证主动下载和重启安装。只用正式 `stable` 渠道；测试机隔离不等于开发灰度。代码签名证书仍未购买，Windows 未知发布者提示仍存在。

Desktop 已内置以下公开配置，不支持环境变量、Renderer 或 Nacos 覆盖：

| 项目 | 值 |
| --- | --- |
| 更新源 | `https://download.petdock.site/` |
| 确切桶主机 | `petdock-1467993618.cos.ap-guangzhou.myqcloud.com` |
| keyId | `desktop-release-1` |
| 公钥 SPKI DER SHA-256 | `3307d64f9d378a546717d0c6b4d120a337ab78e829b64d215c9d3f61a4668ae7` |
| Portable 固定下载页 | `https://download.petdock.site/download` |

公钥已与仓库外本地 `0.2.2` 信封及正式 HTTPS 信封分别验签匹配。私钥仍留在可信签名机，COS Secret 留在服务器；客户端只带公钥。当前 `0.2.2` 清单 `expiresAt=2026-10-09T15:12:26Z`，即北京时间 **10 月 9 日 23:12:26**；到期前至少两天刷新或按批准流程移除不再分发的旧条目。目录中任何保留版本过期都会阻断整个入口。

## 2. 先收尾服务器与下载页

确认 [P3-B2 指南](../../../petdock-office/petdock-cloud/docs/guides/DESKTOP_DOWNLOAD_P3B2_DEPLOYMENT.md) 2.9 的专用只读身份、2.12 的费用告警、2.14 的证书续期与清单维护已有现场记录。先前对象可读不证明凭据没有写权限，告警也不能保证 10 元硬封顶。

`/download` 是本批新增路由，当前线上旧镜像与外层白名单不会自动拥有它。页面只展示当前已验签的 NSIS 安装版；**便携版制品暂未登记，页面明确显示未开放**。Portable 客户端只会打开此页，不下载或安装 EXE；提供真正 Portable 制品仍是后续待办，不能把 NSIS 当便携包发布。

### 2.1 备份、Git 同步与重建（Ubuntu）

下面整块包含 P3-B2 2.15 的升级准备：暂停、备份实际镜像、已部署源码、config 和运维入口，然后执行既有 Git 同步脚本。`UPGRADE_BACKUP` 在子 Shell 外设置供 2.2 使用；同一终端继续，避免并行 Jenkins/Git/运维任务。没有 `deployed-cloud.sha` 时先核实原构建 SHA，不能猜测。

```bash
UPGRADE_ID=$(date -u +%Y%m%dT%H%M%SZ)
UPGRADE_BACKUP=/opt/petdock/desktop-download/backups/upgrade-$UPGRADE_ID
(
set -euo pipefail
[[ "$UPGRADE_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
sudo /usr/local/sbin/petdock-downloadctl pause
OLD_CLOUD_SHA=$(sudo cat /opt/petdock/desktop-download/deployed-cloud.sha)
[[ "$OLD_CLOUD_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C /opt/petdock/source/petdock-cloud cat-file -e "$OLD_CLOUD_SHA^{commit}"
DOWNLOAD_CONTAINER=$(sudo /usr/local/sbin/petdock-download-compose ps -q desktop-download)
test -n "$DOWNLOAD_CONTAINER"
OLD_IMAGE_ID=$(sudo docker inspect --format '{{.Image}}' "$DOWNLOAD_CONTAINER")
sudo test ! -e "$UPGRADE_BACKUP"
sudo install -d -o root -g root -m 0700 "$UPGRADE_BACKUP"
sudo install -d -o root -g root -m 0755 "$UPGRADE_BACKUP/cloud-download-source"
git -C /opt/petdock/source/petdock-cloud archive "$OLD_CLOUD_SHA" \
  services/desktop-download deploy/desktop-download tools/desktop_cos_probe.py | \
  sudo tar -xf - -C "$UPGRADE_BACKUP/cloud-download-source"
sudo cp -a /opt/petdock/desktop-download/config "$UPGRADE_BACKUP/config"
sudo cp -a /opt/petdock/desktop-download/deployed-cloud.sha "$UPGRADE_BACKUP/deployed-cloud.sha"
sudo cp -a /usr/local/sbin/petdock-download-compose "$UPGRADE_BACKUP/petdock-download-compose"
sudo cp -a /usr/local/sbin/petdock-downloadctl "$UPGRADE_BACKUP/petdock-downloadctl"
sudo docker tag "$OLD_IMAGE_ID" "petdock-desktop-download:rollback-$UPGRADE_ID"
printf '%s\n' "petdock-desktop-download:rollback-$UPGRADE_ID" | \
  sudo tee "$UPGRADE_BACKUP/image.ref" >/dev/null
printf '本次升级备份：%s\n' "$UPGRADE_BACKUP"
sudo test -f "$UPGRADE_BACKUP/image.ref"
sudo test -d "$UPGRADE_BACKUP/config"
CLOUD_STATUS=$(git -C /opt/petdock/source/petdock-cloud status --porcelain)
WEB_STATUS=$(git -C /opt/petdock/source/petdock-web status --porcelain)
test -z "$CLOUD_STATUS"
test -z "$WEB_STATUS"
bash /opt/petdock/source/petdock-pull.sh
CLOUD_STATUS=$(git -C /opt/petdock/source/petdock-cloud status --porcelain)
WEB_STATUS=$(git -C /opt/petdock/source/petdock-web status --porcelain)
test -z "$CLOUD_STATUS"
test -z "$WEB_STATUS"
DEPLOYED_CLOUD_SHA=$(git -C /opt/petdock/source/petdock-cloud rev-parse HEAD)
sudo /usr/local/sbin/petdock-download-compose build desktop-download
sudo /usr/local/sbin/petdock-download-compose up -d --no-build --force-recreate \
  --wait --wait-timeout 180 desktop-download download-proxy
sudo /usr/local/sbin/petdock-download-compose exec -T desktop-download \
  python -c "import os; assert os.getuid()==10001; print('下载服务 UID 正确')"
test "$(git -C /opt/petdock/source/petdock-cloud rev-parse HEAD)" = "$DEPLOYED_CLOUD_SHA"
printf '%s\n' "$DEPLOYED_CLOUD_SHA" | sudo tee /opt/petdock/desktop-download/deployed-cloud.sha >/dev/null
sudo chmod 0640 /opt/petdock/desktop-download/deployed-cloud.sha
sudo /usr/local/sbin/petdock-downloadctl status
)
```

预期仍为 `paused=true/catalogValid=true/quotaAvailable=true`，统计没有重置。状态目录、SQLite、Secret、trust 和 catalog 沿用原部署；本批不重新初始化。镜像重建失败则保留暂停，不继续改外层入口。

### 2.2 更新第五站点白名单（Ubuntu）

在原来已通过 HTTPS 验收的第五站点配置上只增加 `/download` 白名单，保留证书、上游和其他现场配置。旧配置可能直接写 `ssl_certificate`，没有单独 TLS snippet；不能直接覆盖为依赖新 TLS snippet 的仓库模板。下面使用本次升级的原始备份生成候选，备份已存在时保留，可在同一 `UPGRADE_BACKUP` 下重试。脚本需要服务器 `python3`，生成器拒绝无法识别或多处匹配的白名单。

**旧 2.2 已报缺少 `petdock-desktop-download-tls.conf`：** 2.1 已成功，不重建下载服务、不重复创建升级备份。沿用原 `UPGRADE_BACKUP`，执行下面更新后的整块，候选从原 `nginx-download.conf` 备份生成；失败时恢复该备份并检查重建 Nginx，入口保持暂停。换终端后先把变量恢复为 2.1 输出的实际目录，不使用其他备份。

```bash
(
set -euo pipefail
PAGE_CHECK_PASSED=false
RESTORE_ON_FAILURE=false
PAGE_CANDIDATE=''
# 失败时暂停并恢复原站点；备份不覆盖，临时候选只属于当前子 Shell。
finish_page_check() {
  local result=$?
  trap - EXIT
  if [ "$PAGE_CHECK_PASSED" != true ]; then
    sudo /usr/local/sbin/petdock-downloadctl pause || \
      printf '%s\n' '暂停失败：按 P3-B2 2.15 执行 root 应急暂停。' >&2
    if [ "$RESTORE_ON_FAILURE" = true ]; then
      if ! sudo cp -a "$UPGRADE_BACKUP/nginx-download.conf" \
        /opt/petdock/production/nginx/snippets/petdock-desktop-download.conf || \
        ! sudo /usr/local/sbin/petdock-reload-nginx; then
        printf '%s\n' '原站点配置恢复失败，停止后续操作，按 P3-B2 2.15 恢复入口。' >&2
      fi
    fi
  fi
  if [ -n "$PAGE_CANDIDATE" ]; then
    if ! sudo rm -- "$PAGE_CANDIDATE"; then
      printf '%s\n' '临时候选清理失败，核对 PAGE_CANDIDATE 后手工处理。' >&2
    fi
  fi
  return "$result"
}
trap finish_page_check EXIT
test -n "${UPGRADE_BACKUP:-}"
sudo test -f "$UPGRADE_BACKUP/image.ref"
sudo /usr/local/sbin/petdock-downloadctl pause
if ! sudo test -f "$UPGRADE_BACKUP/nginx-download.conf"; then
  sudo test ! -e "$UPGRADE_BACKUP/nginx-download.conf"
  sudo cp -a /opt/petdock/production/nginx/snippets/petdock-desktop-download.conf \
    "$UPGRADE_BACKUP/nginx-download.conf"
fi
RESTORE_ON_FAILURE=true
command -v python3 >/dev/null
PAGE_CANDIDATE=$(sudo mktemp "$UPGRADE_BACKUP/nginx-download.page.XXXXXX")
sudo python3 - "$UPGRADE_BACKUP/nginx-download.conf" "$PAGE_CANDIDATE" <<'PY'
import re
import sys
from pathlib import Path

# 只匹配原有公开下载 location，保留证书配置和其他站点定制。
source = Path(sys.argv[1]).read_text(encoding='utf-8')
pattern = r'(?m)^([ \t]*location[ \t]+~[ \t]+\^/\()(?:download\|)?(latest\\\.yml\|manifests/[^\r\n]+)$'
matches = list(re.finditer(pattern, source))
assert len(matches) == 1 and '|releases/' in matches[0].group(2), '无法唯一识别旧白名单，停止修改'
candidate = re.sub(pattern, lambda match: match.group(1) + 'download|' + match.group(2), source)
Path(sys.argv[2]).write_text(candidate, encoding='utf-8')
print('候选只增加下载页白名单，原证书和上游配置保留。')
PY
sudo install -o root -g root -m 0644 \
  "$PAGE_CANDIDATE" \
  /opt/petdock/production/nginx/snippets/petdock-desktop-download.conf
sudo /usr/local/sbin/petdock-reload-nginx
sudo /usr/local/sbin/petdock-downloadctl resume
PAGE_HTTP_STATUS=$(curl --fail --silent --show-error --max-time 15 -o /dev/null -w '%{http_code}' \
  https://download.petdock.site/download)
test "$PAGE_HTTP_STATUS" = 200
curl --fail --silent --show-error --max-time 15 -o /dev/null https://petdock.site/
curl --fail --silent --show-error --max-time 15 -o /dev/null https://api.petdock.site/api/v1/health
printf '%s\n' '下载页与原站入口检查通过。'
PAGE_CHECK_PASSED=true
)
```

预期 Nginx 校验、健康等待及页面 200 通过；自动钩子清理临时候选。这段开放前必须已有 2.9/2.12 门禁。确认本次原始备份后，任何候选准备、安装或验收失败都会尝试暂停、恢复备份的 **第五站点 snippet** 并执行校验重建；任何恢复失败需停止后续操作，不能仅恢复下载开关。不要重置生产主配置或预算。随后按 P3-B2 2.13.2 对当前登记版本复验完整 HTTPS 和暂停/恢复；浏览下载页不消耗发链次数，点击制品才计预算。Cloud 回退仍按 2.15 保留安全运维入口。

## 3. 检查客户端信任接入（Windows）

以下在已更新的 Desktop 工作区 PowerShell 执行，不读私钥、不下载 EXE：

```powershell
$ErrorActionPreference = 'Stop'
Set-Location E:\project\desktop-pet
node tools/check_desktop_update_feed.mjs
if ($LASTEXITCODE -ne 0) { throw '正式元数据或客户端验签失败，不继续构建验收。' }
```

预期 `DESKTOP_UPDATE_FEED_CHECK_OK`、`mode=https-metadata-only`、keyId/公钥摘要如第 1 节；当前服务器仍指向 `0.2.2` 是合理结果。它使用源码中的实际验证器和公钥，在内存编译，检查服务器 JSON/YAML 元数据与签名一致；不启动 Electron、下载制品或消耗发链预算，不能代替真实客户端更新。

离线检查新签名信封时，用 `node tools/check_desktop_update_feed.mjs --envelope '签名信封绝对路径'`，预期 `mode=offline-envelope`。工具不接受指定其他源或公钥的参数，避免以错误信任表验收成功。

## 4. 构建并保留 0.2.3 引导版（Windows）

使用专用 Windows 测试用户或可恢复虚拟机快照。当前用户安装与所有用户安装分别取干净快照，避免同机同时混装；DPAPI 登录态验收保持同机、同一 Windows 用户。先备份正式使用的数据，测试只写合成会话、知识库和附件。

```powershell
& {
$ErrorActionPreference = 'Stop'
Set-Location E:\project\desktop-pet
$Version = (Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($Version -ne '0.2.3') { throw '当前步骤要求 0.2.3 引导版源码。' }
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if(l.version!==p.version || l.packages?.['']?.version!==p.version) process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw '应用与锁文件根版本不一致。' }
$Archive = Join-Path $env:USERPROFILE "PetDock-P3-B3\$Version"
if (Test-Path -LiteralPath $Archive) { throw '归档已存在，保留原目录，按 4.1 核对并重新归档。' }
npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw '源码检查失败。' }
npm.cmd run dist
if ($LASTEXITCODE -ne 0) { throw '引导版完整构建失败。' }
node -e "const asar=require('@electron/asar'); const p=JSON.parse(asar.extractFile(process.argv[1],'package.json').toString('utf8')); if(p.version!==process.argv[2]) process.exit(1)" 'release\win-unpacked\resources\app.asar' $Version
if ($LASTEXITCODE -ne 0) { throw '实际解包版本不一致，不归档。' }
New-Item -ItemType Directory -Path $Archive | Out-Null
Copy-Item -LiteralPath "release\PetDock Setup $Version.exe" -Destination $Archive
Copy-Item -LiteralPath "release\PetDock Portable $Version.exe" -Destination $Archive
Copy-Item -LiteralPath 'release\win-unpacked' -Destination $Archive -Recurse
foreach ($Relative in @("PetDock Setup $Version.exe", "PetDock Portable $Version.exe", 'win-unpacked\PetDock.exe', 'win-unpacked\resources\app.asar', 'win-unpacked\resources\python-runtime\petdock-assistant.exe')) {
    if ((Get-FileHash -LiteralPath "release\$Relative" -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath "$Archive\$Relative" -Algorithm SHA256).Hash) { throw "归档关键文件不一致：$Relative" }
}
Get-FileHash -LiteralPath "$Archive\PetDock Setup $Version.exe" -Algorithm SHA512
Get-FileHash -LiteralPath "$Archive\win-unpacked\resources\python-runtime\petdock-assistant.exe" -Algorithm SHA256
Write-Output "引导版归档校验通过：$Archive"
}
```

复制整个 `& { ... }` 块执行。交互终端里逐条执行时，一条 `throw` 不会阻止随后独立粘贴的命令；看到测试、版本或归档错误不能继续打包/复制。`test:runtime` 每次创建独立临时目录，避开旧 `temp/pytest-runtime` 的身份/ACL 冲突，不需要删除或放宽旧目录权限。

预期许可生成 `缺少正文=0`。`lazy-val@1.0.5` 的明确 MIT 声明已附标准正文，来源和上游未附原始版权行的事实记录在 `licenses/third-party/README.md`；不是取得上游原始 LICENSE 的声明。

手动运行归档中的 `PetDock Setup 0.2.3.exe` 安装一次。此包来自可信构建机与受控传递；应用层验签不能为首次手动安装提供 Windows 发布者身份。检查实际安装目录包含 `Uninstall PetDock.exe`，启动安装后的 EXE，解包目录不算安装态。

创建并记录合成基线：设置/宠物、可打开的会话和附件、可检索的知识库、可运行的 Skill，以及已登录状态。记录安装目录、Main/Runtime PID 与 Runtime 文件 SHA-256；PID 可用任务管理器查看，不记录 Token 或用户正文。服务器尚指向 `0.2.2` 时，`0.2.3` 的“当前已是最新版本”符合禁止降级策略，不要为测试临时关闭该策略。

### 4.1 已打包成功但归档存在或混合（Windows）

先保留已有归档。若旧命令在报错后仍执行复制，Setup/Portable 可能已覆盖为新版，而 `win-unpacked` 仍是旧版；单个 Runtime 摘要不能证明完整归档一致。下面不重新执行 `dist`，要求现有 `release` 已完整构建为 `0.2.3`，补过全部源码检查后创建带时间的新归档，并比对五项关键文件。新路径会打印出来，之后手动安装使用该新路径中的 Setup。

```powershell
& {
$ErrorActionPreference = 'Stop'
Set-Location E:\project\desktop-pet
$Version = (Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($Version -ne '0.2.3') { throw '当前步骤要求 0.2.3 引导版源码。' }
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if(l.version!==p.version || l.packages?.['']?.version!==p.version) process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw '先统一 0.2.3 引导版元数据。' }
npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw '源码检查失败，停止归档。' }
node -e "const asar=require('@electron/asar'); const p=JSON.parse(asar.extractFile(process.argv[1],'package.json').toString('utf8')); if(p.version!==process.argv[2]) process.exit(1)" 'release\win-unpacked\resources\app.asar' $Version
if ($LASTEXITCODE -ne 0) { throw '当前解包目录不属于 0.2.3，请重新完整构建。' }
$Archive = Join-Path $env:USERPROFILE ("PetDock-P3-B3\$Version-verified-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $Archive) { throw '新归档已存在，不覆盖。' }
New-Item -ItemType Directory -Path $Archive | Out-Null
Copy-Item -LiteralPath "release\PetDock Setup $Version.exe" -Destination $Archive
Copy-Item -LiteralPath "release\PetDock Portable $Version.exe" -Destination $Archive
Copy-Item -LiteralPath 'release\win-unpacked' -Destination $Archive -Recurse
foreach ($Relative in @("PetDock Setup $Version.exe", "PetDock Portable $Version.exe", 'win-unpacked\PetDock.exe', 'win-unpacked\resources\app.asar', 'win-unpacked\resources\python-runtime\petdock-assistant.exe')) {
    if ((Get-FileHash -LiteralPath "release\$Relative" -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath "$Archive\$Relative" -Algorithm SHA256).Hash) { throw "归档关键文件不一致：$Relative" }
}
Get-FileHash -LiteralPath "$Archive\PetDock Setup $Version.exe" -Algorithm SHA512
Get-FileHash -LiteralPath "$Archive\win-unpacked\resources\python-runtime\petdock-assistant.exe" -Algorithm SHA256
Write-Output "引导版归档校验通过：$Archive"
}
```

这段不会覆盖或删除旧归档，复制中断留下的新目录也不自动复用。归档校验通过后再手动安装及记录数据基线；随后才能进入第 5 节。

## 5. 准备 0.2.4 目标版（Windows、控制台、Ubuntu）

引导版及数据基线准备好之后再修改版本，不提前覆盖 `0.2.3` 构建归档：

```powershell
& {
$ErrorActionPreference = 'Stop'
Set-Location E:\project\desktop-pet
$Version = '0.2.4'
$Archive = Join-Path $env:USERPROFILE "PetDock-P3-B3\$Version"
if (Test-Path -LiteralPath $Archive) { throw '目标版归档已存在，保留原目录，停止重复构建。' }
npm.cmd version 0.2.4 --no-git-tag-version --allow-same-version
if ($LASTEXITCODE -ne 0) { throw '目标版版本更新失败。' }
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if(p.version!==process.argv[1] || l.version!==p.version || l.packages?.['']?.version!==p.version) process.exit(1)" $Version
if ($LASTEXITCODE -ne 0) { throw '目标版应用与锁文件根版本不一致。' }
npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw '目标版源码检查失败。' }
npm.cmd run dist
if ($LASTEXITCODE -ne 0) { throw '目标版完整构建失败。' }
node -e "const asar=require('@electron/asar'); const p=JSON.parse(asar.extractFile(process.argv[1],'package.json').toString('utf8')); if(p.version!==process.argv[2]) process.exit(1)" 'release\win-unpacked\resources\app.asar' $Version
if ($LASTEXITCODE -ne 0) { throw '实际解包版本不一致，不归档。' }
New-Item -ItemType Directory -Path $Archive | Out-Null
Copy-Item -LiteralPath "release\PetDock Setup $Version.exe" -Destination $Archive
Copy-Item -LiteralPath "release\PetDock Portable $Version.exe" -Destination $Archive
Copy-Item -LiteralPath 'release\win-unpacked' -Destination $Archive -Recurse
foreach ($Relative in @("PetDock Setup $Version.exe", "PetDock Portable $Version.exe", 'win-unpacked\PetDock.exe', 'win-unpacked\resources\app.asar', 'win-unpacked\resources\python-runtime\petdock-assistant.exe')) {
    if ((Get-FileHash -LiteralPath "release\$Relative" -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath "$Archive\$Relative" -Algorithm SHA256).Hash) { throw "归档关键文件不一致：$Relative" }
}
Get-FileHash -LiteralPath "$Archive\PetDock Setup $Version.exe" -Algorithm SHA512
Get-FileHash -LiteralPath "$Archive\win-unpacked\resources\python-runtime\petdock-assistant.exe" -Algorithm SHA256
Write-Output "目标版归档校验通过：$Archive"
}
```

整块完成版本更新、构建、实际解包版本检查和五项关键文件归档比对，并输出目标 Runtime 摘要；任一步失败都停止，不覆盖已有归档。若升版成功后检查或构建失败，可在修复原因后重试整块；`--allow-same-version` 允许重新执行同版本更新，后续检查与构建照常进行。复制中断后新归档可能已经存在，此时先保留目录、核对制品，不能直接删目录重跑。锁文件含空名称的根包，使用 Node 解析以兼容 Windows PowerShell 5.1 和 PowerShell 7。不要只给旧 EXE 改名。使用既有受控私钥和 **同一 keyId**，按 P3-B2 2.10 签最终 `0.2.4` Setup；先用第 3 节离线检查新信封，再上传原始对象名 `releases/0.2.4/PetDock Setup 0.2.4.exe`。本地签名以 root `package.json` 为版本源，签完后不改 EXE。

按 P3-B2 2.11 的 **SSH 传输片段** 将新信封放到 `/tmp/desktop-update-manifest.json`，沿用原公钥，不重新生成密钥或传私钥。已有目录使用下面 5.1 合并，不执行 2.11 的首次单版本生成器；随后执行 2.12、2.13.2 的对象和完整 HTTPS 验收。确需移除旧条目时先批准并留备份，不能把过期条目保留在目录中。

`0.2.4` 正式目录发布后，所有已接入的安装态客户端在下次检查会看到同一版本。务必先确保 `0.2.3` 只在隔离验收环境手动安装，避免未经人工验收把引导版分发给所有用户。此流程是本批人工验收准备，不接 Jenkins 或自动上传编排。

### 5.1 暂停并合并已有目录（Ubuntu）

在服务器同一终端设置版本，再复制整块。此命令只新增版本，要求严格高于当前版本；已有目标条目、未知候选、旧清单过期或新签名不匹配均停止。保持原 trust 和所有历史条目，不挂载 Secret 或 SQLite，不重置计数。输出的 `release-*` 备份目录用于本次登记回退。

```bash
UPDATE_VERSION='0.2.4'
(
set -euo pipefail
[[ "$UPDATE_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
sudo /usr/local/sbin/petdock-downloadctl pause
sudo test -f /tmp/desktop-update-manifest.json
sudo test ! -e /opt/petdock/desktop-download/config/catalog.candidate.json
RELEASE_BACKUP=/opt/petdock/desktop-download/backups/release-$(date -u +%Y%m%dT%H%M%SZ)
sudo test ! -e "$RELEASE_BACKUP"
sudo install -d -o root -g root -m 0700 "$RELEASE_BACKUP"
sudo cp -a /opt/petdock/desktop-download/config/trust.json "$RELEASE_BACKUP/trust.json"
sudo cp -a /opt/petdock/desktop-download/config/catalog.json "$RELEASE_BACKUP/catalog.json"
printf '本次登记备份：%s\n' "$RELEASE_BACKUP"
sudo chown root:root /tmp/desktop-update-manifest.json
sudo chmod 0640 /tmp/desktop-update-manifest.json
sudo docker run --rm -i --network none --user 0:0 --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --env UPDATE_VERSION="$UPDATE_VERSION" \
  --mount type=bind,source=/tmp/desktop-update-manifest.json,target=/input/manifest.json,readonly \
  --mount type=bind,source=/opt/petdock/desktop-download/config,target=/config \
  --entrypoint python petdock-desktop-download:p3-b2 - <<'PY'
import json
import os
import time
from dataclasses import replace
from pathlib import Path
from app.catalog import load_catalog
from app.config import DownloadSettings
from app.files import read_json
from app.trust import valid_version, verify_manifest

version = os.environ['UPDATE_VERSION']
assert valid_version(version), '批准版本格式无效'
settings = DownloadSettings(catalog_file=Path('/config/catalog.json'), trust_file=Path('/config/trust.json'))
now = time.time()
old = load_catalog(settings, now)
assert tuple(map(int, version.split('.'))) > tuple(map(int, old.current_version.split('.'))), '新版本必须递增'
assert version not in old.releases, '目标版本已登记，先核对，不覆盖'
envelope = read_json(Path('/input/manifest.json'), 65536)
verify_manifest(envelope, read_json(settings.trust_file, 65536), version, now)
candidate = {'schemaVersion': 1, 'currentVersion': version,
             'releases': {**old.releases, version: {'manifest': envelope}}}
path = Path('/config/catalog.candidate.json')
with path.open('x', encoding='utf-8') as stream:
    json.dump(candidate, stream, ensure_ascii=True, allow_nan=False)
    stream.write('\n')
os.chmod(path, 0o640)
verified = load_catalog(replace(settings, catalog_file=path), time.time())
assert verified.current_version == version
print(f'候选目录全部验签通过，保留 {len(verified.releases)} 个版本，入口仍暂停。')
PY
sudo chown root:10001 /opt/petdock/desktop-download/config/catalog.candidate.json
sudo mv -- /opt/petdock/desktop-download/config/catalog.candidate.json \
  /opt/petdock/desktop-download/config/catalog.json
sudo /usr/local/sbin/petdock-download-compose exec -T desktop-download \
  python - "$UPDATE_VERSION" <<'PY'
import os
import sys
import time
from app.catalog import load_catalog
from app.config import DownloadSettings

assert os.getuid() == 10001, '检查必须使用常驻服务身份'
catalog = load_catalog(DownloadSettings.from_environment(), time.time())
assert catalog.current_version == sys.argv[1], '批准版本不一致'
print(f'常驻服务读取全部清单通过，currentVersion={catalog.current_version}')
PY
sudo /usr/local/sbin/petdock-downloadctl status
sudo rm -- /tmp/desktop-update-manifest.json
)
```

预期仍为暂停、目录有效且当前版 `0.2.4`。任何失败不继续恢复入口；候选保留供核查，不直接删除后重跑。替换后服务验签失败时，在暂停下从输出的备份恢复 `catalog.json`，保留当前 trust、状态库和安全运维脚本，再按常驻身份验签。此段不负责同版本续期；旧版过期时先按 P3-B2 2.14 重签刷新再登记新版本。

## 6. 真实 NSIS 验收矩阵

每个取消场景从可恢复快照单独执行；缓存的旧包不能代替目标制品。验证过程中不改当前登记版本或公钥，保证时钟正确。

| 场景 | 操作与必须观察的结果 |
| --- | --- |
| 主动下载 | 从安装态 `0.2.3` 托盘检查更新；出现 `0.2.4` 后默认选择稍后，不产生 EXE 请求；明确点击下载才取包 |
| 稍后安装 | 下载后选择稍后，应用继续运行；普通退出/再次启动不自动安装；再次检查可重新主动下载或命中已验证缓存 |
| 忙碌延后 | 下载完成后运行真实合成聊天流/工具/知识库写入任务，选择重启应提示延后，任务正常结束；任务结束不自动安装，再次选择才继续 |
| 重启安装 | 明确选择重启，设置 flush、Runtime 停止，再启动已验证安装器；普通 NSIS 确认可见窗口后才请求退出，helper 仍以成功退出代表接受启动；不能强杀任务 |
| 启动失败 | 普通进程创建不等于窗口就绪，提前退出不关闭应用；观察失败先结束本次安装器，确认结束后恢复入口；无法确认结束则保持任务互锁，提示结束安装器后重试，不自动再开第二个安装器 |
| helper 的 UAC 取消 | `elevate.exe` 已 spawn 但 UAC 尚未接受时保持应用；取消或非零退出不退出应用，Runtime/任务入口恢复，下一次可重试 |
| 安装向导的 UAC/取消 | 普通 NSIS 已启动后再由向导请求 UAC，取消不应安装目标版；此时旧应用可能已退出，结束向导后旧版应能重新启动且数据可用。当前没有“安装准备握手”，不能宣称这类取消保证原应用一直运行 |
| 完成后的版本 | 安装目录及 `app.asar` 元数据为 `0.2.4`，运行的 Main 与 Runtime 来自目标安装目录；Runtime SHA-256 与目标制品一致，不要求两版 Runtime 摘要必然不同 |
| 数据与登录 | 第 4 节合成设置/宠物/会话/附件/知识库/Skill 均可使用，同机同用户登录仍有效；Token 可能正常轮换，不对比或输出密文 |
| 单实例 | 旧 Main/Runtime PID 已消失；重复启动恢复同一应用，不出现第二个 Runtime |
| Portable | 从可信构建归档运行 `0.2.3` Portable，检查后只提示打开固定 `/download` 页，当前页仅提供真实安装版，不调用 NSIS、不原地替换自己 |
| 离线与拒绝 | 断网/入口暂停/签名不匹配或过期均给固定错误，旧版可继续使用；未完成的下载不能进入安装 |

helper 退出语义核对的是当前锁定工具链的 Johannes Passing `elevate.exe`，本地 SHA-256 为 `9b1fbf0c11c520ae714af8aa9af12cfd48503eedecd7398d8992ee94d1b4dc37`；源见 [作者实现](https://github.com/jpassing/elevate/blob/master/Elevate/main.c)，核查 Git blob `15445a83b39045cd8ef3af4c536109a5fbe69237`。引擎未传 `-wait`，helper 不等整个安装器结束。工具链升级时必须重新核对，不能把此结论套给新版 helper。

### 6.1 首次重启安装没有窗口的修复复验（Windows）

2026-10-05 用户在两个个人电脑报告：检查、下载成功，首次重启安装后应用关闭，等待超过一分钟也没有 UAC 或安装窗口；重新启动并使用缓存再次安装才出现窗口。本次普通安装分支移除隐藏窗口标志，并等待确切 PID 的可见顶层窗口。Windows 系统 PowerShell 以只读 Win32 查询观察窗口，不启动安装器或提权；内部观察 30 秒、外层截止 35 秒。系统限制 PowerShell 或 `Add-Type` 时验证失败，不能跳过检查来退出应用。

窗口确认不是 NSIS 安装准备握手，也不表示安装完成。当前 helper 成功退出的语义保持不变，UAC 内层及真实 NSIS 时序仍要逐项复验。原来的隐藏标志在合成窗口上可复现不可见，但不把合成结果直接等同两台电脑的已确定根因。

**先手动安装含本次修复的客户端，再验收自动更新。** 修复属于发起安装的旧客户端：只把新 EXE 上传服务器，不能修复已运行旧版的退出逻辑。当前工作区版本由用户升为 `0.2.4`；下面按实际源码版本构建独立本地修复归档，不改源码版本、不覆盖已有归档或生产同版本对象。在可信构建机执行完整块：

```powershell
& {
$ErrorActionPreference = 'Stop'
Set-Location E:\project\desktop-pet
$Version = (Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw '源码版本必须是正式三段版本。' }
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if(l.version!==p.version || l.packages?.['']?.version!==p.version) process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw '应用与锁文件根版本不一致。' }
$Archive = Join-Path $env:USERPROFILE ("PetDock-P3-B3\$Version-launch-fix-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $Archive) { throw '修复归档已存在，不覆盖。' }
npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw '源码检查失败。' }
npm.cmd run dist
if ($LASTEXITCODE -ne 0) { throw '修复版完整构建失败。' }
node -e "const asar=require('@electron/asar'); const p=JSON.parse(asar.extractFile(process.argv[1],'package.json').toString('utf8')); if(p.version!==process.argv[2]) process.exit(1)" 'release\win-unpacked\resources\app.asar' $Version
if ($LASTEXITCODE -ne 0) { throw '实际解包版本不一致，不归档。' }
New-Item -ItemType Directory -Path $Archive | Out-Null
Copy-Item -LiteralPath "release\PetDock Setup $Version.exe" -Destination $Archive
Copy-Item -LiteralPath "release\PetDock Portable $Version.exe" -Destination $Archive
Copy-Item -LiteralPath 'release\win-unpacked' -Destination $Archive -Recurse
foreach ($Relative in @("PetDock Setup $Version.exe", "PetDock Portable $Version.exe", 'win-unpacked\PetDock.exe', 'win-unpacked\resources\app.asar', 'win-unpacked\resources\python-runtime\petdock-assistant.exe')) {
    if ((Get-FileHash -LiteralPath "release\$Relative" -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath "$Archive\$Relative" -Algorithm SHA256).Hash) { throw "归档关键文件不一致：$Relative" }
}
Get-FileHash -LiteralPath "$Archive\PetDock Setup $Version.exe" -Algorithm SHA512
Get-FileHash -LiteralPath "$Archive\win-unpacked\resources\python-runtime\petdock-assistant.exe" -Algorithm SHA256
Write-Output "本地修复引导版归档校验通过：$Archive"
}
```

1. 备份合成数据和登录基线，在两台测试机结束旧 PetDock 及遗留安装器；手动安装新归档中的 Setup，不使用旧缓存作为修复客户端。
2. 准备并批准高于该修复引导版的目标版本。若引导版为 `0.2.4`，目标应为更高正式版本；不可为测试放开降级，也不覆盖原已签名登记的 `0.2.4` 对象。目标按现有离线签名与目录合并流程人工发布。
3. 冷下载场景使用新的测试用户或快照，确保没有目标版本缓存；只点击一次重启安装。预期首次可见窗口正常出现，当前应用随后退出，不需要重新打开重复下载；完成后核对实际版本、Runtime、数据和单实例。
4. 从相同引导快照再执行缓存场景：下载后选稍后、普通退出、重开，命中缓存仍只点击一次重启安装。复验窗口、UAC 取消、任务延后和数据；不能只做这条路径就判首次安装通过。
5. 若仍异常，在任务管理器核对安装进程是否存在。只提取实际用户数据目录 `logs/main.log` 中包含“桌面更新”的脱敏阶段、PID、退出码；记录首次和重试各自的时间，不回传完整日志、Token 或下载 URL。启动确认失败时不强制结束当前应用，未确认安装器结束时按提示处理其 PID 后再重试。

## 7. 失败处理与记录

下载/验签失败保持旧版，重新检查后主动重试；清单过期先按正常签名登记刷新，不改客户端公钥来绕过。安装中断时停止分发，保留备份与预算，按实际 Windows 状态恢复旧版；撤下 `0.2.4` 只阻止后续下载，不会自动降级已升级客户端。

Cloud 入口异常按 P3-B2 2.15 暂停与镜像/snippet 回退，保留本轮修复后的运维入口和最新 SQLite。记录 Desktop/Cloud 提交、两版本制品与 Runtime 摘要、Windows 安装模式、各矩阵项真实结果、费用告警与清单维护证据。不要回传私钥、COS Secret、带签名 URL、Token 或完整生产日志。

所有必需现场项通过后才能将 P3-B3 安装更新闭环标为完成；若实际 Portable 制品、UAC 路径或运维门禁仍缺证，逐项保留待办。P4 的发布登记、上传和 Jenkins 自动化不纳入本批。
