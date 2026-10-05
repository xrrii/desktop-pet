import {
  BrowserWindow,
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type {
  AssistantAskInput,
  AssistantAttachmentDropZone,
  AssistantAttachmentPreviewInput,
  AssistantArtifactAccessInput,
  AssistantArtifactPreviewInput,
  AssistantArtifactSaveResult,
  AssistantEmbeddingOnlineInput,
  AssistantModelSettingsInput,
  AssistantWebSettingsInput,
  AssistantVisionSettingsInput,
  AssistantServiceMode,
  MemoryClearScope,
  MemoryItemKind,
  AssistantPermissionResolution
} from '../shared/assistant'
import type {
  ManagedCapabilityName,
  ManagedCapabilityStateMap,
  ManagedPortalTarget,
  ManagedUsageSummaryResult
} from '../shared/managed'
import type { CreatePetInput, PetSpritesheetSelection } from '../shared/pet'
import { AssistantManager } from './assistant/assistantManager'
import { writeArtifactAtomically } from './assistant/artifactFileWriter'
import { logError, logInfo } from './logger'
import { ManagedAuthManager } from './managed/managedAuthManager'
import {
  ManagedControlPlaneError,
  ManagedControlPlaneClient
} from './managed/managedControlPlaneClient'
import { resolveManagedEndpointPolicy } from './managed/managedEndpointPolicy'
import { isManagedPortalTarget, resolveManagedPortalUrl } from './managed/managedPortalRoutes'
import { ManagedRuntimeSessionBridge } from './managed/managedRuntimeSessionBridge'
import { ManagedRuntimeTokenBroker } from './managed/managedRuntimeTokenBroker'
import { ManagedRuntimeAuthRefreshHandler } from './managed/managedRuntimeAuthRefreshHandler'
import { ManagedServerClock } from './managed/managedServerClock'
import { ScreenshotManager } from './screenshotManager'
import { configureSingleInstance } from './singleInstance'
import { UpdateActivityGate } from './update/updateActivityGate'
import { DesktopUpdateManager } from './update/updateManager'
import { createReleaseDesktopUpdater } from './update/electronDesktopUpdater'
import { detectUpdatePackageKind } from './update/updatePolicy'
import { DesktopUpdateUi } from './update/updateUi'
import { setAssistantTheme } from './theme'
import {
  createUserPet,
  deleteUserPet,
  ensureUserPetsRoot,
  isAvailablePet,
  listAvailablePets,
  readPetManifest,
  readPetSpritesheetDataUrl
} from './pets'
import { flushSettings, loadSettings, updateSettings } from './store'
import { createPetContextMenu, createTray, rebuildTrayMenu } from './tray'
import {
  beginPetWindowDrag,
  acknowledgePetWindowLayout,
  collapsePetWindowAssistant,
  createPetWindow,
  dragPetWindow,
  endPetWindowDrag,
  expandPetWindowForAssistant,
  getPetWindowLayout,
  getPetWindowPosition,
  isAssistantExpanded,
  movePetWindow,
  resetPetWindowPosition,
  setAlwaysOnTop,
  setClickThrough,
  setTransparentAreaClickThrough
} from './window'

// 自动化 Smoke 使用独立数据目录，避免测试读写用户的模型密钥、会话和浏览器缓存。
const smokeUserDataPath = process.env.PETDOCK_SMOKE_USER_DATA?.trim()
if (smokeUserDataPath) {
  app.setPath('userData', resolve(smokeUserDataPath))
}

// 仅供自动化测试在无可用 GPU 的受限环境中启用软件渲染。
if (process.env.PETDOCK_SMOKE_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

let petWindow: BrowserWindow | null = null
let quitAfterRuntimeStops = false
let quitInProgress = false
const updateGate = new UpdateActivityGate()
let smokeArtifactSaveCancelled = false
let activeManagedPortalRefresh: Promise<void> | null = null
const pendingPetSpritesheetSelections = new Map<string, { filePath: string; fileName: string }>()
const isPrimaryInstance = configureSingleInstance(app, {
  getWindow: () => petWindow,
  openWindow: () => openPetWindow(),
  logInfo: (message) => logInfo(message)
})
const managedEndpointPolicy = resolveManagedEndpointPolicy(undefined, process.env, app.isPackaged)
const managedServerClock = new ManagedServerClock()
const managedRuntimeSessionBridge = new ManagedRuntimeSessionBridge()
const managedRuntimeTokenBroker = new ManagedRuntimeTokenBroker(
  new ManagedControlPlaneClient(managedEndpointPolicy, app.getVersion(), undefined, managedServerClock),
  managedRuntimeSessionBridge,
  { now: () => managedServerClock.now() }
)
const managedRuntimeAuthRefreshHandler = new ManagedRuntimeAuthRefreshHandler(managedRuntimeTokenBroker)
let managedAuthManager: ManagedAuthManager
let assistantManager: AssistantManager
assistantManager = new AssistantManager(
  (status) => petWindow?.webContents.send('assistant:status', status),
  (event) => petWindow?.webContents.send('assistant:event', event),
  {
    updateGate,
    onReady: (client) => managedRuntimeTokenBroker.attachRuntime(client),
    onStopped: (client) => managedRuntimeTokenBroker.detachRuntime(client),
    getManagedChatState: () => managedAuthManager?.getManagedChatState() || {
      enabled: false,
      authenticated: false,
      runtimeReady: false,
      errorCode: null
    },
    getManagedWebSearchState: () => {
      const status = managedAuthManager?.getStatus()
      return {
        enabled: managedAuthManager?.isManagedCapabilityEffective('web_search') === true,
        authenticated: status?.state === 'authenticated' && status.sessionSyncState === 'ready',
        runtimeReady: status?.runtimeSessionState === 'ready',
        errorCode: status?.runtimeSessionErrorCode || null
      }
    },
    getManagedVisionState: () => {
      const status = managedAuthManager?.getStatus()
      return {
        enabled: managedAuthManager?.isManagedCapabilityEffective('vision') === true,
        authenticated: status?.state === 'authenticated' && status.sessionSyncState === 'ready',
        runtimeReady: status?.runtimeSessionState === 'ready',
        errorCode: status?.runtimeSessionErrorCode || null
      }
    },
    getManagedEmbeddingState: () => {
      const status = managedAuthManager?.getStatus()
      return {
        enabled: managedAuthManager?.isManagedCapabilityEffective('embedding') === true,
        authenticated: status?.state === 'authenticated' && status.sessionSyncState === 'ready',
        runtimeReady: status?.runtimeSessionState === 'ready',
        errorCode: status?.runtimeSessionErrorCode || null
      }
    },
    getManagedRerankState: () => {
      const status = managedAuthManager?.getStatus()
      return {
        enabled: managedAuthManager?.isManagedCapabilityEffective('rerank') === true,
        authenticated: status?.state === 'authenticated' && status.sessionSyncState === 'ready',
        runtimeReady: status?.runtimeSessionState === 'ready',
        errorCode: status?.runtimeSessionErrorCode || null
      }
    },
    getManagedAiBaseUrl: () => (
      managedEndpointPolicy.aiDataPlaneBaseUrl || managedEndpointPolicy.controlPlaneBaseUrl
    ).toString().replace(/\/$/, ''),
    managedWebSearch: {
      selected: () => assistantManager?.getCapabilitySettings().capabilities.web_search.selectedSource === 'managed',
      enabled: () => managedAuthManager?.isManagedCapabilityEffective('web_search') === true,
      getToken: () => managedRuntimeTokenBroker.getToken(),
      endpoint: () => managedEndpointPolicy.aiDataPlaneBaseUrl || managedEndpointPolicy.controlPlaneBaseUrl,
      clientVersion: () => app.getVersion()
    }
  },
  (event, client) => managedRuntimeAuthRefreshHandler.handle(event, client)
)
const screenshotManager = new ScreenshotManager(
  () => petWindow,
  assistantManager,
  (window) => openAssistantForPet(window),
  (result) => petWindow?.webContents.send('assistant:attachments-staged', result),
  (message) => petWindow?.webContents.send('assistant:attachment-stage-error', message),
  updateGate
)
managedAuthManager = new ManagedAuthManager(managedEndpointPolicy, app.getVersion(), {
  runtimeTokenBroker: managedRuntimeTokenBroker,
  serverClock: managedServerClock,
  onRuntimeSessionReady: async () => {
    try {
      await updateGate.run(() => assistantManager.reindexAllKnowledge())
    } catch (error: unknown) {
      logError('Managed Runtime Session 就绪后的知识库重建失败', error)
    }
  },
  onCapabilityPreferencesSync: async (snapshot) => {
    await updateGate.run(() => assistantManager.synchronizeManagedCapabilities(snapshot))
  },
  isManagedServiceSelected: () => assistantManager.getServiceModeSelection() === 'managed',
  onStatusChange: (status) => petWindow?.webContents.send('managed:status-changed', status)
})

const updateKind = detectUpdatePackageKind({
  platform: process.platform,
  packaged: app.isPackaged,
  portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR),
  nsisInstalled: existsSync(join(dirname(process.execPath), 'Uninstall PetDock.exe'))
})
const desktopUpdates = new DesktopUpdateManager(
  updateKind, createReleaseDesktopUpdater(updateKind, (message) => logInfo(message)), updateGate,
  {
    prepare: async () => !quitInProgress && !screenshotManager.isBusy() && await assistantManager.prepareForUpdate(),
    stop: async () => {
      flushSettings()
      await assistantManager.stopForUpdate()
    },
    resume: () => assistantManager.resumeAfterUpdate()
  },
  () => { if (petWindow && !petWindow.isDestroyed()) rebuildTrayMenu(petWindow) },
  (message) => logInfo(message),
  ['development', 'unpacked', 'unsupported'].includes(updateKind)
    ? '当前运行形态不启用自动更新。'
    : '正式更新源与独立签名验证尚未就绪。'
)
const desktopUpdateUi = new DesktopUpdateUi(desktopUpdates)

/** 保持现有 IPC 授权校验，并把请求从对话框开始到最终写入统一纳入安装互锁。 */
function handlePetIpc(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void {
  ipcMain.handle(channel, (event, ...args) => {
    requirePetSender(event)
    if (quitInProgress) throw new Error('应用正在退出。')
    return updateGate.run(() => listener(event, ...args))
  })
}

/**
 * 打开 Artifact 原生保存对话框；仅在自动化 Smoke 明确注入变量时提供确定性选择结果。
 * 测试适配不向生产配置暴露，也不改变后续 Main 读取、原子写入和保存标记流程。
 */
async function showArtifactSaveDialog(
  window: BrowserWindow,
  artifactName: string,
  extension: string
): Promise<Electron.SaveDialogReturnValue> {
  if (process.env.PETDOCK_SMOKE_ARTIFACT_SAVE_CANCEL_ONCE === '1' && !smokeArtifactSaveCancelled) {
    smokeArtifactSaveCancelled = true
    return { canceled: true, filePath: '' }
  }
  const smokePath = process.env.PETDOCK_SMOKE_ARTIFACT_SAVE_PATH?.trim()
  if (smokePath) {
    return { canceled: false, filePath: smokePath }
  }
  return dialog.showSaveDialog(window, {
    title: '保存生成文件',
    defaultPath: artifactName,
    filters: [{ name: `${extension.toUpperCase()} 文件`, extensions: [extension] }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
}

app.disableHardwareAcceleration()
app.setAppUserModelId('com.local.petdock')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')

function registerIpc(): void {
  screenshotManager.registerIpc()

  ipcMain.on('assistant:layout-applied', (event: IpcMainEvent, revision: number) => {
    const window = requirePetSender(event)
    if (Number.isInteger(revision)) {
      acknowledgePetWindowLayout(window, revision)
    }
  })

  handlePetIpc('pet:move-window', (event, x: number, y: number) => {
    const window = requirePetSender(event)
    requireFiniteNumbers(x, y)
    return movePetWindow(window, x, y)
  })

  handlePetIpc('pet:get-window-position', (event) => {
    const window = requirePetSender(event)
    return getPetWindowPosition(window)
  })

  handlePetIpc('pet:begin-drag', (event) => {
    const window = requirePetSender(event)
    return beginPetWindowDrag(window, 0, 0)
  })

  handlePetIpc('pet:begin-drag-at', (event, grabOffsetX: number, grabOffsetY: number) => {
    const window = requirePetSender(event)
    requireFiniteNumbers(grabOffsetX, grabOffsetY)
    return beginPetWindowDrag(window, grabOffsetX, grabOffsetY)
  })

  handlePetIpc('pet:drag-window', (event) => {
    const window = requirePetSender(event)
    return dragPetWindow(window)
  })

  handlePetIpc('pet:end-drag', (event) => {
    endPetWindowDrag(requirePetSender(event))
  })

  handlePetIpc('pet:reset-position', (event) => {
    const window = requirePetSender(event)
    return resetPetWindowPosition(window)
  })

  handlePetIpc('pet:set-always-on-top', (event, value: boolean) => {
    const window = requirePetSender(event)
    requireBoolean(value)
    const next = setAlwaysOnTop(window, value)
    rebuildTrayMenu(window)
    return next
  })

  handlePetIpc('pet:set-click-through', (event, value: boolean) => {
    const window = requirePetSender(event)
    requireBoolean(value)
    const next = setClickThrough(window, value)
    rebuildTrayMenu(window)
    return next
  })

  handlePetIpc('pet:set-transparent-area-click-through', (event, value: boolean) => {
    const window = requirePetSender(event)
    requireBoolean(value)
    setTransparentAreaClickThrough(window, value)
  })

  handlePetIpc('pet:get-settings', (event) => {
    requirePetSender(event)
    return loadSettings()
  })

  handlePetIpc('pet:list-available', (event) => {
    requirePetSender(event)
    return listAvailablePets()
  })

  handlePetIpc('pet:pick-spritesheet', async (event) => {
    const window = requirePetSender(event)
    const selection = await dialog.showOpenDialog(window, {
      title: '选择桌宠 spritesheet 图集',
      properties: ['openFile'],
      filters: [
        {
          name: '图片文件',
          extensions: ['png', 'jpg', 'jpeg', 'webp']
        }
      ]
    })
    const [selectedPath] = selection.filePaths
    if (selection.canceled || !selectedPath) {
      return null
    }
    const result = registerPetSpritesheetSelection(selectedPath)
    logInfo('pet spritesheet selected', { fileName: result.fileName })
    return result
  })

  handlePetIpc('pet:load-manifest', (event, petId: string) => {
    requirePetSender(event)
    requireString(petId)
    if (!isAvailablePet(petId)) {
      return null
    }
    return readPetManifest(petId)
  })

  handlePetIpc('pet:load-spritesheet', (event, petId: string, spritesheetPath: string) => {
    requirePetSender(event)
    requireString(petId)
    requireString(spritesheetPath)
    if (!isAvailablePet(petId)) {
      return null
    }
    return readPetSpritesheetDataUrl(petId, spritesheetPath)
  })

  handlePetIpc('pet:create', (event, input: CreatePetInput) => {
    const window = requirePetSender(event)
    const nextInput = requireCreatePetInput(input)
    const selection = requirePetSpritesheetSelection(nextInput.spritesheetToken)
    const pet = createUserPet(nextInput, selection.filePath, selection.fileName)
    pendingPetSpritesheetSelections.delete(nextInput.spritesheetToken)
    if (nextInput.makeCurrent) {
      updateSettings({ petId: pet.id })
      window.webContents.send('pet:switch', pet.id)
    }
    rebuildTrayMenu(window)
    logInfo('user pet created', { petId: pet.id, source: pet.source, makeCurrent: Boolean(nextInput.makeCurrent) })
    return pet
  })

  handlePetIpc('pet:set-current', (event, petId: string) => {
    const window = requirePetSender(event)
    requireString(petId)
    if (!isAvailablePet(petId)) {
      return false
    }
    updateSettings({ petId })
    window.webContents.send('pet:switch', petId)
    rebuildTrayMenu(window)
    return true
  })

  handlePetIpc('pet:delete-user', (event, petId: string) => {
    const window = requirePetSender(event)
    requireString(petId)
    const deleted = deleteUserPet(petId)
    if (!deleted) {
      return false
    }
    if (loadSettings().petId === petId) {
      const [fallbackPet] = listAvailablePets()
      if (fallbackPet) {
        updateSettings({ petId: fallbackPet.id })
        window.webContents.send('pet:switch', fallbackPet.id)
      }
    }
    rebuildTrayMenu(window)
    logInfo('user pet deleted', { petId })
    return true
  })

  handlePetIpc('pet:open-user-pets-dir', async (event) => {
    requirePetSender(event)
    const result = await shell.openPath(ensureUserPetsRoot())
    if (result) {
      throw new Error('桌宠目录打开失败，请稍后重试。')
    }
  })

  handlePetIpc('pet:show-context-menu', (event) => {
    const window = requirePetSender(event)
    createPetContextMenu(window).popup({ window })
  })

  handlePetIpc('app:quit', (event) => {
    requirePetSender(event)
    app.quit()
  })

  handlePetIpc('assistant:open', (event) => {
    const window = requirePetSender(event)
    openAssistantForPet(window)
  })

  handlePetIpc('assistant:open-external-url', async (event, value: unknown) => {
    requirePetSender(event)
    const url = requireExternalHttpUrl(value)
    try {
      await shell.openExternal(url)
      return true
    } catch (error) {
      logError('assistant failed to open external URL', error)
      throw error
    }
  })

  handlePetIpc('assistant:copy-text', (event, value: unknown) => {
    requirePetSender(event)
    const text = requireClipboardText(value)
    try {
      clipboard.writeText(text)
      return true
    } catch (error) {
      logError('助手写入剪贴板失败', error)
      throw error
    }
  })

  handlePetIpc('assistant:get-status', (event) => {
    requirePetSender(event)
    return assistantManager.getStatus()
  })

  handlePetIpc('assistant:get-web-settings', (event) => {
    requirePetSender(event)
    return assistantManager.getWebSettings()
  })

  handlePetIpc('assistant:set-web-settings', (event, input: AssistantWebSettingsInput) => {
    requirePetSender(event)
    return assistantManager.configureWebSettings(input)
  })

  handlePetIpc('assistant:test-web-search', (event) => {
    requirePetSender(event)
    return assistantManager.testWebSearch()
  })

  handlePetIpc('assistant:get-layout', (event) => {
    return getPetWindowLayout(requirePetSender(event))
  })

  handlePetIpc('assistant:set-theme', (event, theme: unknown) => {
    const window = requirePetSender(event)
    const next = setAssistantTheme(window, theme)
    rebuildTrayMenu(window)
    return next
  })

  handlePetIpc('assistant:ask', (event, request: AssistantAskInput) => {
    requirePetSender(event)
    if (!request || typeof request !== 'object') {
      throw new TypeError('Assistant request is invalid.')
    }
    return assistantManager.ask(request)
  })

  handlePetIpc('assistant:get-document-capabilities', (event) => {
    requirePetSender(event)
    return assistantManager.getDocumentCapabilities()
  })

  handlePetIpc('assistant:test-vision', (event) => {
    requirePetSender(event)
    return assistantManager.testVision()
  })

  handlePetIpc('assistant:get-vision-settings', (event) => {
    requirePetSender(event)
    return assistantManager.getVisionSettings()
  })

  handlePetIpc('assistant:set-vision-settings', (event, input: AssistantVisionSettingsInput) => {
    requirePetSender(event)
    return assistantManager.configureVisionSettings(input)
  })

  handlePetIpc('assistant:get-model-settings', (event) => {
    requirePetSender(event)
    return assistantManager.getModelSettings()
  })

  handlePetIpc('managed:get-status', (event) => {
    requirePetSender(event)
    return managedAuthManager.getStatus()
  })

  handlePetIpc('managed:refresh-features', (event) => {
    requirePetSender(event)
    return managedAuthManager.refreshFeatures()
  })

  handlePetIpc('managed:get-usage-summary', async (event): Promise<ManagedUsageSummaryResult> => {
    requirePetSender(event)
    try {
      return await managedAuthManager.getUsageSummary()
    } catch (error) {
      // 登出期间旧额度请求返回 401 是正常竞态，不把它作为 IPC 异常传播给 Renderer。
      if (error instanceof ManagedControlPlaneError && error.code === 'authentication_required') {
        return null
      }
      throw error
    }
  })

  handlePetIpc('managed:open-portal', async (event, target: unknown) => {
    requirePetSender(event)
    const portalTarget = requireManagedPortalTarget(target)
    const url = resolveManagedPortalUrl(
      portalTarget,
      process.env.PETDOCK_MANAGED_ENVIRONMENT,
      process.env,
      app.isPackaged
    )
    try {
      await shell.openExternal(url.href)
      return true
    } catch (error) {
      logError('managed portal failed to open', error)
      throw error
    }
  })

  handlePetIpc('managed:refresh-portal-return', (event) => {
    requirePetSender(event)
    return refreshManagedPortalStatus()
  })

  handlePetIpc('managed:login', (event) => {
    requirePetSender(event)
    return managedAuthManager.login()
  })

  handlePetIpc('managed:cancel-login', (event) => {
    requirePetSender(event)
    return managedAuthManager.cancel()
  })

  handlePetIpc('managed:logout', (event) => {
    requirePetSender(event)
    return managedAuthManager.logout()
  })

  handlePetIpc('managed:revoke-current-device', (event) => {
    requirePetSender(event)
    return managedAuthManager.revokeCurrentDevice()
  })

  handlePetIpc('assistant:get-capability-settings', (event) => {
    requirePetSender(event)
    return assistantManager.getCapabilitySettings()
  })

  handlePetIpc('assistant:set-chat-source', async (event, source: unknown) => {
    requirePetSender(event)
    if (source !== 'byok' && source !== 'managed' && source !== 'disabled') {
      throw new TypeError('Chat 来源无效。')
    }
    if (managedAuthManager.getStatus().state === 'authenticated') {
      await updateManagedCapabilityPreference('chat', source === 'managed')
      if (source === 'managed') return assistantManager.getCapabilitySettings()
    }
    return assistantManager.setChatSource(source)
  })
  handlePetIpc('assistant:set-service-mode', async (event, mode: unknown) => {
    requirePetSender(event)
    if (mode !== 'byok' && mode !== 'managed') {
      throw new TypeError('助手服务模式无效。')
    }
    if (managedAuthManager.getStatus().state === 'authenticated') {
      const previousMode = assistantManager.getServiceModeSelection()
      const current = requireManagedCapabilityPreferences()
      const preferences: ManagedCapabilityStateMap = mode === 'byok'
        // 自有配置只接管 Chat 与联网搜索；其他官方能力开关属于独立偏好，必须保留。
        ? { ...current, chat: false, web_search: false }
        : { ...current, chat: true, web_search: true }
      assistantManager.setServiceModeSelection(mode)
      try {
        await managedAuthManager.updateCapabilityPreferences(preferences)
      } catch (error) {
        assistantManager.setServiceModeSelection(previousMode)
        throw error
      }
      if (mode === 'managed') return assistantManager.getCapabilitySettings()
    }
    return assistantManager.setServiceMode(mode as AssistantServiceMode)
  })
  handlePetIpc('assistant:set-web-search-source', async (event, source: unknown) => {
    requirePetSender(event)
    if (source !== 'byok' && source !== 'managed' && source !== 'disabled') {
      throw new TypeError('Web Search 来源无效。')
    }
    if (managedAuthManager.getStatus().state === 'authenticated') {
      await updateManagedCapabilityPreference('web_search', source === 'managed')
      if (source === 'managed') return assistantManager.getCapabilitySettings()
    }
    return assistantManager.setWebSearchSource(source)
  })
  handlePetIpc('assistant:set-vision-source', async (event, source: unknown) => {
    requirePetSender(event)
    if (source !== 'byok' && source !== 'managed' && source !== 'disabled') {
      throw new TypeError('Vision 来源无效。')
    }
    if (managedAuthManager.getStatus().state === 'authenticated') {
      await updateManagedCapabilityPreference('vision', source === 'managed')
      if (source === 'managed') return assistantManager.getCapabilitySettings()
    }
    return assistantManager.setVisionSource(source)
  })
  handlePetIpc('assistant:set-embedding-source', async (event, source: unknown) => {
    requirePetSender(event)
    if (source !== 'managed' && source !== 'local' && source !== 'byok') {
      throw new TypeError('Embedding 来源无效。')
    }
    if (managedAuthManager.getStatus().state === 'authenticated') {
      await updateManagedCapabilityPreference('embedding', source === 'managed')
      if (source === 'managed') return assistantManager.getCapabilitySettings()
    }
    return assistantManager.setEmbeddingSource(source)
  })
  handlePetIpc('assistant:set-rerank-source', async (event, source: unknown) => {
    requirePetSender(event)
    if (source !== 'managed' && source !== 'disabled') {
      throw new TypeError('Rerank 来源无效。')
    }
    if (managedAuthManager.getStatus().state === 'authenticated') {
      await updateManagedCapabilityPreference('rerank', source === 'managed')
      if (source === 'managed') return assistantManager.getCapabilitySettings()
    }
    return assistantManager.setRerankSource(source)
  })

  handlePetIpc('assistant:set-model-settings', (event, input: AssistantModelSettingsInput) => {
    requirePetSender(event)
    return assistantManager.configureModelSettings(input)
  })

  handlePetIpc(
    'assistant:stage-dropped-files',
    async (event, paths: unknown, dropZone: unknown) => {
      const window = requirePetSender(event)
      requireAttachmentPaths(paths)
      const zone = requireAttachmentDropZone(dropZone)
      if (zone === 'pet') {
        openAssistantForPet(window)
      }
      const attachments = await assistantManager.stageAttachments(paths)
      return { dropZone: zone, attachments }
    }
  )

  handlePetIpc('assistant:pick-attachments', async (event) => {
    const window = requirePetSender(event)
    const selection = await dialog.showOpenDialog(window, {
      title: '选择要添加到对话的文件',
      properties: ['openFile', 'multiSelections']
    })
    if (selection.canceled || selection.filePaths.length === 0) {
      return []
    }
    return assistantManager.stageAttachments(selection.filePaths)
  })

  handlePetIpc('assistant:remove-attachment', (event, attachmentId: unknown) => {
    requirePetSender(event)
    requireAttachmentId(attachmentId)
    return assistantManager.removeDraftAttachment(attachmentId)
  })

  handlePetIpc('assistant:preview-attachment', (event, input: AssistantAttachmentPreviewInput) => {
    requirePetSender(event)
    return assistantManager.previewAttachment(input)
  })

  handlePetIpc('assistant:preview-artifact', (event, input: AssistantArtifactPreviewInput) => {
    requirePetSender(event)
    return assistantManager.previewArtifact(input)
  })

  handlePetIpc('assistant:delete-artifact', (event, input: AssistantArtifactAccessInput) => {
    requirePetSender(event)
    return assistantManager.deleteArtifact(input)
  })

  handlePetIpc('assistant:save-artifact', async (event, input: AssistantArtifactAccessInput) => {
    const window = requirePetSender(event)
    const artifact = await assistantManager.getArtifact(input)
    if (artifact.status !== 'ready') {
      throw new Error('Artifact 尚未生成成功。')
    }
    const extension = extname(artifact.name).slice(1) || 'txt'
    const selection = await showArtifactSaveDialog(window, artifact.name, extension)
    if (selection.canceled || !selection.filePath) {
      assistantManager.recordArtifactAudit('save', artifact.id, false, 'artifact_save_cancelled')
      return {
        status: 'cancelled',
        artifact,
        error: null
      } satisfies AssistantArtifactSaveResult
    }
    try {
      const content = await assistantManager.getArtifactContent(input)
      const result = await writeArtifactAtomically(selection.filePath, content)
      const saved = await assistantManager.markArtifactSaved(input)
      assistantManager.recordArtifactAudit('save', artifact.id, true)
      logInfo('assistant artifact saved', {
        artifactId: artifact.id,
        bytes: content.byteLength,
        overwritten: result.overwritten
      })
      return { status: 'saved', artifact: saved, error: null } satisfies AssistantArtifactSaveResult
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? String((error as NodeJS.ErrnoException).code || 'UNKNOWN')
        : 'UNKNOWN'
      assistantManager.recordArtifactAudit('save', artifact.id, false, 'artifact_save_failed')
      logError('assistant artifact save failed', { artifactId: artifact.id, code })
      return {
        status: 'failed',
        artifact,
        error: '文件保存失败，应用内生成文件仍然保留，可以重试。'
      } satisfies AssistantArtifactSaveResult
    }
  })

  handlePetIpc('assistant:cancel', (event, taskId: string) => {
    requirePetSender(event)
    return assistantManager.cancel(taskId)
  })

  handlePetIpc('assistant:resolve-permission', (event, input: AssistantPermissionResolution) => {
    requirePetSender(event)
    if (!input || typeof input !== 'object') {
      throw new TypeError('Permission resolution is invalid.')
    }
    return assistantManager.resolvePermission(input)
  })

  handlePetIpc('assistant:get-memory', (event) => {
    requirePetSender(event)
    return assistantManager.getMemorySnapshot()
  })

  handlePetIpc('assistant:get-conversation-messages', (event, conversationId: string) => {
    requirePetSender(event)
    requireMemoryId(conversationId)
    return assistantManager.getConversationMessages(conversationId)
  })

  handlePetIpc('assistant:delete-memory-item', (event, kind: MemoryItemKind, id: string) => {
    requirePetSender(event)
    requireMemoryKind(kind)
    requireMemoryId(id)
    return assistantManager.deleteMemoryItem(kind, id)
  })

  handlePetIpc('assistant:clear-memory', (event, scope: MemoryClearScope) => {
    requirePetSender(event)
    requireMemoryScope(scope)
    return assistantManager.clearMemory(scope)
  })

  handlePetIpc(
    'assistant:resolve-memory-candidate',
    (event, candidateId: number, decision: 'confirmed' | 'rejected') => {
      requirePetSender(event)
      if (!Number.isInteger(candidateId) || candidateId < 1) {
        throw new TypeError('Memory candidate id is invalid.')
      }
      if (decision !== 'confirmed' && decision !== 'rejected') {
        throw new TypeError('Memory candidate decision is invalid.')
      }
      return assistantManager.resolveMemoryCandidate(candidateId, decision)
    }
  )

  handlePetIpc('assistant:get-knowledge', (event) => {
    requirePetSender(event)
    return assistantManager.getKnowledgeSnapshot()
  })

  handlePetIpc('assistant:add-knowledge-library', async (event) => {
    const window = requirePetSender(event)
    const selection = await dialog.showOpenDialog(window, {
      title: '选择允许 PetDock 索引的目录',
      properties: ['openDirectory', 'createDirectory']
    })
    const [selectedPath] = selection.filePaths
    if (selection.canceled || !selectedPath) {
      return null
    }
    // 路径只能来自 Main 的原生选择器，Renderer 没有提交任意文件系统路径的能力。
    return assistantManager.addKnowledgeLibrary(basename(selectedPath), selectedPath)
  })

  handlePetIpc('assistant:start-knowledge-index', (event, libraryId: string) => {
    requirePetSender(event)
    requireKnowledgeLibraryId(libraryId)
    return assistantManager.startKnowledgeIndex(libraryId)
  })

  handlePetIpc('assistant:pause-knowledge-index', (event, libraryId: string) => {
    requirePetSender(event)
    requireKnowledgeLibraryId(libraryId)
    return assistantManager.pauseKnowledgeIndex(libraryId)
  })

  handlePetIpc('assistant:delete-knowledge-library', (event, libraryId: string) => {
    requirePetSender(event)
    requireKnowledgeLibraryId(libraryId)
    return assistantManager.deleteKnowledgeLibrary(libraryId).then((deleted: boolean) => {
      if (deleted) {
        const selected = loadSettings().assistantKnowledgeLibraryIds.filter((id) => id !== libraryId)
        updateSettings({ assistantKnowledgeLibraryIds: selected })
      }
      return deleted
    })
  })

  handlePetIpc('assistant:set-knowledge-selection', (event, libraryIds: unknown) => {
    requirePetSender(event)
    if (!Array.isArray(libraryIds) || libraryIds.length > 20) {
      throw new TypeError('Knowledge library selection is invalid.')
    }
    libraryIds.forEach(requireKnowledgeLibraryId)
    const selected = [...new Set(libraryIds)]
    updateSettings({ assistantKnowledgeLibraryIds: selected })
    return selected
  })

  handlePetIpc('assistant:get-embedding-models', (event) => {
    requirePetSender(event)
    return assistantManager.getEmbeddingSnapshot()
  })

  handlePetIpc('assistant:get-skills', (event) => {
    requirePetSender(event)
    return assistantManager.getSkillSnapshot()
  })

  handlePetIpc('assistant:refresh-skills', (event) => {
    requirePetSender(event)
    return assistantManager.refreshSkills()
  })

  handlePetIpc('assistant:preview-local-skills', async (event) => {
    const window = requirePetSender(event)
    const selection = await dialog.showOpenDialog(window, {
      title: '选择包含 SKILL.md 的目录',
      properties: ['openDirectory']
    })
    const [selectedPath] = selection.filePaths
    if (selection.canceled || !selectedPath) {
      return null
    }
    return assistantManager.previewLocalSkills(selectedPath)
  })

  handlePetIpc('assistant:preview-github-skills', (event, url: string) => {
    requirePetSender(event)
    requireString(url)
    return assistantManager.previewGithubSkills(url)
  })

  handlePetIpc(
    'assistant:install-skills',
    (event, previewToken: string, skillIds: string[]) => {
      requirePetSender(event)
      requireString(previewToken)
      if (!Array.isArray(skillIds)) {
        throw new TypeError('Skill 安装选择无效。')
      }
      return assistantManager.installSkills(previewToken, skillIds)
    }
  )

  handlePetIpc('assistant:set-skill-enabled', (event, skillId: string, enabled: boolean) => {
    requirePetSender(event)
    requireString(skillId)
    requireBoolean(enabled)
    return assistantManager.setSkillEnabled(skillId, enabled)
  })

  handlePetIpc('assistant:uninstall-skill', (event, skillId: string) => {
    requirePetSender(event)
    requireString(skillId)
    return assistantManager.uninstallSkill(skillId)
  })

  handlePetIpc('assistant:download-embedding-model', (event, modelId: string) => {
    requirePetSender(event)
    requireEmbeddingModelId(modelId)
    return assistantManager.downloadEmbeddingModel(modelId)
  })

  handlePetIpc('assistant:pause-embedding-download', (event, modelId: string) => {
    requirePetSender(event)
    requireEmbeddingModelId(modelId)
    return assistantManager.pauseEmbeddingModelDownload(modelId)
  })

  handlePetIpc('assistant:select-embedding-model', (event, modelId: string | null) => {
    requirePetSender(event)
    if (modelId !== null) {
      requireEmbeddingModelId(modelId)
    }
    return assistantManager.selectEmbeddingModel(modelId)
  })

  handlePetIpc(
    'assistant:configure-online-embedding',
    (event, input: AssistantEmbeddingOnlineInput) => {
      requirePetSender(event)
      return assistantManager.configureOnlineEmbedding(input)
    }
  )

  handlePetIpc('assistant:delete-embedding-model', (event, modelId: string) => {
    requirePetSender(event)
    requireEmbeddingModelId(modelId)
    return assistantManager.deleteEmbeddingModel(modelId)
  })

  handlePetIpc('assistant:close', (event) => {
    const window = requirePetSender(event)
    if (!isAssistantExpanded(window)) {
      return
    }
    collapsePetWindowAssistant(window)
    void assistantManager
      .cancelAll()
      .catch((error: unknown) => logError('assistant tasks failed to cancel', error))
  })
}

if (isPrimaryInstance) {
  app.whenReady().then(() => {
    logInfo('app ready')
    ensureUserPetsRoot()
    ensureSelectedPetIsAvailable()
    registerIpc()
    openPetWindow()
    screenshotManager.registerGlobalShortcut()
    logInfo('桌面更新底座已初始化', { kind: updateKind, phase: desktopUpdates.snapshot().phase })
    if (desktopUpdates.snapshot().phase !== 'disabled') {
      const startupCheck = setTimeout(() => {
        if (!quitInProgress) void desktopUpdateUi.open(true).catch(() => logError('启动检查更新失败'))
      }, 20_000)
      startupCheck.unref()
    }
    void (async () => {
      try {
        // 先读取服务端 Feature Flags，再恢复已有会话，避免使用初始化时的关闭态默认值。
        await managedAuthManager.refreshFeatures()
        await managedAuthManager.restoreSession()
      } catch {
        // 认证编排器正常失败都会返回脱敏状态；这里只兜底未预期的启动异常。
        logError('managed session restore unexpectedly failed')
      }
    })()
    void assistantManager.start().catch((error: unknown) => {
      logError('assistant runtime failed to start', error)
    })

    app.on('activate', () => {
      if (!petWindow || petWindow.isDestroyed()) {
        openPetWindow()
      } else {
        petWindow.showInactive()
      }
    })
  })
}

function openPetWindow(): void {
  const window = createPetWindow()
  petWindow = window
  window.once('closed', () => {
    if (petWindow === window) {
      petWindow = null
    }
  })
  createTray(window, () => openAssistantForPet(window), {
    open: () => { void desktopUpdateUi.open().catch(() => logError('更新对话框打开失败')) },
    label: () => {
      const status = desktopUpdates.snapshot()
      if (status.phase === 'downloading') return `更新下载 ${Math.floor(status.progress || 0)}%`
      if (['downloaded', 'deferred'].includes(status.phase)) return '重启安装更新'
      return '检查更新'
    }
  })
}

function openAssistantForPet(window: BrowserWindow): void {
  expandPetWindowForAssistant(window)
  void assistantManager.start().catch((error: unknown) => {
    logError('assistant runtime failed to start', error)
  })
}

/** 浏览器回到应用后，受控刷新官网相关的脱敏状态，避免重复并发刷新。 */
function refreshManagedPortalStatus(): Promise<void> {
  if (activeManagedPortalRefresh) {
    return activeManagedPortalRefresh
  }
  let task: Promise<void> | null = null
  task = (async () => {
    try {
      await managedAuthManager.refreshFeatures()
      await managedAuthManager.restoreSession()
    } catch (error) {
      logError('managed portal return refresh failed', error)
    } finally {
      if (activeManagedPortalRefresh === task) {
        activeManagedPortalRefresh = null
      }
    }
  })()
  activeManagedPortalRefresh = task
  return task
}

/** 更新单项服务端能力偏好；整体提交可避免多设备并发时遗漏其他能力。 */
async function updateManagedCapabilityPreference(
  capability: ManagedCapabilityName,
  enabled: boolean
): Promise<void> {
  const preferences = requireManagedCapabilityPreferences()
  await managedAuthManager.updateCapabilityPreferences({
    ...preferences,
    [capability]: enabled
  })
}

/** 读取已登录账号的服务端偏好；认证完成却没有快照属于同步错误。 */
function requireManagedCapabilityPreferences(): ManagedCapabilityStateMap {
  const snapshot = managedAuthManager.getCapabilityPreferences()
  if (!snapshot) {
    throw new ManagedControlPlaneError(null, 'internal_error', false)
  }
  return { ...snapshot.preferences }
}

function requirePetSender(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow {
  if (!petWindow || petWindow.isDestroyed() || event.sender !== petWindow.webContents) {
    throw new Error('Unauthorized IPC sender.')
  }
  return petWindow
}

function requireFiniteNumbers(...values: number[]): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError('IPC coordinates must be finite numbers.')
  }
}

function requireBoolean(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError('IPC value must be a boolean.')
  }
}

function requireString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('IPC value must be a non-empty string.')
  }
}

/** 仅允许 Renderer 请求固定官网管理目标，不接受任意 URL 或查询参数。 */
function requireManagedPortalTarget(value: unknown): ManagedPortalTarget {
  if (!isManagedPortalTarget(value)) {
    throw new TypeError('Managed portal target is invalid.')
  }
  return value
}

/**
 * 记录一次 Renderer 发起的图集选择结果，后续创建时只通过 token 回传。
 */
function registerPetSpritesheetSelection(filePath: string): PetSpritesheetSelection {
  const token = randomUUID()
  const fileName = basename(filePath)
  pendingPetSpritesheetSelections.set(token, { filePath, fileName })
  if (pendingPetSpritesheetSelections.size > 32) {
    const [oldestToken] = pendingPetSpritesheetSelections.keys()
    if (oldestToken) {
      pendingPetSpritesheetSelections.delete(oldestToken)
    }
  }
  return { token, fileName }
}

/**
 * 校验图集选择 token 是否存在，只有创建成功后才真正删除该记录。
 */
function requirePetSpritesheetSelection(token: string): { filePath: string; fileName: string } {
  const selection = pendingPetSpritesheetSelections.get(token)
  if (!selection) {
    throw new Error('图集选择已失效，请重新选择图片。')
  }
  return selection
}

/**
 * 校验桌宠创建表单，只允许 Renderer 传入最小元数据和一次性 token。
 */
function requireCreatePetInput(value: unknown): CreatePetInput {
  if (!value || typeof value !== 'object') {
    throw new TypeError('桌宠创建参数无效。')
  }
  const input = value as Partial<CreatePetInput>
  requireString(input.id)
  requireString(input.displayName)
  if (typeof input.description !== 'string') {
    throw new TypeError('桌宠描述无效。')
  }
  requireString(input.spritesheetToken)
  if (input.makeCurrent !== undefined && typeof input.makeCurrent !== 'boolean') {
    throw new TypeError('桌宠切换参数无效。')
  }
  return {
    id: input.id,
    displayName: input.displayName,
    description: input.description,
    spritesheetToken: input.spritesheetToken,
    ...(input.makeCurrent !== undefined ? { makeCurrent: input.makeCurrent } : {})
  }
}

/** 校验 Renderer 提交的剪贴板文本，避免异常大载荷进入主进程。 */
function requireClipboardText(value: unknown): string {
  requireString(value)
  if (value.length > 2_000_000) {
    throw new TypeError('待复制文本过长。')
  }
  return value
}

/** 限制单次拖拽路径数量；路径值仅在 Preload 与 Main 间流转。 */
function requireAttachmentPaths(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 10 ||
    value.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 32_768)
  ) {
    throw new TypeError('附件路径列表无效。')
  }
}

