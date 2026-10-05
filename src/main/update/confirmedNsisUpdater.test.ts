import { EventEmitter } from 'node:events'
import type { ChildProcess, StdioOptions } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmedNsisUpdater } from './confirmedNsisUpdater'
import { InstallerProcessPendingError } from './installerLaunchError'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: mocks.spawn
}))

const resourcesPath = process.resourcesPath
beforeEach(() => { Reflect.set(process, 'resourcesPath', process.cwd()) })
afterEach(() => {
  vi.useRealTimers()
  if (resourcesPath === undefined) Reflect.deleteProperty(process, 'resourcesPath')
  else Reflect.set(process, 'resourcesPath', resourcesPath)
})

/** 用可控子进程事件替身验证真实 NSIS 参数编排，不启动 EXE 或提权进程。 */
function setup(adminRightsRequired = false) {
  const children: Array<EventEmitter & { unref: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null }> = []
  const quit = vi.fn()
  const windowReady = vi.fn<(pid: number, signal: AbortSignal) => Promise<void>>().mockResolvedValue()
  const log = vi.fn()
  class SyntheticUpdater extends ConfirmedNsisUpdater {
    /** 测试只替换启动边界，仍使用引擎的 install/doInstall 和重试策略。 */
    protected override createInstallerProcess(_cmd: string, _args: string[], _env: NodeJS.ProcessEnv | undefined, _stdio: StdioOptions): ChildProcess {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn(), pid: 1000 + children.length, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null })
      child.kill.mockImplementation(() => { child.exitCode = 1; child.emit('exit', 1, null); return true })
      children.push(child)
      return child as unknown as ChildProcess
    }

    /** 用窗口观察替身控制就绪时间，不启动 PowerShell 或真实安装窗口。 */
    protected override waitForInstallerWindow(pid: number, signal: AbortSignal): Promise<void> {
      return windowReady(pid, signal)
    }
  }
  const updater = new SyntheticUpdater(null, {
    version: '0.2.1', name: 'PetDockSynthetic', isPackaged: true,
    appUpdateConfigPath: 'unused', userDataPath: 'unused', baseCachePath: 'unused',
    whenReady: async () => {}, relaunch: vi.fn(), quit, onQuit: vi.fn()
  })
  updater.logger = null
  updater.setLaunchLogger(log)
  // 下载与独立验证在适配器测试覆盖；这里只提供引擎安装方法要求的合成缓存描述。
  Reflect.set(updater, 'downloadedUpdateHelper', {
    file: 'synthetic.exe', downloadedFileInfo: { isAdminRightsRequired: adminRightsRequired }
  })
  return { updater, quit, children, windowReady, log }
}

