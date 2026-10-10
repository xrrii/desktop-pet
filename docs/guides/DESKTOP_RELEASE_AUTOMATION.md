# 桌面一键发布操作指南

状态：Tracking。2026-10-05。实现 Windows 本地发布编排；Jenkins 尚未接入，P3-B3 两台真实 NSIS 首次安装复验继续按[验收指南 6.1](DESKTOP_UPDATE_P3B3_ACCEPTANCE.md#61-首次重启安装没有窗口的修复复验windows)执行。本轮开发不连接生产 SSH、不构建正式发行包、不读取生产私钥或上传对象。

## 1. 命令与发布行为

一次性配置完成后，在可信 Windows x64 电脑的 Desktop 根目录执行：

```powershell
npm run release:desktop -- --version 0.2.5
```

`0.2.5` 是用法示例，实际版本由你批准，必须高于服务器当前版且不低于本地源码版。命令会依次执行：

1. 核对仓库外配置、SSH 私钥位置、签名密钥与客户端正式公钥、Python COS SDK。
2. 更新 `package.json` 和锁文件两处根版本，保留其他内容；记录源码提交和工作区差异摘要。
3. 执行 `npm run check`，通过后运行 `npm run dist -- --win --x64`，包括 Python Runtime。
4. 在独立事务目录归档 Setup、Portable、整个 `win-unpacked`，校验真实 `app.asar` 版本及五个关键文件摘要。
5. 调用现有 Ed25519 离线签名工具，生成 29 天有效清单，再以客户端内置正式公钥验签。
6. 用专用身份将 Setup 上传广州私有 Lighthouse 桶，服务端禁止覆盖。相同事务重试只读核对已存在对象，内容不符则停止。
7. 通过 SSH 的固定受控入口传送清单 JSON，服务器校验完整历史目录并保存候选。
8. 显示版本、大小、SHA-512、事务编号。必须在交互终端输入确切版本号，才会切换正式目录。
9. 服务器先暂停、切换、以常驻 UID/GID `10001` 验签，再恢复入口。客户端检查元数据与清单、HEAD 302、下载整包并校验 SHA-512，成功后提交事务。

这不是 Windows 受信任发布者代码签名，Windows 未知发布者提示仍存在。COS 只上传 NSIS EXE，清单通过 SSH 登记，`latest.yml` 仍由下载服务生成；Portable 保留本地归档，未新增 Portable 自动安装或公开发行逻辑。

## 2. 一次性服务器安装（你在 Ubuntu 执行）

先按 Cloud [发布工具部署指南](../../../petdock-office/petdock-cloud/docs/guides/DESKTOP_RELEASE_AUTOMATION.md)完成 Git 拉取、固定 wrapper、事务目录、必要的 `sudo -n` 权限和本地验签检查。源码同步继续使用 `/opt/petdock/source/petdock-pull.sh`；发布命令不会向服务器复制源码、重建业务服务或更换生产 Secret。

命令只执行固定远程入口：

```text
sudo -n /usr/local/sbin/petdock-desktop-release
```

它通过 stdin 接受有限 JSON，不接受远程 shell、路径、公钥或预算参数。安装前不要执行正式发布命令。现有 `petdock-downloadctl`、TLS、Nginx、COS 只读身份与预算必须已经正常；服务器工具不挂载 SQLite，不清零统计，不更新信任表。

## 3. 一次性准备 Windows 环境

使用项目现有 Node/npm 与 Python 3.13。新建 COS SDK 专用环境，避免改动 Runtime 环境；所有外部进程退出码都必须检查。在 Desktop 根目录整块执行：

```powershell
& {
$ErrorActionPreference = 'Stop'
$Cloud = (Resolve-Path '..\petdock-office\petdock-cloud').Path
$Python = Join-Path $Cloud 'services\desktop-download\.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $Python -PathType Leaf)) {
    py -3.13 -m venv (Join-Path $Cloud 'services\desktop-download\.venv')
    if ($LASTEXITCODE -ne 0) { throw 'COS SDK Python 环境创建失败。' }
}
& $Python -m pip install -r (Join-Path $Cloud 'services\desktop-download\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'COS SDK 依赖安装失败。' }
Get-Command ssh.exe -ErrorAction Stop | Out-Null
Write-Output 'Windows 依赖准备完成。'
}
```

确认 Runtime 自身 `.venv`、PyInstaller 和 NSIS 构建环境已按[开发指南](DEVELOPMENT.md)配置；发布命令使用现有 `check`/`dist`，不会安装缺失的打包依赖。

## 4. 一次性配置凭据路径

已知签名私钥位于用户目录 `secure-keys\petdock-release\ed25519-private.pem`。保持该密钥不变，不能为每次发布重新生成一对密钥；新密钥不能被旧客户端自动信任。SSH 私钥位于用户目录 `.ssh\petdock_server.pem`。私钥、COS 凭据与发布配置都留在仓库外，并使用 Windows 文件权限限制为当前可信用户；不要复制到归档、服务器、COS 或 Git。

COS 发布身份与服务器只读身份分离，仅授予 `petdock-1467993618` 桶 `releases/*` 的 `GetObject`（HEAD 使用该权限）与 `PutObject`；不需要列桶、删除对象或更改桶权限。Lighthouse 使用默认存储类型，不写 `STANDARD`。临时 STS 凭据有效时间应覆盖完整发布时长。

推荐将发布凭据保存为用户目录 `PetDock-release-input\cos-upload.json`，格式如下，值由你本机填入：

```json
{
  "secretId": "由专用发布身份取得",
  "secretKey": "由专用发布身份取得"
}
```

使用 STS 时另外增加 `securityToken` 字符串和 `expiresAt` Unix 秒整数。凭据正文不要进入终端、聊天或源码。旧测试 CSV 不会自动复用。

在 Desktop 根目录整块创建配置；已有文件时停止，避免覆盖你的配置。`$CosCredentialsFile` 应改为实际文件路径：

```powershell
& {
$ErrorActionPreference = 'Stop'
$InputDirectory = Join-Path $env:USERPROFILE 'PetDock-release-input'
$ConfigPath = Join-Path $InputDirectory 'release.config.json'
$CosCredentialsFile = Join-Path $InputDirectory 'cos-upload.json'
$Cloud = (Resolve-Path '..\petdock-office\petdock-cloud').Path
$Config = [ordered]@{
    schemaVersion = 1
    ssh = [ordered]@{
        host = 'ubuntu@106.55.17.245'
        port = 22
        identityFile = (Join-Path $env:USERPROFILE '.ssh\petdock_server.pem')
    }
    signing = [ordered]@{
        keyId = 'desktop-release-1'
        privateKeyFile = (Join-Path $env:USERPROFILE 'secure-keys\petdock-release\ed25519-private.pem')
    }
    cosCredentialsFile = $CosCredentialsFile
    cloudRepository = $Cloud
    pythonExecutable = (Join-Path $Cloud 'services\desktop-download\.venv\Scripts\python.exe')
}
if (Test-Path -LiteralPath $ConfigPath) { throw '发布配置已存在，请核对后手动编辑，不覆盖。' }
foreach ($Path in @($Config.ssh.identityFile, $Config.signing.privateKeyFile, $Config.cosCredentialsFile, $Config.pythonExecutable)) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw '必需的本地文件缺失，请核对配置路径。' }
}
New-Item -ItemType Directory -Force -Path $InputDirectory | Out-Null
[System.IO.File]::WriteAllText($ConfigPath, ($Config | ConvertTo-Json -Depth 6) + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Output '发布路径配置已创建，未读取密钥正文。'
}
```

完整结构参考 [合成配置样例](../../tools/desktop_release.example.json)。可用 `--config` 指定另一份仓库外配置，不接受环境变量中的明文密钥。

## 5. 一次性 SSH 信任与免交互权限

**本次开发会话不连接 SSH。以下由你手动执行。** 发布命令使用 `StrictHostKeyChecking=yes`，不会自动接受新主机。先从可信腾讯云控制台或原服务器登录渠道核对 SSH 主机指纹，再在本机完成一次正常登录并保存 `known_hosts`：

```powershell
ssh.exe -i "$env:USERPROFILE\.ssh\petdock_server.pem" ubuntu@106.55.17.245
```

只有实际指纹与可信渠道一致才接受；不要用未经核查的 `ssh-keyscan` 自动信任。登录后按 Cloud 指南确认固定发布入口可以 `sudo -n` 执行；“可以交互 sudo”并不证明 `sudo -n` 已可用。缺少权限时在服务器安装针对该固定入口的最小 sudoers 规则，不开启任意免密 root 命令。

## 6. 每次正式发布

1. 确认本地源码修改确实属于本次发布，提交/推送按现有 Git 流程执行。未忽略的构建源码必须已被 Git 追踪；发布命令允许已知 tracked 未提交修改，记录其差异摘要，并在构建后再次比较，不会自动提交代码。
2. 核对正式目录所有历史清单仍有效。任何保留版本过期都会阻断全目录，工具会拒绝，不会默默删除历史版本或更换信任表。2026-10-10 用户确认 `0.2.2` 已过期、`0.2.4` 将于 10 月 11 日到期，先按[清单续签与过期恢复](../../../petdock-office/petdock-cloud/docs/guides/DESKTOP_UPDATE_MANIFEST_RENEWAL.md)刷新全部清单，再继续发布；现场已续签则以当前目录为准。
3. 批准更高三段正式版本，在可信 Windows x64 交互终端执行发布命令。构建期间不要修改源码、打包输出或同时运行其他 `dist`。
4. 等待上传与服务器候选验签，核对显示的版本、字节数和 SHA-512；输入版本号确认后上线。其余输入会取消，留下本地归档及 COS 对象，不删除或覆盖正式对象。
5. 只在出现“正式发布完成，HTTPS 整包大小与 SHA-512 校验通过”时记录发布成功；随后按 P3-B3 指南执行真实客户端升级验收。

每次正式 HTTPS 验收会额外下载一份安装包，GET 计入 COS 流量及服务发链预算，HEAD 也计入发链次数。10 元/月仍是目标，不是硬封顶；重试会增加验收流量，工具不重置预算或自动扩大额度。

## 7. 断线、失败与恢复

事务编号启动时打印；本地冻结制品、签名与记录保存在 `release-runs/<事务UUID>`，由现有 `release-*/` 忽略规则排除，不进入 Git。不要删除尚未结束事务的目录。

```powershell
# 查询和恢复都由你主动运行，使用原事务编号。
npm run release:desktop -- --status '替换为本次事务UUID'
npm run release:desktop -- --resume '替换为本次事务UUID'
# 如服务器处于切换中间状态，应先恢复旧目录并保持暂停。
npm run release:desktop -- --abort '替换为本次事务UUID'
```

`--resume` 不重复 `dist` 或重签清单，必须重新验签和核对冻结 EXE。服务器已提交时只复验元数据，不重复下载；服务器已激活但未提交时需重新人工确认并下载整包验收。若构建没有成功归档，或签名已过期，不能将半成品作为恢复发布输入。

已取消事务在查明原因后也可使用 `--resume`：工具会复验原制品与签名，再生成新的服务器事务编号，复用原冻结 EXE 和原清单，不重新构建、不覆盖 COS 对象。若此前发生过切换并回退，入口仍保持暂停；先由你在服务器完成旧目录/权限/预算检查并恢复入口，再重试发布。签名已过期则不能复用。不要重新构建相同版本来绕过恢复流程；新 EXE 内容不同会被拒绝覆盖。

切换失败会尝试恢复旧目录并保持下载入口暂停。如果 SSH 同时断线，工具不能保证已执行暂停或回退；立即按 Cloud 指南在服务器执行 `petdock-downloadctl pause`（失败时走 root 应急暂停），再查询本次事务。确认目录、身份权限和预算正常后，由你决定何时恢复入口。回退目录不会自动降级已安装的新客户端。

正常退出会删除本地互斥锁。强制结束或电脑重启可能保留 `release-runs/.release.lock`；先在任务管理器确认没有本次发布 Node 进程及其构建子进程，再删除**仅该锁文件**并使用原事务恢复。不要清空 `release-runs` 或服务器事务记录。

## 8. 开发验证与未完成项

开发检查：`npm run test:release` 使用合成事务、真实客户端验签器和注入传输，覆盖顺序门禁、人工取消、断线、错误回应、已有提交恢复、版本同步、锁与 URL/摘要边界。它不会执行 SSH、访问 COS 或启动安装器；该测试已纳入 `npm run check`。

实际命令首次构建、真实 COS 上传、SSH 权限/断线与服务器 UID 验签、正式 HTTPS 发布仍须由你按本指南验收。Jenkins Windows 节点、CI Credentials、Nacos 发布整合未开发；P3-B3 两台真实安装窗口修复验收尚未完成，不以发布编排测试代替客户端安装证据。
