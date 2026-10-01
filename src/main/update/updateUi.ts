import { dialog, shell } from 'electron'
import { DesktopUpdateManager } from './updateManager'
import { DESKTOP_UPDATE_RELEASE, requireOfficialUpdateUrl } from './updatePolicy'

/** 托盘与启动检查共用原生确认交互，不接受 Renderer 提供的源地址或安装路径。 */
export class DesktopUpdateUi {
  private opening = false

  constructor(private readonly manager: DesktopUpdateManager) {}

  /** 显示当前状态；检查发现更新后，下载和重启分别取得用户的明确选择。 */
  async open(quiet = false): Promise<void> {
    if (this.opening) return
    this.opening = true
    try {
      await this.manager.check()
      let status = this.manager.snapshot()
      if (quiet && ['disabled', 'current', 'error'].includes(status.phase)) return
      if (status.phase === 'available') {
        if (status.kind === 'portable') {
          const url = DESKTOP_UPDATE_RELEASE.portableDownloadUrl
          const response = await this.confirm(status.message, url ? '打开下载页' : null)
          if (response === 0 && url) await shell.openExternal(requireOfficialUpdateUrl(url).toString())
          return
        }
        if (await this.confirm(status.message, '下载更新') !== 0) return
        await this.manager.download()
        status = this.manager.snapshot()
      }
      if (['downloaded', 'deferred'].includes(status.phase)) {
        if (await this.confirm(status.message, '重启安装') !== 0) return
        await this.manager.install()
        status = this.manager.snapshot()
        if (status.phase === 'installing') return
      }
      await this.confirm(status.message, null)
    } finally {
      this.opening = false
    }
  }

  /** 使用取消为默认选择，避免按回车意外开始下载或退出应用。 */
  private async confirm(message: string, command: string | null): Promise<number> {
    const result = await dialog.showMessageBox({
      type: 'info', title: 'PetDock 更新', message,
      buttons: command ? [command, '稍后'] : ['确定'],
      defaultId: command ? 1 : 0, cancelId: command ? 1 : 0, noLink: true
    })
    return result.response
  }
}
