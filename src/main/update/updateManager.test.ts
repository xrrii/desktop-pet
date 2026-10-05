import { describe, expect, it, vi } from 'vitest'
import { DesktopUpdateManager, type UpdatePackageKind } from './updateManager'
import { UpdateActivityGate } from './updateActivityGate'
import { detectUpdatePackageKind, requireOfficialUpdateUrl } from './updatePolicy'
import { UpdateVerificationError } from './signedUpdateManifest'
import { InstallerProcessPendingError } from './installerLaunchError'

/** 创建能控制检查、下载与停机顺序的合成更新器，不执行真实安装。 */
function setup(kind: UpdatePackageKind = 'nsis') {
  const gate = new UpdateActivityGate()
  const calls: string[] = []
  const updater = {
    check: vi.fn(async () => '0.2.2'),
    download: vi.fn(async (progress: (value: number) => void) => { progress(75) }),
    install: vi.fn(() => { calls.push('install') })
  }
  const lifecycle = {
    prepare: vi.fn(async () => { calls.push('prepare'); return true }),
    stop: vi.fn(async () => { calls.push('stop') }),
    resume: vi.fn(async () => { calls.push('resume') })
  }
  const manager = new DesktopUpdateManager(kind, updater, gate, lifecycle, vi.fn(), vi.fn())
  return { manager, updater, gate, lifecycle, calls }
}

