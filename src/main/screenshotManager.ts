import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AssistantAttachmentDropResult } from '../shared/assistant'
import type { ScreenshotOverlayPayload, ScreenshotSelectionInput } from '../shared/screenshot'
import { logError, logInfo } from './logger'
import type { AssistantManager } from './assistant/assistantManager'

const SCREENSHOT_SHORTCUT = 'F5'
const SCREENSHOT_CAPTURE_DELAY_MS = 120
const MIN_SELECTION_SIZE = 8

interface DisplayCapture {
  payload: ScreenshotOverlayPayload
  thumbnail: Electron.NativeImage
  bounds: Electron.Rectangle
}

interface NormalizedSelection {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 管理全局快捷键触发的截图会话，并把截图结果注入当前助手草稿附件。
 */
export class ScreenshotManager {
  private readonly overlays = new Map<number, BrowserWindow>()
  private readonly captures = new Map<number, DisplayCapture>()
  private wasPetWindowVisible = false
  private closingOverlays = false

  constructor(
    private readonly getPetWindow: () => BrowserWindow | null,
    private readonly assistantManager: AssistantManager,
    private readonly openAssistantForPet: (window: BrowserWindow) => void,
    private readonly emitAttachmentsStaged: (result: AssistantAttachmentDropResult) => void,
    private readonly emitStageError: (message: string) => void
  ) {}

  /** 注册截图窗口使用的 IPC 接口。 */
  registerIpc(): void {
    ipcMain.handle('screenshot:get-overlay', (event) => this.getOverlayPayload(event))
    ipcMain.handle('screenshot:confirm-selection', (event, input: ScreenshotSelectionInput) =>
      this.confirmSelection(event, input)
    )
    ipcMain.handle('screenshot:cancel', () => this.cancelCapture())
  }

  /** 注册全局 F5 快捷键；注册失败时仅记录日志。 */
  registerGlobalShortcut(): void {
    globalShortcut.unregister(SCREENSHOT_SHORTCUT)
    const registered = globalShortcut.register(SCREENSHOT_SHORTCUT, () => {
      void this.startCapture().catch((error: unknown) => {
        const message = normalizeScreenshotError(error)
        logError('screenshot capture failed to start', message)
        this.restorePetWindow()
        this.emitStageError(message)
      })
    })
    if (!registered) {
      logError('failed to register screenshot shortcut', SCREENSHOT_SHORTCUT)
      return
    }
    logInfo('screenshot shortcut registered', SCREENSHOT_SHORTCUT)
  }

  /** 释放全局快捷键和未完成的截图覆盖层。 */
  dispose(): void {
    globalShortcut.unregister(SCREENSHOT_SHORTCUT)
    this.closeOverlayWindows()
  }

  /** 启动一次新的截图会话；若已在截图中则直接聚焦现有覆盖层。 */
  async startCapture(): Promise<void> {
    if (this.overlays.size > 0) {
      this.focusFirstOverlay()
      return
    }

    const petWindow = this.getPetWindow()
    if (!petWindow || petWindow.isDestroyed()) {
      throw new Error('桌宠窗口当前不可用。')
    }

    this.wasPetWindowVisible = petWindow.isVisible()
    if (this.wasPetWindowVisible) {
      petWindow.hide()
    }

    // 等待桌宠窗口从桌面移除，避免把自己截进背景图。
    await delay(SCREENSHOT_CAPTURE_DELAY_MS)

    const captures = await captureDisplays()
    if (captures.length === 0) {
      throw new Error('未检测到可用屏幕。')
    }

    this.closingOverlays = false
    captures.forEach((capture, index) => {
      const overlay = this.createOverlayWindow(capture, index === 0)
      this.overlays.set(overlay.webContents.id, overlay)
      this.captures.set(overlay.webContents.id, capture)
    })
  }

  /** 取消当前截图会话并按需恢复桌宠显示状态。 */
  async cancelCapture(): Promise<void> {
    this.closeOverlayWindows()
    this.restorePetWindow()
  }

