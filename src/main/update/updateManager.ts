import { UpdateActivityGate } from './updateActivityGate'
import { UpdateVerificationError } from './signedUpdateManifest'

export type UpdatePackageKind = 'nsis' | 'portable' | 'unpacked' | 'development' | 'unsupported'
export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'deferred' | 'installing' | 'error'

export interface UpdateSnapshot {
  kind: UpdatePackageKind
  phase: UpdatePhase
  version: string | null
  progress: number | null
  message: string
}

export interface DesktopUpdater {
  check(): Promise<string | null>
  download(onProgress: (percent: number) => void): Promise<void>
  install(): void | Promise<void>
}

export interface UpdateLifecycle {
  prepare(): Promise<boolean>
  stop(): Promise<void>
  resume(): Promise<void>
}

/** 编排主动下载与主动安装；普通退出和任务完成都不会触发自动安装。 */
export class DesktopUpdateManager {
  private status: UpdateSnapshot
  private operation: Promise<void> | null = null

  constructor(
    kind: UpdatePackageKind,
    private readonly updater: DesktopUpdater | null,
    private readonly gate: UpdateActivityGate,
    private readonly lifecycle: UpdateLifecycle,
    private readonly onStatus: (status: UpdateSnapshot) => void,
    private readonly log: (message: string) => void,
    disabledReason = '正式更新源与签名验证尚未就绪。'
  ) {
    this.status = {
      kind,
      phase: updater ? 'idle' : 'disabled',
      version: null,
      progress: null,
      message: updater ? '尚未检查更新。' : disabledReason
    }
  }

  /** 读取托盘使用的脱敏状态，不暴露下载地址或更新器内部异常。 */
  snapshot(): UpdateSnapshot {
    return { ...this.status }
  }

  /** 合并重复检查；已下载版本在重启前保持不变，防止替换用户已选制品。 */
  check(): Promise<void> {
    if (!this.updater || ['downloaded', 'deferred', 'installing'].includes(this.status.phase)) {
      return Promise.resolve()
    }
    return this.perform(async () => {
      this.setStatus('checking', '正在检查更新。')
      const version = await this.updater!.check()
      this.status.version = version
      this.setStatus(version ? 'available' : 'current', version ? `发现新版本 ${version}。` : '当前已是最新版本。')
    }, '检查更新失败，请稍后重试。')
  }

  /** 仅响应用户下载命令，下载完成后仍需单独选择重启。 */
  download(): Promise<void> {
    if (!this.updater || this.status.kind !== 'nsis' || this.status.phase !== 'available') {
      return Promise.resolve()
    }
    return this.perform(async () => {
      this.setStatus('downloading', '正在下载更新。', 0)
      await this.updater!.download((percent) => {
        if (Number.isFinite(percent)) {
          this.setStatus('downloading', '正在下载更新。', Math.min(100, Math.max(0, percent)))
        }
      })
      this.setStatus('downloaded', '更新已下载，可以选择重启安装。', 100)
    }, '更新下载或验证失败，请重新检查后重试。')
  }

  /** 预留 Main 与 Runtime 后才停机；忙碌只延后，不取消任务或自动等待安装。 */
  install(): Promise<void> {
    if (!this.updater || this.status.kind !== 'nsis' || !['downloaded', 'deferred'].includes(this.status.phase)) {
      return Promise.resolve()
    }
    return this.perform(async () => {
      if (!this.gate.reserve()) {
        this.setStatus('deferred', '任务执行中，请完成后再次选择重启安装。', 100)
        return
      }
      try {
        if (!await this.lifecycle.prepare()) {
          this.setStatus('deferred', '任务执行中或状态暂不可确认，请稍后再次选择重启安装。', 100)
          await this.lifecycle.resume()
          this.gate.release()
          return
        }
        this.setStatus('installing', '正在保存状态并停止助手。', 100)
        await this.lifecycle.stop()
        await this.updater!.install()
      } catch (error) {
        await this.lifecycle.resume().catch(() => this.log('更新准备失败后恢复助手入口失败'))
        this.gate.release()
        if (error instanceof UpdateVerificationError) {
          this.setStatus('error', '更新验证失败，请重新检查并下载。')
          this.log('桌面更新制品信任失效，已恢复入口并要求重新检查')
          return
        }
        // 保留已验证下载，停机失败可以再次尝试；不触发任何强制退出。
        this.setStatus('downloaded', '安装准备失败，已保留下载，请稍后重试。', 100)
        this.log('桌面更新安装准备失败，未请求强制退出')
      }
    }, '安装更新失败，请稍后重试。')
  }

  /** 串行执行更新命令，确保重复点击不会重复下载或启动安装器。 */
  private perform(action: () => Promise<void>, errorMessage: string): Promise<void> {
    if (this.operation) {
      return this.operation
    }
    // 先登记 Promise，再执行状态回调，避免回调同步重入产生第二次操作。
    this.operation = Promise.resolve().then(action).catch(() => {
      this.setStatus('error', errorMessage)
      this.log('桌面更新操作失败；下载地址与底层异常已省略')
    }).finally(() => { this.operation = null })
    return this.operation
  }

  /** 发布稳定状态；日志只包含阶段，下载链接中的临时凭据不会进入日志。 */
  private setStatus(phase: UpdatePhase, message: string, progress: number | null = null): void {
    const changed = this.status.phase !== phase
    this.status = { ...this.status, phase, message, progress }
    if (changed) {
      this.log(`桌面更新状态：${phase}`)
    }
    this.onStatus(this.snapshot())
  }
}