describe('桌面更新编排', () => {
  it('检查不自动下载，下载不自动安装，用户选择重启后先互锁与停机', async () => {
    const { manager, updater, calls, gate } = setup()
    await manager.check()
    expect(manager.snapshot().phase).toBe('available')
    expect(updater.download).not.toHaveBeenCalled()
    await manager.download()
    expect(manager.snapshot().phase).toBe('downloaded')
    expect(updater.install).not.toHaveBeenCalled()
    await manager.install()
    expect(calls).toEqual(['prepare', 'stop', 'install'])
    expect(gate.snapshot().reserved).toBe(true)
  })

  it('Main 文件操作期间延后，完成后仍需再次选择安装', async () => {
    const { manager, updater, gate, lifecycle } = setup()
    await manager.check()
    await manager.download()
    let finish!: () => void
    const writing = gate.run(() => new Promise<void>((resolve) => { finish = resolve }))
    await manager.install()
    expect(manager.snapshot().phase).toBe('deferred')
    expect(lifecycle.prepare).not.toHaveBeenCalled()
    finish()
    await writing
    expect(updater.install).not.toHaveBeenCalled()
    await manager.install()
    expect(updater.install).toHaveBeenCalledOnce()
  })

  it('Runtime 后台工作仍忙时延后并解除新请求冻结', async () => {
    const { manager, updater, gate, lifecycle } = setup()
    lifecycle.prepare.mockResolvedValue(false)
    await manager.check()
    await manager.download()
    await manager.install()
    expect(manager.snapshot().phase).toBe('deferred')
    expect(lifecycle.resume).toHaveBeenCalledOnce()
    expect(gate.snapshot().reserved).toBe(false)
    expect(updater.install).not.toHaveBeenCalled()
    expect(lifecycle.stop).not.toHaveBeenCalled()
  })

  it.each(['prepare', 'stop'] as const)('互锁或停机 %s 失败时不安装，并允许重试', async (step) => {
    const { manager, updater, gate, lifecycle } = setup()
    lifecycle[step].mockRejectedValueOnce(new Error('synthetic failure'))
    await manager.check()
    await manager.download()
    await manager.install()
    expect(manager.snapshot().phase).toBe('downloaded')
    expect(gate.snapshot().reserved).toBe(false)
    expect(updater.install).not.toHaveBeenCalled()
    await manager.install()
    expect(updater.install).toHaveBeenCalledOnce()
  })

  it('预留安装后拒绝新任务；重复安装点击合并为一次', async () => {
    const { manager, updater, gate, lifecycle } = setup()
    let complete!: (value: boolean) => void
    lifecycle.prepare.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    await manager.check()
    await manager.download()
    const installing = manager.install()
    const again = manager.install()
    await Promise.resolve()
    await expect(gate.run(() => true)).rejects.toThrow('正在准备安装更新')
    complete(true)
    await Promise.all([installing, again])
    expect(updater.install).toHaveBeenCalledOnce()
  })

  it('下载损坏或验证失败不进入可安装状态，重新检查后可重试', async () => {
    const { manager, updater } = setup()
    updater.download.mockRejectedValueOnce(new Error('invalid signature'))
    await manager.check()
    await manager.download()
    await manager.install()
    expect(manager.snapshot().phase).toBe('error')
    expect(updater.install).not.toHaveBeenCalled()
    await manager.check()
    await manager.download()
    expect(manager.snapshot().phase).toBe('downloaded')
  })

  it('安装前清单过期或缓存篡改后恢复任务入口，要求重新检查下载', async () => {
    const { manager, updater, gate, lifecycle } = setup()
    updater.install.mockImplementationOnce(() => { throw new UpdateVerificationError() })
    await manager.check()
    await manager.download()
    await manager.install()
    expect(manager.snapshot().phase).toBe('error')
    expect(manager.snapshot().message).toContain('重新检查并下载')
    expect(gate.snapshot().reserved).toBe(false)
    expect(lifecycle.resume).toHaveBeenCalledOnce()
    await expect(gate.run(() => '任务入口已恢复')).resolves.toBe('任务入口已恢复')
    await manager.install()
    expect(updater.install).toHaveBeenCalledOnce()
    await manager.check()
    await manager.download()
    await manager.install()
    expect(updater.check).toHaveBeenCalledTimes(2)
    expect(updater.download).toHaveBeenCalledTimes(2)
    expect(updater.install).toHaveBeenCalledTimes(2)
  })

  it('重复检查和下载点击不会执行多次操作', async () => {
    const { manager, updater } = setup()
    await Promise.all([manager.check(), manager.check()])
    await Promise.all([manager.download(), manager.download()])
    expect(updater.check).toHaveBeenCalledOnce()
    expect(updater.download).toHaveBeenCalledOnce()
  })

  it('安装器未确认结束时保持互锁并拒绝重复启动，退出后恢复且仍需用户主动重试', async () => {
    const { manager, updater, gate, lifecycle } = setup()
    let close!: () => void
    const closed = new Promise<void>((resolve) => { close = resolve })
    updater.install.mockImplementationOnce(() => { throw new InstallerProcessPendingError(closed) })
    await manager.check()
    await manager.download()
    await manager.install()
    expect(manager.snapshot().message).toContain('请结束该安装器进程')
    expect(gate.snapshot().reserved).toBe(true)
    expect(lifecycle.resume).not.toHaveBeenCalled()
    await expect(gate.run(() => '新任务')).rejects.toThrow('正在准备安装更新')
    await manager.install()
    expect(updater.install).toHaveBeenCalledOnce()
    close()
    await vi.waitFor(() => expect(gate.snapshot().reserved).toBe(false))
    expect(lifecycle.resume).toHaveBeenCalledOnce()
    expect(manager.snapshot().phase).toBe('downloaded')
    expect(updater.install).toHaveBeenCalledOnce()
    await manager.install()
    expect(updater.install).toHaveBeenCalledTimes(2)
  })

  it('Portable 只检查版本，不能下载或启动 NSIS 安装器', async () => {
    const { manager, updater } = setup('portable')
    await manager.check()
    await manager.download()
    await manager.install()
    expect(manager.snapshot().phase).toBe('available')
    expect(updater.download).not.toHaveBeenCalled()
    expect(updater.install).not.toHaveBeenCalled()
  })

  it('未配置真实更新源时保持关闭', async () => {
    const { gate, lifecycle } = setup()
    const manager = new DesktopUpdateManager('nsis', null, gate, lifecycle, vi.fn(), vi.fn())
    await manager.check()
    await manager.download()
    await manager.install()
    expect(manager.snapshot().phase).toBe('disabled')
    expect(lifecycle.prepare).not.toHaveBeenCalled()
  })
})

describe('更新安装形态与源策略', () => {
  it.each([
    [false, 'win32', false, false, 'development'],
    [true, 'linux', false, false, 'unsupported'],
    [true, 'win32', true, true, 'portable'],
    [true, 'win32', false, false, 'unpacked'],
    [true, 'win32', false, true, 'nsis']
  ])('识别 packaged=%s platform=%s portable=%s installed=%s', (packaged, platform, portable, nsisInstalled, expected) => {
    expect(detectUpdatePackageKind({ packaged: Boolean(packaged), platform: String(platform), portable: Boolean(portable), nsisInstalled: Boolean(nsisInstalled) })).toBe(expected)
  })

  it.each(['http://download.petdock.site/', 'https://evil.test/', 'https://user:password@download.petdock.site/', 'https://download.petdock.site/?token=secret', 'https://download.petdock.site:8443/'])('拒绝不可信地址 %s', (url) => {
    expect(() => requireOfficialUpdateUrl(url)).toThrow()
  })
})
