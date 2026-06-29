import { contextBridge, ipcRenderer } from 'electron'

type PetAction =
  | 'idle'
  | 'runningRight'
  | 'runningLeft'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

interface PetSettings {
  settingsVersion: number
  petId: string
  position: {
    x: number
    y: number
  } | null
  scale: number
  alwaysOnTop: boolean
  clickThrough: boolean
  launchAtStartup: boolean
}

interface AvailablePet {
  id: string
  displayName: string
  description: string
}

interface DragMoveResult {
  x: number
  y: number
  totalDx: number
  totalDy: number
  localX: number
  localY: number
}

const api = {
  moveWindow: (x: number, y: number): Promise<{ x: number; y: number } | null> =>
    ipcRenderer.invoke('pet:move-window', x, y),
  getWindowPosition: (): Promise<{ x: number; y: number } | null> =>
    ipcRenderer.invoke('pet:get-window-position'),
  beginDrag: (): Promise<{ x: number; y: number; localX: number; localY: number } | null> =>
    ipcRenderer.invoke('pet:begin-drag'),
  beginDragAt: (
    grabOffsetX: number,
    grabOffsetY: number
  ): Promise<{ x: number; y: number; localX: number; localY: number } | null> =>
    ipcRenderer.invoke('pet:begin-drag-at', grabOffsetX, grabOffsetY),
  dragWindow: (): Promise<DragMoveResult | null> => ipcRenderer.invoke('pet:drag-window'),
  endDrag: (): Promise<void> => ipcRenderer.invoke('pet:end-drag'),
  resetPosition: (): Promise<{ x: number; y: number } | null> =>
    ipcRenderer.invoke('pet:reset-position'),
  getSettings: (): Promise<PetSettings> => ipcRenderer.invoke('pet:get-settings'),
  listAvailablePets: (): Promise<AvailablePet[]> => ipcRenderer.invoke('pet:list-available'),
  setCurrentPet: (petId: string): Promise<boolean> => ipcRenderer.invoke('pet:set-current', petId),
  setAlwaysOnTop: (value: boolean): Promise<boolean> =>
    ipcRenderer.invoke('pet:set-always-on-top', value),
  setClickThrough: (value: boolean): Promise<boolean> =>
    ipcRenderer.invoke('pet:set-click-through', value),
  showContextMenu: (): Promise<void> => ipcRenderer.invoke('pet:show-context-menu'),
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
  onSetAction: (callback: (action: PetAction) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: PetAction): void => {
      callback(action)
    }
    ipcRenderer.on('pet:set-action', listener)
    return () => ipcRenderer.removeListener('pet:set-action', listener)
  },
  onSwitchPet: (callback: (petId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, petId: string): void => {
      callback(petId)
    }
    ipcRenderer.on('pet:switch', listener)
    return () => ipcRenderer.removeListener('pet:switch', listener)
  }
}

contextBridge.exposeInMainWorld('desktopPet', api)

export type DesktopPetApi = typeof api
