import { BrowserWindow, app, screen } from 'electron'
import { join } from 'node:path'
import { logError, logInfo } from './logger'
import { loadSettings, updateSettings } from './store'

export const PET_WIDTH = 192
export const PET_HEIGHT = 208

interface DragSession {
  grabOffset: {
    x: number
    y: number
  }
  startPosition: {
    x: number
    y: number
  }
  petSize: {
    width: number
    height: number
  }
}

export interface DragMoveResult {
  x: number
  y: number
  totalDx: number
  totalDy: number
  localX: number
  localY: number
}

const dragSessions = new WeakMap<BrowserWindow, DragSession>()

export function createPetWindow(): BrowserWindow {
  const settings = loadSettings()
  const scale = settings.scale
  const width = Math.round(PET_WIDTH * scale)
  const height = Math.round(PET_HEIGHT * scale)
  const savedPosition = settings.position
  const position =
    savedPosition && !isLikelyCorruptedTopLeftPosition(savedPosition.x, savedPosition.y)
      ? savedPosition
      : getDefaultPosition(width, height)
  const boundedPosition = keepInsideDisplay(position.x, position.y, width, height)

  const window = new BrowserWindow({
    width,
    height,
    x: boundedPosition.x,
    y: boundedPosition.y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: 'PetDock',
    icon: getAssetPath('assets', 'app', 'icon.png'),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  window.setVisibleOnAllWorkspaces(false)
  window.setAlwaysOnTop(settings.alwaysOnTop, 'floating')
  applyClickThrough(window, settings.clickThrough)

  window.once('ready-to-show', () => {
    logInfo('pet window ready to show')
    window.showInactive()
  })

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logError('renderer failed to load', { errorCode, errorDescription, validatedURL })
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    logError('renderer process gone', details)
  })

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    logError('preload error', { preloadPath, error })
  })

  window.on('moved', () => {
    if (dragSessions.has(window)) {
      return
    }

    const [x, y] = window.getPosition()
    updateSettings({ position: { x, y } })
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
    if (process.env.DESKTOP_PET_DEVTOOLS === '1') {
      window.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.webContents.once('did-finish-load', () => {
    logInfo('renderer finished load')
  })

  return window
}

export function getDefaultPosition(width = PET_WIDTH, height = PET_HEIGHT): { x: number; y: number } {
  const display = screen.getPrimaryDisplay()
  const area = display.workArea
  return {
    x: area.x + area.width - width - 32,
    y: area.y + area.height - height - 32
  }
}

export function keepInsideDisplay(
  x: number,
  y: number,
  width = PET_WIDTH,
  height = PET_HEIGHT
): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint({ x, y })
  const area = display.workArea
  const minX = area.x
  const minY = area.y
  const maxX = area.x + area.width - width
  const maxY = area.y + area.height - height

  return {
    x: Math.min(Math.max(Math.round(x), minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(Math.round(y), minY), Math.max(minY, maxY))
  }
}

export function movePetWindow(window: BrowserWindow, x: number, y: number): { x: number; y: number } {
  const [width, height] = window.getSize()
  const next = keepInsideDisplay(x, y, width, height)
  window.setPosition(next.x, next.y, false)
  updateSettings({ position: next })
  return next
}

export function resetPetWindowPosition(window: BrowserWindow): { x: number; y: number } {
  const settings = loadSettings()
  const width = Math.round(PET_WIDTH * settings.scale)
  const height = Math.round(PET_HEIGHT * settings.scale)
  const next = getDefaultPosition(width, height)

  dragSessions.delete(window)
  window.setBounds({
    x: next.x,
    y: next.y,
    width,
    height
  }, false)
  updateSettings({ position: next })
  return next
}

export function beginPetWindowDrag(
  window: BrowserWindow,
  grabOffsetX: number,
  grabOffsetY: number
): {
  x: number
  y: number
  localX: number
  localY: number
} {
  const existingSession = dragSessions.get(window)
  if (existingSession) {
    const current = moveWindowForDragSession(window, existingSession)
    if (current) {
      return {
        x: current.x,
        y: current.y,
        localX: 0,
        localY: 0
      }
    }

    return {
      x: existingSession.startPosition.x,
      y: existingSession.startPosition.y,
      localX: 0,
      localY: 0
    }
  }

  const cursor = screen.getCursorScreenPoint()
  const [windowX, windowY] = window.getPosition()
  const [windowWidth, windowHeight] = window.getSize()
  const settings = loadSettings()
  const expectedWidth = Math.round(PET_WIDTH * settings.scale)
  const expectedHeight = Math.round(PET_HEIGHT * settings.scale)
  const isUnexpectedlyLarge =
    windowWidth > expectedWidth * 2 || windowHeight > expectedHeight * 2
  const display = screen.getDisplayNearestPoint(cursor)
  const area = display.workArea
  const width = isUnexpectedlyLarge ? expectedWidth : windowWidth
  const height = isUnexpectedlyLarge ? expectedHeight : windowHeight
  const x = isUnexpectedlyLarge
    ? clamp(cursor.x - grabOffsetX, area.x, area.x + area.width - width)
    : windowX
  const y = isUnexpectedlyLarge
    ? clamp(cursor.y - grabOffsetY, area.y, area.y + area.height - height)
    : windowY

  if (isUnexpectedlyLarge) {
    window.setBounds({
      x,
      y,
      width,
      height
    }, false)
  }

  const session: DragSession = {
    grabOffset: {
      x: clamp(Math.round(grabOffsetX), 0, width),
      y: clamp(Math.round(grabOffsetY), 0, height)
    },
    startPosition: { x, y },
    petSize: {
      width,
      height
    }
  }

  dragSessions.set(window, session)

  return {
    x,
    y,
    localX: 0,
    localY: 0
  }
}

export function dragPetWindow(window: BrowserWindow): DragMoveResult | null {
  const session = dragSessions.get(window)
  if (!session) {
    return null
  }

  return moveWindowForDragSession(window, session)
}

function moveWindowForDragSession(window: BrowserWindow, session: DragSession): DragMoveResult | null {
  const next = getDragSessionPosition(session)

  window.setPosition(next.x, next.y, false)

  return {
    x: next.x,
    y: next.y,
    totalDx: next.x - session.startPosition.x,
    totalDy: next.y - session.startPosition.y,
    localX: 0,
    localY: 0
  }
}

function getDragSessionPosition(session: DragSession): { x: number; y: number } {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const area = display.workArea
  const x = clamp(
    cursor.x - session.grabOffset.x,
    area.x,
    area.x + area.width - session.petSize.width
  )
  const y = clamp(
    cursor.y - session.grabOffset.y,
    area.y,
    area.y + area.height - session.petSize.height
  )

  return {
    x,
    y
  }
}

export function endPetWindowDrag(window: BrowserWindow): void {
  const session = dragSessions.get(window)

  if (!session) {
    return
  }

  const { x, y } = getDragSessionPosition(session)

  window.setBounds({
    x,
    y,
    width: session.petSize.width,
    height: session.petSize.height
  }, false)
  dragSessions.delete(window)
  updateSettings({ position: { x, y } })
}

export function setAlwaysOnTop(window: BrowserWindow, value: boolean): boolean {
  window.setAlwaysOnTop(value, 'floating')
  updateSettings({ alwaysOnTop: value })
  return value
}

export function setClickThrough(window: BrowserWindow, value: boolean): boolean {
  applyClickThrough(window, value)
  updateSettings({ clickThrough: value })
  return value
}

function applyClickThrough(window: BrowserWindow, value: boolean): void {
  window.setIgnoreMouseEvents(value, { forward: true })
}

export function getAssetPath(...parts: string[]): string {
  return join(app.getAppPath(), ...parts)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), Math.max(min, max))
}

function isLikelyCorruptedTopLeftPosition(x: number, y: number): boolean {
  return Math.abs(x) <= 2 && Math.abs(y) <= 2
}
