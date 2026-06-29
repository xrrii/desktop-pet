import { BrowserWindow, app, ipcMain } from 'electron'
import { logError, logInfo } from './logger'
import { isAvailablePet, listAvailablePets } from './pets'
import { flushSettings, loadSettings, updateSettings } from './store'
import { createPetContextMenu, createTray, rebuildTrayMenu } from './tray'
import {
  beginPetWindowDrag,
  createPetWindow,
  dragPetWindow,
  endPetWindowDrag,
  movePetWindow,
  resetPetWindowPosition,
  setAlwaysOnTop,
  setClickThrough
} from './window'

let petWindow: BrowserWindow | null = null

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-software-rasterizer')

function registerIpc(): void {
  ipcMain.handle('pet:move-window', (event, x: number, y: number) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return null
    }
    return movePetWindow(window, x, y)
  })

  ipcMain.handle('pet:get-window-position', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return null
    }
    const [x, y] = window.getPosition()
    return { x, y }
  })

  ipcMain.handle('pet:begin-drag', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return null
    }
    return beginPetWindowDrag(window, 0, 0)
  })

  ipcMain.handle('pet:begin-drag-at', (event, grabOffsetX: number, grabOffsetY: number) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return null
    }
    return beginPetWindowDrag(window, grabOffsetX, grabOffsetY)
  })

  ipcMain.handle('pet:drag-window', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return null
    }
    return dragPetWindow(window)
  })

  ipcMain.handle('pet:end-drag', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) {
      endPetWindowDrag(window)
    }
  })

  ipcMain.handle('pet:reset-position', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return null
    }
    return resetPetWindowPosition(window)
  })

  ipcMain.handle('pet:set-always-on-top', (event, value: boolean) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return false
    }
    const next = setAlwaysOnTop(window, Boolean(value))
    rebuildTrayMenu(window)
    return next
  })

  ipcMain.handle('pet:set-click-through', (event, value: boolean) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return false
    }
    const next = setClickThrough(window, Boolean(value))
    rebuildTrayMenu(window)
    return next
  })

  ipcMain.handle('pet:get-settings', () => loadSettings())

  ipcMain.handle('pet:list-available', () => listAvailablePets())

  ipcMain.handle('pet:set-current', (event, petId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || !isAvailablePet(petId)) {
      return false
    }
    updateSettings({ petId })
    window.webContents.send('pet:switch', petId)
    rebuildTrayMenu(window)
    return true
  })

  ipcMain.handle('pet:show-context-menu', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return
    }
    createPetContextMenu(window).popup({ window })
  })

  ipcMain.handle('app:quit', () => app.quit())
}

app.whenReady().then(() => {
  logInfo('app ready')
  ensureSelectedPetIsAvailable()
  registerIpc()
  petWindow = createPetWindow()
  createTray(petWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      petWindow = createPetWindow()
      createTray(petWindow)
    } else {
      petWindow?.showInactive()
    }
  })
})

function ensureSelectedPetIsAvailable(): void {
  const settings = loadSettings()
  if (isAvailablePet(settings.petId)) {
    return
  }

  const [fallbackPet] = listAvailablePets()
  if (fallbackPet) {
    updateSettings({ petId: fallbackPet.id })
  }
}

app.on('before-quit', () => {
  logInfo('before quit')
  flushSettings()
})

app.on('window-all-closed', () => {
  // Keep the tray app alive until the user chooses Quit.
})

app.on('child-process-gone', (_event, details) => {
  logError('child process gone', details)
})

process.on('uncaughtException', (error) => {
  logError('uncaught exception', error)
})

process.on('unhandledRejection', (reason) => {
  logError('unhandled rejection', reason)
})
