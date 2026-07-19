import { BrowserWindow, app, screen } from 'electron'
import { join } from 'node:path'
import type { AssistantWindowLayout } from '../shared/assistant'
import type { DragMoveResult } from '../shared/pet'
import { calculateAssistantPlacement } from './assistant/assistantPlacement'
import { logError, logInfo } from './logger'
import { loadSettings, updateSettings } from './store'

export const PET_WIDTH = 192
export const PET_HEIGHT = 208
const LAYOUT_ACK_TIMEOUT_MS = 500

interface PetWindowState {
  petBounds: Electron.Rectangle
  layout: AssistantWindowLayout
  assistantExpanded: boolean
  clickThrough: boolean
  transparentAreaClickThrough: boolean
  pendingLayoutTransition: PendingLayoutTransition | null
}

interface PendingLayoutTransition {
  revision: number
  bounds: Electron.Rectangle
  timeout: NodeJS.Timeout
}

interface DragSession {
  grabOffset: { x: number; y: number }
  startPetPosition: { x: number; y: number }
  petOffset: { x: number; y: number }
  petSize: { width: number; height: number }
}

const dragSessions = new WeakMap<BrowserWindow, DragSession>()
const windowStates = new WeakMap<BrowserWindow, PetWindowState>()

export function createPetWindow(): BrowserWindow {
  const settings = loadSettings()
  const width = Math.round(PET_WIDTH * settings.scale)
  const height = Math.round(PET_HEIGHT * settings.scale)
  const savedPosition = settings.position
  const position =
    savedPosition && !isLikelyCorruptedTopLeftPosition(savedPosition.x, savedPosition.y)
      ? savedPosition
      : getDefaultPosition(width, height)
  const boundedPosition = keepInsideDisplay(position.x, position.y, width, height)
  const petBounds = { ...boundedPosition, width, height }

  const window = new BrowserWindow({
    ...petBounds,
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
      sandbox: true
    }
  })

  windowStates.set(window, {
    petBounds,
    layout: createCollapsedLayout(petBounds),
    assistantExpanded: false,
    clickThrough: settings.clickThrough,
    transparentAreaClickThrough: false,
    pendingLayoutTransition: null
  })

  window.setVisibleOnAllWorkspaces(false)
  window.setAlwaysOnTop(settings.alwaysOnTop, 'floating')
  applyMouseEvents(window)

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
    syncPetBoundsFromWindow(window)
    const state = requireWindowState(window)
    updateSettings({ position: { x: state.petBounds.x, y: state.petBounds.y } })
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
    sendLayout(window)
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
  return {
    x: clamp(x, area.x, area.x + area.width - width),
    y: clamp(y, area.y, area.y + area.height - height)
  }
}

export function getPetWindowPosition(window: BrowserWindow): { x: number; y: number } {
  const { petBounds } = requireWindowState(window)
  return { x: petBounds.x, y: petBounds.y }
}

export function getPetWindowLayout(window: BrowserWindow): AssistantWindowLayout {
  return structuredClone(requireWindowState(window).layout)
}

export function movePetWindow(window: BrowserWindow, x: number, y: number): { x: number; y: number } {
  const state = requireWindowState(window)
  const next = keepInsideDisplay(x, y, state.petBounds.width, state.petBounds.height)
  state.petBounds = { ...state.petBounds, ...next }
  applyCurrentLayout(window)
  updateSettings({ position: next })
  return next
}

export function resetPetWindowPosition(window: BrowserWindow): { x: number; y: number } {
  const state = requireWindowState(window)
  const next = getDefaultPosition(state.petBounds.width, state.petBounds.height)
  dragSessions.delete(window)
  state.petBounds = { ...state.petBounds, ...next }
  applyCurrentLayout(window)
  updateSettings({ position: next })
  return next
}

export function expandPetWindowForAssistant(window: BrowserWindow): AssistantWindowLayout {
  const state = requireWindowState(window)
  state.assistantExpanded = true
  applyCurrentLayout(window)
  window.show()
  window.focus()
  return state.layout
}

export function collapsePetWindowAssistant(window: BrowserWindow): AssistantWindowLayout {
  const state = requireWindowState(window)
  state.assistantExpanded = false
  state.transparentAreaClickThrough = false
  applyCurrentLayout(window)
  applyMouseEvents(window)
  return state.layout
}

