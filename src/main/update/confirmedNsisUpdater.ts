import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { join, resolve } from 'node:path'
import { NsisUpdater } from 'electron-updater'
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper'
import type { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'

/** 沿用 NSIS 引擎的安装参数与提权策略，确认进程实际启动后才退出应用。 */
export class ConfirmedNsisUpdater extends NsisUpdater {
  private launches: Promise<boolean>[] = []

  /** 源由应用内置，缓存也固定本地配置，不依赖 publish=null 时不存在的 app-update.yml。 */
  constructor(...args: ConstructorParameters<typeof NsisUpdater>) {
    super(...args)
    this.downloadedUpdateHelper = new DownloadedUpdateHelper(join(this.app.baseCachePath, 'petdock-updater'))
  }

  /** 为检查和下载统一注入受限传输，不使用引擎自动创建的无域名边界网络层。 */
  setTransport(executor: ElectronHttpExecutor): void {
    Reflect.set(this, 'httpExecutor', executor)
  }

  /** 引擎原始 quitAndInstall 会提前安排退出，本入口等待异步启动结果再退出。 */
  async quitAndInstallConfirmed(): Promise<void> {
    this.launches = []
    try {
      if (!this.install(false, true)) throw new Error('更新安装器未接受启动请求。')
      let launched = false
      let index = 0
      // 首次启动被拒绝时引擎可能尝试 elevate；记录并等待后来加入的尝试。
      while (index < this.launches.length) {
        launched = await this.launches[index++].catch(() => false)
        await Promise.resolve()
      }
      if (!launched) throw new Error('更新安装器进程未成功启动。')
      this.app.quit()
    } catch (error) {
      this.quitAndInstallCalled = false
      throw error
    }
  }

  /** 普通安装器确认 spawn；提权辅助进程须退出成功，不能把 UAC 等待误判为启动完成。 */
  protected override spawnLog(cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv, stdio: StdioOptions = 'ignore'): Promise<boolean> {
    const elevation = resolve(cmd).toLowerCase() === resolve(process.resourcesPath, 'elevate.exe').toLowerCase()
    const launch = new Promise<boolean>((resolve, reject) => {
      try {
        const child = this.createInstallerProcess(cmd, args, env, stdio)
        child.once('error', (error) => reject(this.normalizeLaunchError(error)))
        child.once('spawn', () => {
          if (!elevation) {
            child.unref()
            resolve(true)
          }
        })
        if (elevation) {
          // 当前锁定 helper 未使用 -wait；成功退出仅表示 ShellExecute/UAC 接受启动。
          child.once('exit', (code, signal) => {
            if (code === 0 && signal === null) {
              child.unref()
              resolve(true)
            } else {
              reject(new Error('提权已取消或安装器未接受启动请求。'))
            }
          })
        }
      } catch (error) {
        reject(this.normalizeLaunchError(error))
      }
    })
    this.launches.push(launch)
    return launch
  }

  /** 引擎的 ENOENT 会绕过启动确认改走 Shell，必须转为普通失败并保留当前应用。 */
  private normalizeLaunchError(error: unknown): unknown {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? new Error('更新安装器不存在或无法启动，请重新检查并下载。') : error
  }

  /** 使用无 shell 的分离进程启动器；命令与参数仅来自已验证的 NSIS 引擎。 */
  protected createInstallerProcess(cmd: string, args: string[], env: NodeJS.ProcessEnv | undefined, stdio: StdioOptions): ChildProcess {
    return spawn(cmd, args, { env, stdio, detached: true, windowsHide: true })
  }
}
