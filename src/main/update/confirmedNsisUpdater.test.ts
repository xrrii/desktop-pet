import { EventEmitter } from 'node:events'
import type { ChildProcess, StdioOptions } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmedNsisUpdater } from './confirmedNsisUpdater'

const resourcesPath = process.resourcesPath
beforeEach(() => { Reflect.set(process, 'resourcesPath', process.cwd()) })
afterEach(() => {
  if (resourcesPath === undefined) Reflect.deleteProperty(process, 'resourcesPath')
  else Reflect.set(process, 'resourcesPath', resourcesPath)
})

/** 用可控子进程事件替身验证真实 NSIS 参数编排，不启动 EXE 或提权进程。 */
function setup(adminRightsRequired = false) {
  const children: Array<EventEmitter & { unref: ReturnType<typeof vi.fn> }> = []
  const quit = vi.fn()
  class SyntheticUpdater extends ConfirmedNsisUpdater {
    /** 测试只替换启动边界，仍使用引擎的 install/doInstall 和重试策略。 */
    protected override createInstallerProcess(_cmd: string, _args: string[], _env: NodeJS.ProcessEnv | undefined, _stdio: StdioOptions): ChildProcess {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
      children.push(child)
      return child as unknown as ChildProcess
    }
  }
  const updater = new SyntheticUpdater(null, {
    version: '0.2.1', name: 'PetDockSynthetic', isPackaged: true,
    appUpdateConfigPath: 'unused', userDataPath: 'unused', baseCachePath: 'unused',
    whenReady: async () => {}, relaunch: vi.fn(), quit, onQuit: vi.fn()
  })
  updater.logger = null
  // 下载与独立验证在适配器测试覆盖；这里只提供引擎安装方法要求的合成缓存描述。
  Reflect.set(updater, 'downloadedUpdateHelper', {
    file: 'synthetic.exe', downloadedFileInfo: { isAdminRightsRequired: adminRightsRequired }
  })
  return { updater, quit, children }
}

describe('NSIS 启动确认', () => {
  it('进程尚未发出 spawn 时保持应用，确认启动后只退出一次', async () => {
    const { updater, quit, children } = setup()
    const installing = updater.quitAndInstallConfirmed()
    expect(quit).not.toHaveBeenCalled()
    children[0].emit('spawn')
    await installing
    expect(quit).toHaveBeenCalledOnce()
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