export function isAssistantExpanded(window: BrowserWindow): boolean {
  return requireWindowState(window).assistantExpanded
}

export function acknowledgePetWindowLayout(window: BrowserWindow, revision: number): void {
  const state = requireWindowState(window)
  const pending = state.pendingLayoutTransition
  if (!pending || pending.revision !== revision) {
    return
  }
  logInfo('assistant layout acknowledged', {
    revision,
    currentWindowBounds: window.getBounds(),
    targetWindowBounds: pending.bounds,
    petBounds: state.petBounds,
    petOffset: state.layout.pet
  })
  commitPendingLayoutTransition(window, pending)
}

export function beginPetWindowDrag(
  window: BrowserWindow,
  grabOffsetX: number,
  grabOffsetY: number
): { x: number; y: number; localX: number; localY: number } {
  const existingSession = dragSessions.get(window)
  if (existingSession) {
    const current = moveWindowForDragSession(window, existingSession)
    return { x: current.x, y: current.y, localX: 0, localY: 0 }
  }

  const state = requireWindowState(window)
  const [windowWidth, windowHeight] = window.getSize()
  const session: DragSession = {
    grabOffset: {
      x: clamp(grabOffsetX, 0, windowWidth),
      y: clamp(grabOffsetY, 0, windowHeight)
    },
    startPetPosition: { x: state.petBounds.x, y: state.petBounds.y },
    petOffset: { x: state.layout.pet.x, y: state.layout.pet.y },
    petSize: { width: state.petBounds.width, height: state.petBounds.height }
  }
  dragSessions.set(window, session)
  return { x: state.petBounds.x, y: state.petBounds.y, localX: 0, localY: 0 }
}

export function dragPetWindow(window: BrowserWindow): DragMoveResult | null {
  const session = dragSessions.get(window)
  return session ? moveWindowForDragSession(window, session) : null
}

export function endPetWindowDrag(window: BrowserWindow): void {
  const session = dragSessions.get(window)
  if (!session) {
    return
  }

  moveWindowForDragSession(window, session)
  dragSessions.delete(window)
  const state = requireWindowState(window)
  applyCurrentLayout(window)
  updateSettings({ position: { x: state.petBounds.x, y: state.petBounds.y } })
}

export function setAlwaysOnTop(window: BrowserWindow, value: boolean): boolean {
  window.setAlwaysOnTop(value, 'floating')
  updateSettings({ alwaysOnTop: value })
  return value
}

export function setClickThrough(window: BrowserWindow, value: boolean): boolean {
  const state = requireWindowState(window)
  state.clickThrough = value
  applyMouseEvents(window)
  updateSettings({ clickThrough: value })
  return value
}

export function setTransparentAreaClickThrough(window: BrowserWindow, value: boolean): void {
  const state = requireWindowState(window)
  if (state.transparentAreaClickThrough === value) {
    return
  }
  state.transparentAreaClickThrough = value
  applyMouseEvents(window)
}

export function getAssetPath(...parts: string[]): string {
  return join(app.getAppPath(), ...parts)
}

function applyCurrentLayout(window: BrowserWindow): void {
  const state = requireWindowState(window)
  if (state.assistantExpanded) {
    const display = screen.getDisplayNearestPoint({
      x: state.petBounds.x + Math.round(state.petBounds.width / 2),
      y: state.petBounds.y + Math.round(state.petBounds.height / 2)
    })
    const placement = calculateAssistantPlacement(state.petBounds, display.workArea)
    const previousPetOffset = { ...state.layout.pet }
    const nextLayout: AssistantWindowLayout = {
      revision: state.layout.revision + 1,
      expanded: true,
      side: placement.side,
      pet: placement.pet,
      panel: placement.panel
    }
    const petOffsetChanged =
      nextLayout.pet.x !== state.layout.pet.x || nextLayout.pet.y !== state.layout.pet.y
    state.layout = nextLayout
    cancelPendingLayoutTransition(state)
    if (petOffsetChanged) {
      const pending: PendingLayoutTransition = {
        revision: nextLayout.revision,
        bounds: placement.windowBounds,
        timeout: setTimeout(() => {
          const currentPending = state.pendingLayoutTransition
          if (currentPending?.revision === nextLayout.revision) {
            commitPendingLayoutTransition(window, currentPending)
          }
        }, LAYOUT_ACK_TIMEOUT_MS)
      }
      state.pendingLayoutTransition = pending
      logInfo('assistant layout transition scheduled', {
        revision: nextLayout.revision,
        currentWindowBounds: window.getBounds(),
        targetWindowBounds: placement.windowBounds,
        petBounds: state.petBounds,
        previousPetOffset,
        nextPetOffset: nextLayout.pet
      })
      sendLayout(window)
      return
    }
    window.setBounds(placement.windowBounds, false)
  } else {
    cancelPendingLayoutTransition(state)
    state.layout = createCollapsedLayout(state.petBounds, state.layout.revision + 1)
    window.setBounds(state.petBounds, false)
  }
  sendLayout(window)
}