  /** 为截图页返回所属屏幕的背景图和尺寸信息。 */
  private getOverlayPayload(event: IpcMainInvokeEvent): ScreenshotOverlayPayload {
    const capture = this.captures.get(event.sender.id)
    if (!capture) {
      throw new Error('截图覆盖层不存在或已过期。')
    }
    return capture.payload
  }

  /** 确认选区后裁剪 PNG，暂存为附件，并自动展开助手。 */
  private async confirmSelection(
    event: IpcMainInvokeEvent,
    input: ScreenshotSelectionInput
  ): Promise<void> {
    const capture = this.captures.get(event.sender.id)
    if (!capture) {
      throw new Error('截图覆盖层不存在或已过期。')
    }

    const selection = normalizeScreenshotSelection(input, {
      width: capture.payload.imageWidth,
      height: capture.payload.imageHeight
    })
    if (!selection) {
      throw new TypeError('截图区域太小或超出范围。')
    }

    const screenshotPath = await this.writeCaptureFile(capture.thumbnail.crop(selection).toPNG())
    this.closeOverlayWindows()

    try {
      const petWindow = this.getPetWindow()
      if (!petWindow || petWindow.isDestroyed()) {
        throw new Error('桌宠窗口当前不可用。')
      }
      this.openAssistantForPet(petWindow)
      const attachments = await this.assistantManager.stageAttachments([screenshotPath])
      this.emitAttachmentsStaged({
        dropZone: 'conversation',
        attachments
      })
      logInfo('screenshot attachment staged', {
        displayId: capture.payload.displayId,
        width: selection.width,
        height: selection.height
      })
    } catch (error) {
      const message = normalizeScreenshotError(error)
      logError('failed to stage screenshot attachment', message)
      const petWindow = this.getPetWindow()
      if (petWindow && !petWindow.isDestroyed()) {
        this.openAssistantForPet(petWindow)
      }
      this.emitStageError(message)
    } finally {
      await rm(screenshotPath, { force: true }).catch(() => undefined)
    }
  }

  /** 创建覆盖单个显示器的全屏截图窗口。 */
  private createOverlayWindow(capture: DisplayCapture, focusWindow: boolean): BrowserWindow {
    const overlay = new BrowserWindow({
      x: capture.bounds.x,
      y: capture.bounds.y,
      width: capture.bounds.width,
      height: capture.bounds.height,
      show: false,
      frame: false,
      transparent: false,
      movable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: true,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      kiosk: true,
      fullscreenable: true,
      autoHideMenuBar: true,
      title: `PetDock Screenshot ${capture.payload.displayLabel}`,
      backgroundColor: '#05070bcc',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    overlay.setMenuBarVisibility(false)
    overlay.once('ready-to-show', () => {
      // Windows 下普通 fullscreen 仍可能被任务栏压住，kiosk 模式更适合临时截图遮罩。
      overlay.setBounds(capture.bounds, false)
      overlay.setKiosk(true)
      overlay.show()
      if (focusWindow) {
        overlay.focus()
      }
    })
    overlay.on('closed', () => {
      const id = overlay.webContents.id
      this.overlays.delete(id)
      this.captures.delete(id)
      if (!this.closingOverlays && this.overlays.size > 0) {
        void this.cancelCapture().catch((error: unknown) => {
          logError('failed to cancel screenshot session after overlay close', error)
        })
      }
      if (!this.closingOverlays && this.overlays.size === 0) {
        this.restorePetWindow()
      }
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      overlay.loadURL(new URL('screenshot.html', process.env.ELECTRON_RENDERER_URL).toString())
    } else {
      overlay.loadFile(join(__dirname, '../renderer/screenshot.html'))
    }

    return overlay
  }

  /** 关闭当前会话的全部覆盖层，并清空关联截图缓存。 */
  private closeOverlayWindows(): void {
    if (this.overlays.size === 0) {
      this.captures.clear()
      return
    }
    this.closingOverlays = true
    for (const overlay of this.overlays.values()) {
      if (!overlay.isDestroyed()) {
        overlay.destroy()
      }
    }
    this.overlays.clear()
    this.captures.clear()
    this.closingOverlays = false
  }

  /** 恢复被截图流程临时隐藏的桌宠窗口。 */
  private restorePetWindow(): void {
    const petWindow = this.getPetWindow()
    if (!petWindow || petWindow.isDestroyed()) {
      return
    }
    if (this.wasPetWindowVisible) {
      petWindow.showInactive()
    }
  }

  /** 把裁剪后的 PNG 临时写入用户数据目录，供附件管理器复制。 */
  private async writeCaptureFile(buffer: Buffer): Promise<string> {
    const directory = join(app.getPath('userData'), 'assistant', 'captures')
    await mkdir(directory, { recursive: true })
    const filePath = join(directory, `capture-${randomUUID()}.png`)
    await writeFile(filePath, buffer)
    return filePath
  }

  /** 将已打开的覆盖层重新置顶，避免重复按下快捷键时丢失焦点。 */
  private focusFirstOverlay(): void {
    const overlay = this.overlays.values().next().value as BrowserWindow | undefined
    if (overlay && !overlay.isDestroyed()) {
      overlay.show()
      overlay.focus()
    }
  }
}

/** 获取每个显示器的桌面缩略图，并保留用于裁剪的原始 NativeImage。 */
async function captureDisplays(): Promise<DisplayCapture[]> {
  const displays = screen.getAllDisplays()
  const maxWidth = Math.max(...displays.map((display) => Math.round(display.bounds.width * display.scaleFactor)))
  const maxHeight = Math.max(...displays.map((display) => Math.round(display.bounds.height * display.scaleFactor)))
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: maxWidth,
      height: maxHeight
    },
    fetchWindowIcons: false
  })

