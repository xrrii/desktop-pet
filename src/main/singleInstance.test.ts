import { describe, expect, it, vi } from 'vitest'

import {
  configureSingleInstance,
  type SingleInstanceApp,
  type SingleInstanceWindow
} from './singleInstance'

/** 创建可触发 second-instance 的最小应用替身。 */
function createApp(lockAcquired: boolean, ready = true) {
  let secondInstanceListener: (() => void) | null = null
  const app: SingleInstanceApp = {
    requestSingleInstanceLock: vi.fn(() => lockAcquired),
    quit: vi.fn(),
    isReady: vi.fn(() => ready),
    on: vi.fn((_event, listener) => {
      secondInstanceListener = listener
    })
  }
  return {
    app,
    emitSecondInstance: () => secondInstanceListener?.()
  }
}

/** 创建用于验证恢复行为的窗口替身。 */
function createWindow(minimized = false): SingleInstanceWindow {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn()
  }
}

describe('configureSingleInstance', () => {
  it('未取得锁时退出重复启动进程', () => {
    const { app } = createApp(false)
    const openWindow = vi.fn()
    const logInfo = vi.fn()

    expect(configureSingleInstance(app, { getWindow: () => null, openWindow, logInfo })).toBe(false)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(app.on).not.toHaveBeenCalled()
    expect(openWindow).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith('检测到 PetDock 已在运行，当前重复启动进程退出')
  })

  it('重复启动时显示并聚焦已有窗口', () => {
    const { app, emitSecondInstance } = createApp(true)
    const window = createWindow()
    const openWindow = vi.fn()

    expect(configureSingleInstance(app, {
      getWindow: () => window,
      openWindow,
      logInfo: vi.fn()
    })).toBe(true)
    emitSecondInstance()

    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('已有窗口最小化时先恢复再聚焦', () => {
    const { app, emitSecondInstance } = createApp(true)
    const window = createWindow(true)

    configureSingleInstance(app, {
      getWindow: () => window,
      openWindow: vi.fn(),
      logInfo: vi.fn()
    })
    emitSecondInstance()

    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('主实例就绪但窗口已销毁时重新创建窗口', () => {
    const { app, emitSecondInstance } = createApp(true)
    const window = createWindow()
    vi.mocked(window.isDestroyed).mockReturnValue(true)
    const openWindow = vi.fn()

    configureSingleInstance(app, {
      getWindow: () => window,
      openWindow,
      logInfo: vi.fn()
    })
    emitSecondInstance()

    expect(openWindow).toHaveBeenCalledOnce()
    expect(window.show).not.toHaveBeenCalled()
  })

  it('主实例尚未就绪时等待正常启动流程创建窗口', () => {
    const { app, emitSecondInstance } = createApp(true, false)
    const openWindow = vi.fn()

    configureSingleInstance(app, {
      getWindow: () => null,
      openWindow,
      logInfo: vi.fn()
    })
    emitSecondInstance()

    expect(openWindow).not.toHaveBeenCalled()
  })
})