function moveWindowForDragSession(window: BrowserWindow, session: DragSession): DragMoveResult {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const area = display.workArea
  const windowX = clamp(
    cursor.x - session.grabOffset.x,
    area.x - session.petOffset.x,
    area.x + area.width - session.petOffset.x - session.petSize.width
  )
  const windowY = clamp(
    cursor.y - session.grabOffset.y,
    area.y - session.petOffset.y,
    area.y + area.height - session.petOffset.y - session.petSize.height
  )
  const state = requireWindowState(window)
  state.petBounds = {
    x: windowX + session.petOffset.x,
    y: windowY + session.petOffset.y,
    width: session.petSize.width,
    height: session.petSize.height
  }
  window.setPosition(windowX, windowY, false)
  return {
    x: state.petBounds.x,
    y: state.petBounds.y,
    totalDx: state.petBounds.x - session.startPetPosition.x,
    totalDy: state.petBounds.y - session.startPetPosition.y,
    localX: 0,
    localY: 0
  }
}

function syncPetBoundsFromWindow(window: BrowserWindow): void {
  const state = requireWindowState(window)
  const [windowX, windowY] = window.getPosition()
  state.petBounds = {
    x: windowX + state.layout.pet.x,
    y: windowY + state.layout.pet.y,
    width: state.petBounds.width,
    height: state.petBounds.height
  }
}

function createCollapsedLayout(
  petBounds: Electron.Rectangle,
  revision = 0
): AssistantWindowLayout {
  return {
    revision,
    expanded: false,
    side: 'left',
    pet: { x: 0, y: 0, width: petBounds.width, height: petBounds.height },
    panel: { x: 0, y: 0, width: 0, height: 0 }
  }
}

function commitPendingLayoutTransition(
  window: BrowserWindow,
  pending: PendingLayoutTransition
): void {
  const state = requireWindowState(window)
  if (state.pendingLayoutTransition !== pending) {
    return
  }
  clearTimeout(pending.timeout)
  state.pendingLayoutTransition = null
  window.setBounds(pending.bounds, false)
  logInfo('assistant layout transition committed', {
    revision: pending.revision,
    windowBounds: window.getBounds(),
    petBounds: state.petBounds,
    petOffset: state.layout.pet
  })
}

function cancelPendingLayoutTransition(state: PetWindowState): void {
  if (!state.pendingLayoutTransition) {
    return
  }
  clearTimeout(state.pendingLayoutTransition.timeout)
  state.pendingLayoutTransition = null
}

function sendLayout(window: BrowserWindow): void {
  if (!window.webContents.isLoading()) {
    window.webContents.send('assistant:layout', requireWindowState(window).layout)
  }
}

function applyMouseEvents(window: BrowserWindow): void {
  const state = requireWindowState(window)
  const ignore = state.clickThrough || (state.assistantExpanded && state.transparentAreaClickThrough)
  window.setIgnoreMouseEvents(ignore, { forward: true })
}

function requireWindowState(window: BrowserWindow): PetWindowState {
  const state = windowStates.get(window)
  if (!state) {
    throw new Error('Pet window state is unavailable.')
  }
  return state
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), Math.max(min, max))
}

function isLikelyCorruptedTopLeftPosition(x: number, y: number): boolean {
  return Math.abs(x) <= 2 && Math.abs(y) <= 2
}