/** 校验附件只能投放到桌宠或已展开对话区。 */
function requireAttachmentDropZone(value: unknown): AssistantAttachmentDropZone {
  if (value !== 'pet' && value !== 'conversation') {
    throw new TypeError('附件投放区域无效。')
  }
  return value
}

/** 校验 Renderer 只能提交固定格式的附件 ID。 */
function requireAttachmentId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) {
    throw new TypeError('附件 ID 无效。')
  }
}

/** 校验助手消息外链，禁止 Renderer 打开本地文件或自定义协议。 */
function requireExternalHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw new TypeError('External URL is invalid.')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('External URL is invalid.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('External URL protocol is not allowed.')
  }
  return url.toString()
}

function requireMemoryKind(value: unknown): asserts value is MemoryItemKind {
  if (value !== 'conversation' && value !== 'memory' && value !== 'app' && value !== 'directory') {
    throw new TypeError('Memory item kind is invalid.')
  }
}

function requireMemoryScope(value: unknown): asserts value is MemoryClearScope {
  if (value !== 'all' && value !== 'conversations' && value !== 'memories' && value !== 'tool_logs') {
    throw new TypeError('Memory clear scope is invalid.')
  }
}

function requireMemoryId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new TypeError('Memory item id is invalid.')
  }
}

function requireKnowledgeLibraryId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) {
    throw new TypeError('Knowledge library id is invalid.')
  }
}

function requireEmbeddingModelId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9.-]{1,128}$/.test(value)) {
    throw new TypeError('Embedding model id is invalid.')
  }
}

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

app.on('before-quit', (event) => {
  if (quitAfterRuntimeStops) {
    return
  }
  if (updateGate.snapshot().reserved) {
    if (desktopUpdates.snapshot().phase === 'installing' && assistantManager.getStatus().state === 'stopped') {
      managedAuthManager.dispose()
      flushSettings()
      quitAfterRuntimeStops = true
      return
    }
    event.preventDefault()
    return
  }
  event.preventDefault()
  if (quitInProgress) return
  quitInProgress = true
  logInfo('应用退出：保存设置并停止助手')
  managedAuthManager.dispose()
  flushSettings()
  void assistantManager
    .stop()
    .catch((error: unknown) => logError('assistant runtime failed to stop', error))
    .finally(() => {
      quitAfterRuntimeStops = true
      app.quit()
    })
})

app.on('window-all-closed', () => {
  // Keep the tray app alive until the user chooses Quit.
})

app.on('will-quit', () => {
  screenshotManager.dispose()
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