describe('NSIS 启动确认', () => {
  it('创建进程不足以退出，确认可见主窗口后只退出一次', async () => {
    const { updater, quit, children, windowReady } = setup()
    let ready!: () => void
    windowReady.mockImplementationOnce(() => new Promise<void>((resolve) => { ready = resolve }))
    const installing = updater.quitAndInstallConfirmed()
    expect(quit).not.toHaveBeenCalled()
    children[0].emit('spawn')
    await Promise.resolve()
    expect(quit).not.toHaveBeenCalled()
    expect(children[0].unref).not.toHaveBeenCalled()
    expect(windowReady.mock.calls[0][0]).toBe(children[0].pid)
    ready()
    await installing
    expect(quit).toHaveBeenCalledOnce()
  })

  it.each([0, 1])('进程创建后窗口尚未就绪即退出 %s，不关闭应用，也不自动启动第二个安装器', async (code) => {
    const { updater, quit, children, windowReady, log } = setup()
    let ready!: () => void
    windowReady.mockImplementationOnce(() => new Promise<void>((resolve) => { ready = resolve }))
    const installing = updater.quitAndInstallConfirmed()
    const rejected = expect(installing).rejects.toThrow('未成功启动')
    children[0].emit('spawn')
    children[0].emit('exit', code, null)
    await rejected
    ready()
    await Promise.resolve()
    expect(quit).not.toHaveBeenCalled()
    expect(children).toHaveLength(1)
    expect(windowReady.mock.calls[0][1].aborted).toBe(true)
    expect(log).not.toHaveBeenCalledWith('桌面更新已确认安装器可见窗口')
    expect(log.mock.calls.some(([message]) => message.includes(`退出码=${code}`))).toBe(true)
  })

  it('窗口观察失败或超时保留应用，下一次显式重试仍要求窗口就绪', async () => {
    const { updater, quit, children, windowReady } = setup()
    windowReady.mockRejectedValueOnce(Object.assign(new Error('synthetic observer failure'), { code: 'EACCES' }))
    const installing = updater.quitAndInstallConfirmed()
    const rejected = expect(installing).rejects.toThrow('未成功启动')
    children[0].emit('spawn')
    await rejected
    expect(quit).not.toHaveBeenCalled()
    expect(children).toHaveLength(1)
    expect(children[0].kill).toHaveBeenCalledOnce()
    const retry = updater.quitAndInstallConfirmed()
    children[1].emit('spawn')
    await retry
    expect(quit).toHaveBeenCalledOnce()
  })

  it.each([false, true])('无法结束安装器且 kill 报错=%s 时，交付真实退出通知而不是普通可恢复失败', async (killError) => {
    vi.useFakeTimers()
    const { updater, quit, children, windowReady } = setup()
    windowReady.mockRejectedValueOnce(new Error('synthetic timeout'))
    const installing = updater.quitAndInstallConfirmed()
    const rejected = expect(installing).rejects.toBeInstanceOf(InstallerProcessPendingError)
    children[0].kill.mockImplementation(() => {
      if (killError) children[0].emit('error', Object.assign(new Error('synthetic kill failure'), { code: 'EACCES' }))
      return false
    })
    children[0].emit('spawn')
    await vi.advanceTimersByTimeAsync(3000)
    await rejected
    expect(quit).not.toHaveBeenCalled()
    expect(children).toHaveLength(1)
    children[0].emit('exit', 1, null)
  })

  it('窗口观察返回成功时进程已退出，仍拒绝关闭应用', async () => {
    const { updater, quit, children } = setup()
    const installing = updater.quitAndInstallConfirmed()
    const rejected = expect(installing).rejects.toThrow('未成功启动')
    children[0].exitCode = 1
    children[0].emit('spawn')
    await rejected
    expect(quit).not.toHaveBeenCalled()
  })

  it('交互安装进程使用可见启动标志，无 shell 且与父进程分离', () => {
    const { updater } = setup()
    Reflect.get(ConfirmedNsisUpdater.prototype, 'createInstallerProcess').call(updater, 'synthetic.exe', ['--updated'], undefined, 'ignore')
    expect(mocks.spawn).toHaveBeenLastCalledWith('synthetic.exe', ['--updated'], {
      env: undefined, stdio: 'ignore', detached: true, windowsHide: false
    })
  })

  it('异步启动失败不退出，并允许下一次显式重试', async () => {
    const { updater, quit, children } = setup()
    const installing = updater.quitAndInstallConfirmed()
    const rejected = expect(installing).rejects.toThrow('未成功启动')
    children[0].emit('error', Object.assign(new Error('synthetic launch failure'), { code: 'EINVAL' }))
    await rejected
    expect(quit).not.toHaveBeenCalled()
    const retry = updater.quitAndInstallConfirmed()
    children[1].emit('spawn')
    await retry
    expect(quit).toHaveBeenCalledOnce()
  })

  it('权限失败后的提权尝试也必须确认 spawn，提权失败仍不退出', async () => {
    const { updater, quit, children } = setup()
    const installing = updater.quitAndInstallConfirmed()
    const rejected = expect(installing).rejects.toThrow('未成功启动')
    children[0].emit('error', Object.assign(new Error('synthetic permission failure'), { code: 'EACCES' }))
    await Promise.resolve()
    expect(children).toHaveLength(2)
    expect(quit).not.toHaveBeenCalled()
    children[1].emit('error', Object.assign(new Error('synthetic elevation failure'), { code: 'EINVAL' }))
    await rejected
    expect(quit).not.toHaveBeenCalled()
  })

  it('ENOENT 不触发绕过确认的 Shell 启动，失败后保留应用', async () => {
    const require = createRequire(import.meta.url)
    const electronId = require.resolve('electron')
    require('electron')
    const entry = require.cache[electronId]!
    const previous = entry.exports
    const openPath = vi.fn(async () => '')
    entry.exports = { shell: { openPath } }
    try {
      const { updater, quit, children } = setup()
      const installing = updater.quitAndInstallConfirmed()
      const rejected = expect(installing).rejects.toThrow('未成功启动')
      children[0].emit('error', Object.assign(new Error('synthetic missing installer'), { code: 'ENOENT' }))
      await rejected
      expect(openPath).not.toHaveBeenCalled()
      expect(children).toHaveLength(1)
      expect(quit).not.toHaveBeenCalled()
    } finally {
      entry.exports = previous
    }
  })

  it('提权辅助进程 spawn 后继续保持应用，退出成功才确认启动', async () => {
    const { updater, quit, children } = setup(true)
    const installing = updater.quitAndInstallConfirmed()
    children[0].emit('spawn')
    await Promise.resolve()
    expect(quit).not.toHaveBeenCalled()
    expect(children[0].unref).not.toHaveBeenCalled()
    children[0].emit('exit', 0, null)
    await installing
    expect(quit).toHaveBeenCalledOnce()
  })

  it.each([[1, null], [1223, null], [null, 'SIGTERM']])('提权取消或异常退出 %s/%s 时保留应用并允许重试', async (code, signal) => {
    const { updater, quit, children } = setup(true)
    const installing = updater.quitAndInstallConfirmed()
    const rejected = expect(installing).rejects.toThrow('未成功启动')
    children[0].emit('spawn')
    children[0].emit('exit', code, signal)
    await rejected
    expect(quit).not.toHaveBeenCalled()
    const retry = updater.quitAndInstallConfirmed()
    children[1].emit('spawn')
    children[1].emit('exit', 0, null)
    await retry
    expect(quit).toHaveBeenCalledOnce()
  })

  it('普通启动权限失败后，提权 helper 必须接受 UAC 才允许退出', async () => {
    const { updater, quit, children } = setup()
    const installing = updater.quitAndInstallConfirmed()
    children[0].emit('error', Object.assign(new Error('synthetic permission failure'), { code: 'EACCES' }))
    await Promise.resolve()
    children[1].emit('spawn')
    await Promise.resolve()
    expect(quit).not.toHaveBeenCalled()
    children[1].emit('exit', 0, null)
    await installing
    expect(quit).toHaveBeenCalledOnce()
  })
})