  return displays.flatMap((display, index) => {
    const source = sources.find((item) => item.display_id === String(display.id)) ?? (index === 0 ? sources[0] : null)
    if (!source || source.thumbnail.isEmpty()) {
      return []
    }
    const size = source.thumbnail.getSize()
    return [{
      bounds: display.bounds,
      thumbnail: source.thumbnail,
      payload: {
        displayId: String(display.id),
        displayLabel: displays.length === 1 ? '当前屏幕' : `屏幕 ${index + 1}`,
        imageDataUrl: source.thumbnail.toDataURL(),
        imageWidth: size.width,
        imageHeight: size.height
      }
    }]
  })
}

/** 归一化并裁剪截图选区，保证返回值落在图片边界内。 */
export function normalizeScreenshotSelection(
  input: ScreenshotSelectionInput,
  imageSize: { width: number; height: number }
): NormalizedSelection | null {
  if (
    !Number.isFinite(input.x) ||
    !Number.isFinite(input.y) ||
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.height) ||
    imageSize.width < 1 ||
    imageSize.height < 1
  ) {
    return null
  }

  const left = clamp(Math.round(input.x), 0, Math.max(0, imageSize.width - 1))
  const top = clamp(Math.round(input.y), 0, Math.max(0, imageSize.height - 1))
  const right = clamp(Math.round(input.x + input.width), left + 1, imageSize.width)
  const bottom = clamp(Math.round(input.y + input.height), top + 1, imageSize.height)
  const width = right - left
  const height = bottom - top

  if (width < MIN_SELECTION_SIZE || height < MIN_SELECTION_SIZE) {
    return null
  }

  return { x: left, y: top, width, height }
}

/** 把底层异常统一转换为可展示给用户的中文错误文本。 */
function normalizeScreenshotError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('too small') || message.includes('太小')) {
    return '截图区域太小，请重新框选。'
  }
  if (message.includes('未检测到可用屏幕')) {
    return '未检测到可截图的屏幕。'
  }
  if (message.includes('桌宠窗口当前不可用')) {
    return '桌宠窗口暂时不可用，请稍后重试。'
  }
  if (message.includes('附件')) {
    return message
  }
  return '截图失败，请重试。'
}

/** 返回介于上下界之间的整数坐标。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** 为窗口状态切换提供短暂异步让步。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
