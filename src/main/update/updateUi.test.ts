import { describe, expect, it, vi } from 'vitest'
import { DesktopUpdateUi } from './updateUi'
import type { DesktopUpdateManager, UpdateSnapshot } from './updateManager'
import { DESKTOP_UPDATE_RELEASE } from './updatePolicy'

const electron = vi.hoisted(() => ({
  dialog: { showMessageBox: vi.fn() }, shell: { openExternal: vi.fn() }
}))
vi.mock('electron', () => electron)

/** 只替换状态管理边界，确认 Portable 不触发 NSIS 下载或安装命令。 */
function portableUi() {
  const status: UpdateSnapshot = {
    kind: 'portable', phase: 'available', version: '0.2.4', progress: null, message: '发现新版本 0.2.4。'
  }
  const manager = { check: vi.fn(), snapshot: () => status, download: vi.fn(), install: vi.fn() }
  return { manager, ui: new DesktopUpdateUi(manager as unknown as DesktopUpdateManager) }
}

describe('Portable 正式下载提示', () => {
  it('用户确认后只打开固定官方页，不触发下载或安装', async () => {
    vi.clearAllMocks()
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    const { manager, ui } = portableUi()
    await ui.open()
    expect(electron.shell.openExternal).toHaveBeenCalledExactlyOnceWith(DESKTOP_UPDATE_RELEASE.portableDownloadUrl)
    expect(manager.download).not.toHaveBeenCalled()
    expect(manager.install).not.toHaveBeenCalled()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ defaultId: 1, cancelId: 1 }))
  })

  it('用户选择稍后时不打开浏览器或执行安装', async () => {
    vi.clearAllMocks()
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const { manager, ui } = portableUi()
    await ui.open()
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
    expect(manager.download).not.toHaveBeenCalled()
    expect(manager.install).not.toHaveBeenCalled()
  })
})
