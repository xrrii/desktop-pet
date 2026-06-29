import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron'
import { listAvailablePets } from './pets'
import { resetPetWindowPosition, setAlwaysOnTop, setClickThrough } from './window'
import { loadSettings, updateSettings } from './store'

type PetAction =
  | 'idle'
  | 'waving'
  | 'jumping'
  | 'waiting'
  | 'running'
  | 'review'
  | 'failed'

let tray: Tray | null = null

const label = {
  title: '\u96f7\u9524\u5c0f\u4eba',
  pets: '\u684c\u5ba0',
  actions: '\u52a8\u4f5c',
  idle: '\u5f85\u673a',
  waving: '\u6325\u624b',
  jumping: '\u8df3\u8dc3',
  waiting: '\u7b49\u5f85',
  running: '\u5de5\u4f5c\u4e2d',
  review: '\u5b8c\u6210\u68c0\u67e5',
  failed: '\u5931\u8d25',
  alwaysOnTop: '\u59cb\u7ec8\u7f6e\u9876',
  clickThrough: '\u70b9\u51fb\u7a7f\u900f',
  launchAtStartup: '\u5f00\u673a\u542f\u52a8',
  resetPosition: '\u91cd\u7f6e\u4f4d\u7f6e',
  show: '\u663e\u793a',
  hide: '\u9690\u85cf\u5230\u6258\u76d8',
  quit: '\u9000\u51fa'
}

export function createTray(window: BrowserWindow): Tray {
  tray?.destroy()
  tray = new Tray(createTrayIcon())
  tray.setToolTip(label.title)
  rebuildTrayMenu(window)
  tray.on('click', () => {
    if (window.isVisible()) {
      window.hide()
    } else {
      window.showInactive()
    }
  })
  return tray
}

export function rebuildTrayMenu(window: BrowserWindow): void {
  if (!tray) {
    return
  }

  const settings = loadSettings()
  const menu = Menu.buildFromTemplate([
    {
      label: label.title,
      enabled: false
    },
    { type: 'separator' },
    createPetsMenu(window),
    { type: 'separator' },
    {
      label: label.actions,
      submenu: [
        createActionItem(window, label.idle, 'idle'),
        createActionItem(window, label.waving, 'waving'),
        createActionItem(window, label.jumping, 'jumping'),
        createActionItem(window, label.waiting, 'waiting'),
        createActionItem(window, label.running, 'running'),
        createActionItem(window, label.review, 'review'),
        createActionItem(window, label.failed, 'failed')
      ]
    },
    { type: 'separator' },
    {
      label: label.alwaysOnTop,
      type: 'checkbox',
      checked: settings.alwaysOnTop,
      click: (item) => {
        setAlwaysOnTop(window, item.checked)
        rebuildTrayMenu(window)
      }
    },
    {
      label: label.clickThrough,
      type: 'checkbox',
      checked: settings.clickThrough,
      click: (item) => {
        setClickThrough(window, item.checked)
        rebuildTrayMenu(window)
      }
    },
    {
      label: label.launchAtStartup,
      type: 'checkbox',
      checked: settings.launchAtStartup,
      click: (item) => {
        setLaunchAtStartup(item.checked)
        rebuildTrayMenu(window)
      }
    },
    {
      label: label.resetPosition,
      click: () => {
        resetPetWindowPosition(window)
      }
    },
    { type: 'separator' },
    {
      label: window.isVisible() ? label.hide : label.show,
      click: () => {
        if (window.isVisible()) {
          window.hide()
        } else {
          window.showInactive()
        }
        rebuildTrayMenu(window)
      }
    },
    {
      label: label.quit,
      click: () => app.quit()
    }
  ])

  tray.setContextMenu(menu)
}

export function createPetContextMenu(window: BrowserWindow): Menu {
  const settings = loadSettings()
  return Menu.buildFromTemplate([
    createPetsMenu(window),
    { type: 'separator' },
    createActionItem(window, label.waving, 'waving'),
    createActionItem(window, label.jumping, 'jumping'),
    {
      label: settings.alwaysOnTop ? '\u53d6\u6d88\u7f6e\u9876' : '\u7f6e\u9876',
      click: () => {
        setAlwaysOnTop(window, !settings.alwaysOnTop)
        rebuildTrayMenu(window)
      }
    },
    {
      label: label.resetPosition,
      click: () => {
        resetPetWindowPosition(window)
      }
    },
    { type: 'separator' },
    {
      label: label.hide,
      click: () => {
        window.hide()
        rebuildTrayMenu(window)
      }
    },
    {
      label: label.quit,
      click: () => app.quit()
    }
  ])
}

function createActionItem(window: BrowserWindow, itemLabel: string, action: PetAction) {
  return {
    label: itemLabel,
    click: () => {
      window.webContents.send('pet:set-action', action)
    }
  }
}

function createPetsMenu(window: BrowserWindow): Electron.MenuItemConstructorOptions {
  const settings = loadSettings()
  const pets = listAvailablePets()

  return {
    label: label.pets,
    enabled: pets.length > 0,
    submenu: pets.map((pet) => ({
      label: pet.displayName,
      type: 'radio',
      checked: pet.id === settings.petId,
      click: () => {
        if (pet.id === loadSettings().petId) {
          return
        }
        updateSettings({ petId: pet.id })
        window.webContents.send('pet:switch', pet.id)
        rebuildTrayMenu(window)
      }
    }))
  }
}

function createTrayIcon(): Electron.NativeImage {
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAB5ElEQVR4nO2bv07DMBDGz586ZGbnQVhaJt6iIxsLEgMDTCwgIbEgFsa8BROw8CDdmbMVdaiEoHb853x2cv6NydX3feez4yoKUaPRaDT0YiSTre6GrW/sx20nos3UZLpEMUytpqWKYaZiPFchQBM0z5kPUzTPmdeUFlB6SWAO5lP0QDJZbmJ0QSKJJKH6FlSI9/Xbv2un/Zm4DiM9+4eM5yiE76aI2syHxHHoBedgnKakigASINYMRxGSC7CqfNdP1Y/cAlJnMXcXgJSDObe/jw+QckDKQe72Tz3VcR2PbX5AyoFEkthZlPhztOAcrD8frPc2tKTj4dN7rE23dI63fu2oqg7oHWJ/m/LBJ84nn1gB+gAxO3M2g657qXmzLYE+UkSI0bH8KcsBpByQckDKASkHpd/PS2HzA1IOUgfgOpGVyg/XTd9lsBfx8nBDNZp3+QCXmL15qSJwdd6CMrAvwtfRI9UOxgJ8lsHJ91XQdUnG9CM1gcvkLDrAVcXazft0LzgHqwn2t8N/B6159kMmCzEJajYfCuZmPnSpgmZEzD6FkODry4ttrbMfu0mbqZtPfTrBN/D+6dnYrpd6RHLkRUjwzqytENJF4MpnYn+4WxK2Yqj9XuAQKr8YmdI3Q41Go0Ga+QH08N0uWOpvhQAAAABJRU5ErkJggg=='
  )
}

function setLaunchAtStartup(value: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: value,
    path: process.execPath
  })
  updateSettings({ launchAtStartup: value })
}
