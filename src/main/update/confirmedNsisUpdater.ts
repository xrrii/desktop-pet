import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { join, resolve } from 'node:path'
import { NsisUpdater } from 'electron-updater'
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper'
import type { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import { InstallerProcessPendingError } from './installerLaunchError'

/** 沿用 NSIS 引擎的安装参数与提权策略，确认进程实际启动后才退出应用。 */
export class ConfirmedNsisUpdater extends NsisUpdater {
  private launches: Promise<boolean>[] = []
  private launchLog: (message: string) => void = () => {}

  /** 源由应用内置，缓存也固定本地配置，不依赖 publish=null 时不存在的 app-update.yml。 */
  constructor(...args: ConstructorParameters<typeof NsisUpdater>) {
    super(...args)
    this.downloadedUpdateHelper = new DownloadedUpdateHelper(join(this.app.baseCachePath, 'petdock-updater'))
  }

  /** 为检查和下载统一注入受限传输，不使用引擎自动创建的无域名边界网络层。 */
  setTransport(executor: ElectronHttpExecutor): void {
    Reflect.set(this, 'httpExecutor', executor)
  }

  /** 仅注入固定阶段日志，不输出安装路径、命令参数、下载地址或底层异常。 */
  setLaunchLogger(log: (message: string) => void): void {
    this.launchLog = log
  }

  /** 引擎原始 quitAndInstall 会提前安排退出，本入口等待异步启动结果再退出。 */
  async quitAndInstallConfirmed(): Promise<void> {
    this.launches = []
    try {
      if (!this.install(false, true)) throw new Error('更新安装器未接受启动请求。')
      let launched = false
      let failure: unknown
      let index = 0
      // 首次启动被拒绝时引擎可能尝试 elevate；记录并等待后来加入的尝试。
      while (index < this.launches.length) {
        launched = await this.launches[index++].catch((error: unknown) => { failure = error; return false })
        await Promise.resolve()
      }
      if (!launched) throw failure instanceof InstallerProcessPendingError ? failure : new Error('更新安装器进程未成功启动。')
      this.launchLog('桌面更新安装启动已确认，准备退出当前应用')
      this.app.quit()
    } catch (error) {
      this.quitAndInstallCalled = false
      this.launchLog('桌面更新安装启动未确认，保留当前应用和已验证下载')
      throw error
    }
  }

  /** 普通安装器须出现可见顶层窗口；提权辅助进程须退出成功，不把创建进程误判为就绪。 */
  protected override spawnLog(cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv, stdio: StdioOptions = 'ignore'): Promise<boolean> {
    const elevation = resolve(cmd).toLowerCase() === resolve(process.resourcesPath, 'elevate.exe').toLowerCase()
    const launch = new Promise<boolean>((resolve, reject) => {
      try {
        const child = this.createInstallerProcess(cmd, args, env, stdio)
        const pid = Number.isSafeInteger(child.pid) ? child.pid : '未知'
        this.launchLog(`${elevation ? '桌面更新正在等待提权辅助进程接受启动' : '桌面更新正在等待安装器可见窗口'}（PID=${pid}）`)
        let settled = false
        let spawned = false
        const observation = new AbortController()
        /** 一次启动只结算一次，窗口观察与进程提前退出之间不能互相覆盖。 */
        const finish = (error?: unknown): void => {
          if (settled) return
          settled = true
          observation.abort()
          child.removeListener('exit', onExit)
          if (error) reject(error)
          else {
            child.unref()
            resolve(true)
          }
        }
        /** 提权返回零代表启动被接受；普通安装器在窗口确认前退出一律保留应用。 */
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          this.launchLog(`桌面更新安装启动进程退出（PID=${pid}，退出码=${code ?? '无'}，终止信号=${signal ?? '无'}）`)
          if (elevation && code === 0 && signal === null) {
            this.launchLog('桌面更新提权辅助进程已接受安装启动')
            finish()
          } else {
            this.launchLog(elevation ? '桌面更新提权已取消或失败' : '桌面更新安装器在窗口就绪前退出')
            finish(new Error('安装器在启动确认前退出或提权被取消。'))
          }
        }
        child.on('error', (error) => {
          if (!spawned) finish(this.normalizeLaunchError(error))
          else this.launchLog('桌面更新安装进程操作失败，继续等待真实退出确认')
        })
        child.once('exit', onExit)
        child.once('spawn', () => {
          spawned = true
          if (!elevation) {
            if (child.pid === undefined) {
              finish(new Error('无法确认安装器进程身份。'))
              return
            }
            void this.waitForInstallerWindow(child.pid, observation.signal).then(() => {
              if (settled) return
              if (child.exitCode !== null || child.signalCode !== null) {
                finish(new Error('安装器在窗口确认前已经退出。'))
                return
              }
              this.launchLog('桌面更新已确认安装器可见窗口')
              finish()
            }, async () => {
              if (settled) return
              this.launchLog('桌面更新安装器窗口确认失败或超时')
              // 观察器失败不是安装器 EACCES，不能误触发引擎的再次提权启动。
              try {
                await this.stopUnconfirmedInstaller(child)
                finish(new Error('未能确认安装窗口，请检查安装器后重试。'))
              } catch (error) {
                finish(error)
              }
            })
          }
        })
      } catch (error) {
        reject(this.normalizeLaunchError(error))
      }
    })
    this.launches.push(launch)
    return launch
  }

  /** 窗口确认失败先结束本次普通安装器，无法确认退出时要求调用方继续阻止新任务。 */
  private async stopUnconfirmedInstaller(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try { child.kill() } catch { /* 下方以真实退出事件确认，不用 kill 返回值替代。 */ }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new InstallerProcessPendingError(closed)), 3000)
        })
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  /** 引擎的 ENOENT 会绕过启动确认改走 Shell，必须转为普通失败并保留当前应用。 */
  private normalizeLaunchError(error: unknown): unknown {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? new Error('更新安装器不存在或无法启动，请重新检查并下载。') : error
  }

  /** 只观察已启动 PID 的可见顶层窗口；不启动 EXE、不提权、不读取进程路径或命令行。 */
  protected waitForInstallerWindow(pid: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || !Number.isSafeInteger(pid) || pid <= 0 || !process.env.SystemRoot) {
      return Promise.reject(new Error('无法观察安装器窗口。'))
    }
    // Win32 枚举也接受 owned 对话框；MainWindowHandle 可能漏掉已显示的此类安装窗口。
    const script = `$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetDockInstallerWindow {
  private delegate bool Callback(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr state);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  // 只匹配本次启动 PID 的可见顶层窗口，不把其他进程的窗口当作安装器。
  public static bool HasWindow(int pid) {
    bool found = false;
    EnumWindows(delegate(IntPtr window, IntPtr state) {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner == (uint)pid && IsWindowVisible(window)) { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
  $target = [System.Diagnostics.Process]::GetProcessById(${pid})
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    $target.Refresh()
    if ($target.HasExited) { exit 1 }
    if ([PetDockInstallerWindow]::HasWindow(${pid})) { exit 0 }
    Start-Sleep -Milliseconds 100
  }
  exit 2
} catch { exit 3 }
finally { if ($null -ne $target) { $target.Dispose() } }`
    return new Promise<void>((resolve, reject) => {
      const observer = spawn(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
      ], { stdio: 'ignore', windowsHide: true })
      const timeout = setTimeout(() => {
        observer.kill()
        reject(new Error('安装器窗口观察超时。'))
      }, 35_000)
      /** 安装器已退出或本次启动已结算时，立即撤销只读观察进程。 */
      const abort = (): void => {
        clearTimeout(timeout)
        observer.kill()
        reject(new Error('安装器窗口观察已取消。'))
      }
      signal.addEventListener('abort', abort, { once: true })
      observer.once('error', () => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        reject(new Error('安装器窗口观察不可用。'))
      })
      observer.once('exit', (code, termination) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        if (code === 0 && termination === null) resolve()
        else reject(new Error('安装器没有可确认的窗口。'))
      })
    })
  }

  /** 使用无 shell 的分离进程启动器；用户已选择交互安装，不向安装器传递隐藏窗口标志。 */
  protected createInstallerProcess(cmd: string, args: string[], env: NodeJS.ProcessEnv | undefined, stdio: StdioOptions): ChildProcess {
    return spawn(cmd, args, { env, stdio, detached: true, windowsHide: false })
  }
}
