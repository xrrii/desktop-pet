import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface PetSettings {
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

const currentSettingsVersion = 2

const defaultSettings: PetSettings = {
  settingsVersion: currentSettingsVersion,
  petId: 'hammer-dude',
  position: null,
  scale: 0.85,
  alwaysOnTop: true,
  clickThrough: false,
  launchAtStartup: false
}

let cachedSettings: PetSettings | null = null
let saveTimer: NodeJS.Timeout | null = null

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function normalizeSettings(value: Partial<PetSettings>): PetSettings {
  const settingsVersion = Number(value.settingsVersion) || 1
  const storedScale = Number(value.scale)
  const scale =
    settingsVersion < currentSettingsVersion && storedScale === 1
      ? defaultSettings.scale
      : storedScale > 0
        ? storedScale
        : defaultSettings.scale

  const position =
    value.position && !(Math.abs(Number(value.position.x) || 0) <= 2 && Math.abs(Number(value.position.y) || 0) <= 2)
      ? {
          x: Number(value.position.x) || 0,
          y: Number(value.position.y) || 0
        }
      : null

  return {
    ...defaultSettings,
    ...value,
    settingsVersion: currentSettingsVersion,
    position,
    scale,
    alwaysOnTop:
      typeof value.alwaysOnTop === 'boolean'
        ? value.alwaysOnTop
        : defaultSettings.alwaysOnTop,
    clickThrough:
      typeof value.clickThrough === 'boolean'
        ? value.clickThrough
        : defaultSettings.clickThrough,
    launchAtStartup:
      typeof value.launchAtStartup === 'boolean'
        ? value.launchAtStartup
        : defaultSettings.launchAtStartup
  }
}

export function loadSettings(): PetSettings {
  if (cachedSettings) {
    return cachedSettings
  }

  const settingsPath = getSettingsPath()
  if (!existsSync(settingsPath)) {
    cachedSettings = defaultSettings
    return cachedSettings
  }

  try {
    const raw = readFileSync(settingsPath, 'utf8')
    cachedSettings = normalizeSettings(JSON.parse(raw) as Partial<PetSettings>)
  } catch {
    cachedSettings = defaultSettings
  }

  return cachedSettings
}

export function saveSettingsNow(settings: PetSettings = loadSettings()): void {
  const settingsPath = getSettingsPath()
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
  cachedSettings = settings
}

export function updateSettings(patch: Partial<PetSettings>): PetSettings {
  const next = normalizeSettings({
    ...loadSettings(),
    ...patch
  })
  cachedSettings = next
  saveSettingsDebounced()
  return next
}

export function saveSettingsDebounced(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
  }

  saveTimer = setTimeout(() => {
    saveTimer = null
    saveSettingsNow()
  }, 350)
}

export function flushSettings(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  saveSettingsNow()
}
