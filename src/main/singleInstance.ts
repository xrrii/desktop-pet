/** Electron 单实例协调所需的最小应用接口，便于隔离测试。 */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean
  quit(): void
  isReady(): boolean
  on(event: 'second-instance', listener: () => void): unknown
}

/** 恢复主实例窗口所需的最小窗口接口。 */
export interface SingleInstanceWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

interface SingleInstanceOptions {
  getWindow: () => SingleInstanceWindow | null
  openWindow: () => void
  logInfo: (message: string) => void
}

/**
 * 申请应用单实例锁，并把后续启动请求转交给已经运行的主实例。
 *
 * @return 当前进程是否为持有锁的主实例
 */
export function configureSingleInstance(
  app: SingleInstanceApp,
  options: SingleInstanceOptions
): boolean {
  if (!app.requestSingleInstanceLock()) {
    options.logInfo('检测到 PetDock 已在运行，当前重复启动进程退出')
    app.quit()
    return false
  }

  app.on('second-instance', () => {
    options.logInfo('检测到 PetDock 重复启动请求，恢复已有窗口')
    const window = options.getWindow()
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) {
        window.restore()
      }
      window.show()
      window.focus()
      return
    }
    if (app.isReady()) {
      options.openWindow()
    }
  })
  return true
}
