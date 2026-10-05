import type { UpdateInfo } from 'electron-updater'
import { ConfirmedNsisUpdater } from './confirmedNsisUpdater'
import { GuardedUpdateHttpExecutor } from './guardedUpdateHttpExecutor'
import type { DesktopUpdater, UpdatePackageKind } from './updateManager'
import { DESKTOP_UPDATE_RELEASE, requireOfficialUpdateUrl } from './updatePolicy'
import {
  DESKTOP_UPDATE_TRUST, isReleaseVersion, verifySignedUpdateManifest, verifyUpdateArtifact, UpdateVerificationError,
  type UpdateTrust, type VerifiedUpdateManifest
} from './signedUpdateManifest'

/** 适配现有更新引擎；摘要之外必须再通过独立的发布者验证，缓存命中也不例外。 */
export class ElectronDesktopUpdater implements DesktopUpdater {
  private candidate: VerifiedUpdateManifest | null = null
  private downloadedFile: string | null = null

  constructor(
    private readonly feedUrl: string,
    private readonly trust: UpdateTrust,
    private readonly engine: ConfirmedNsisUpdater = new ConfirmedNsisUpdater({ provider: 'generic', url: feedUrl }),
    private readonly transport = new GuardedUpdateHttpExecutor(feedUrl, DESKTOP_UPDATE_RELEASE.bucketHost),
    private readonly now = Date.now,
    log: (message: string) => void = () => {}
  ) {
    requireOfficialUpdateUrl(feedUrl)
    engine.setTransport(transport)
    engine.setLaunchLogger(log)
    // 不读取 builder 推断的源；关闭后台下载、普通退出安装、预发布和降级。
    engine.setFeedURL({ provider: 'generic', url: feedUrl, useMultipleRangeRequest: false })
    engine.autoDownload = false
    engine.autoInstallOnAppQuit = false
    engine.autoRunAppAfterInstall = true
    engine.allowPrerelease = false
    engine.allowDowngrade = false
    engine.disableWebInstaller = true
    // 首批先验证完整下载；差量与短期链接兼容性留到真实分发源验收。
    engine.disableDifferentialDownload = true
    engine.logger = null
    engine.on('error', () => {})
  }

  /** 使用正式渠道检查候选，并拒绝非正式版本、灰度字段和任意制品地址。 */
  async check(): Promise<string | null> {
    this.candidate = null
    this.downloadedFile = null
    this.transport.beginCheck()
    const result = await this.engine.checkForUpdates()
    if (!result) throw new Error('更新引擎未启用。')
    if (!result.isUpdateAvailable) return null
    const info = result.updateInfo
    if (!isReleaseVersion(info.version) || info.stagingPercentage !== undefined ||
        info.files?.length !== 1 || 'packages' in info) {
      throw new Error('更新元数据不符合正式整体安装包要求。')
    }
    const candidate = verifySignedUpdateManifest(await this.transport.readManifest(info.version), this.trust, info.version, this.now())
    this.requireMatchingMetadata(info, candidate)
    this.candidate = candidate
    return info.version
  }

  /** 引擎验证 SHA-512 后再验证独立签名；不将底层地址或异常传给界面和日志。 */
  async download(onProgress: (percent: number) => void): Promise<void> {
    if (!this.candidate) throw new Error('请先检查更新。')
    const candidate = this.revalidateCandidate()
    this.transport.beginDownload(candidate.manifest)
    this.downloadedFile = null
    const progress = (value: { percent: number }): void => onProgress(value.percent)
    this.engine.on('download-progress', progress)
    try {
      const files = await this.engine.downloadUpdate()
      if (files.length !== 1 || !await verifyUpdateArtifact(files[0], this.revalidateCandidate().manifest)) {
        throw new UpdateVerificationError('更新包发布者验证未通过。')
      }
      this.downloadedFile = files[0]
    } finally {
      this.engine.removeListener('download-progress', progress)
    }
  }

  /** 停机后再次验证已下载内容，确认安装进程启动才允许退出。 */
  async install(): Promise<void> {
    if (!this.candidate || !this.downloadedFile ||
        !await verifyUpdateArtifact(this.downloadedFile, this.revalidateCandidate().manifest)) {
      throw new UpdateVerificationError('安装前更新包验证未通过。')
    }
    await this.engine.quitAndInstallConfirmed()
  }

  /** 把未经签名的引擎元数据绑定到清单，不能替换下载路径、大小或摘要。 */
  private requireMatchingMetadata(info: UpdateInfo, candidate: VerifiedUpdateManifest): void {
    const file = info.files[0]
    const expected = candidate.manifest.artifact
    if (new URL(file.url, this.feedUrl).href !== this.transport.artifactUrl(candidate.manifest).href ||
        file.size !== expected.size || file.sha512 !== expected.sha512) {
      throw new Error('更新元数据与受信任的签名清单不一致。')
    }
  }

  /** 下载及安装前重验清单时效和本地撤销列表，不因先前验证成功永久接受缓存。 */
  private revalidateCandidate(): VerifiedUpdateManifest {
    if (!this.candidate) throw new Error('请先检查更新。')
    return verifySignedUpdateManifest(this.candidate.envelope, this.trust, this.candidate.manifest.version, this.now())
  }
}

/** 源、确切桶主机和发布公钥都经发布评审内置后，才可创建正式更新器。 */
export function createReleaseDesktopUpdater(kind: UpdatePackageKind, log: (message: string) => void = () => {}): DesktopUpdater | null {
  if (!['nsis', 'portable'].includes(kind) || !DESKTOP_UPDATE_RELEASE.trustReady ||
      !DESKTOP_UPDATE_RELEASE.feedUrl || !DESKTOP_UPDATE_RELEASE.bucketHost || !Object.keys(DESKTOP_UPDATE_TRUST.keys).length) return null
  return new ElectronDesktopUpdater(DESKTOP_UPDATE_RELEASE.feedUrl, DESKTOP_UPDATE_TRUST, undefined, undefined, undefined, log)
}
