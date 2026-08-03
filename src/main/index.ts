import { BrowserWindow, app, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { basename, extname } from 'node:path'
import type {
  AssistantAskInput,
  AssistantAttachmentDropZone,
  AssistantAttachmentPreviewInput,
  AssistantArtifactAccessInput,
  AssistantArtifactPreviewInput,
  AssistantArtifactSaveResult,
  AssistantEmbeddingOnlineInput,
  AssistantLayoutTrace,
  AssistantWebSettingsInput,
  MemoryClearScope,
  MemoryItemKind,
  AssistantPermissionResolution
} from '../shared/assistant'
import { AssistantManager } from './assistant/assistantManager'
import { writeArtifactAtomically } from './assistant/artifactFileWriter'
import { logError, logInfo } from './logger'
import { setAssistantTheme } from './theme'
import {
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

let petWindow: BrowserWindow | null = null
let quitAfterRuntimeStops = false
const assistantManager = new AssistantManager(
  (status) => petWindow?.webContents.send('assistant:status', status),
  (event) => petWindow?.webContents.send('assistant:event', event)
)

app.disableHardwareAcceleration()
app.setAppUserModelId('com.local.petdock')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')

function registerIpc(): void {
  ipcMain.on('assistant:layout-applied', (event: IpcMainEvent, revision: number) => {
    const window = requirePetSender(event)
    if (Number.isInteger(revision)) {
      acknowledgePetWindowLayout(window, revision)
    }
  })

  ipcMain.on('assistant:layout-trace', (event: IpcMainEvent, trace: AssistantLayoutTrace) => {
    const window = requirePetSender(event)
    if (!isAssistantLayoutTrace(trace)) {
      return
    }
    logInfo('assistant layout trace', {
      ...trace,
      windowBounds: window.getBounds(),
      petPosition: getPetWindowPosition(window)
    })
  })

  ipcMain.handle('pet:move-window', (event, x: number, y: number) => {
    const window = requirePetSender(event)
    requireFiniteNumbers(x, y)
    return movePetWindow(window, x, y)
  })

  ipcMain.handle('pet:get-window-position', (event) => {
    const window = requirePetSender(event)
    return getPetWindowPosition(window)
  })

  ipcMain.handle('pet:begin-drag', (event) => {
    const window = requirePetSender(event)
    return beginPetWindowDrag(window, 0, 0)
  })

  ipcMain.handle('pet:begin-drag-at', (event, grabOffsetX: number, grabOffsetY: number) => {
    const window = requirePetSender(event)
    requireFiniteNumbers(grabOffsetX, grabOffsetY)
    return beginPetWindowDrag(window, grabOffsetX, grabOffsetY)
  })

  ipcMain.handle('pet:drag-window', (event) => {
    const window = requirePetSender(event)
    return dragPetWindow(window)
  })

  ipcMain.handle('pet:end-drag', (event) => {
    endPetWindowDrag(requirePetSender(event))
  })

  ipcMain.handle('pet:reset-position', (event) => {
    const window = requirePetSender(event)
    return resetPetWindowPosition(window)
  })

  ipcMain.handle('pet:set-always-on-top', (event, value: boolean) => {
    const window = requirePetSender(event)
    requireBoolean(value)
    const next = setAlwaysOnTop(window, value)
    rebuildTrayMenu(window)
    return next
  })

  ipcMain.handle('pet:set-click-through', (event, value: boolean) => {
    const window = requirePetSender(event)
    requireBoolean(value)
    const next = setClickThrough(window, value)
    rebuildTrayMenu(window)
    return next
  })

  ipcMain.handle('pet:set-transparent-area-click-through', (event, value: boolean) => {
    const window = requirePetSender(event)
    requireBoolean(value)
    setTransparentAreaClickThrough(window, value)
  })

  ipcMain.handle('pet:get-settings', (event) => {
    requirePetSender(event)
    return loadSettings()
  })

  ipcMain.handle('pet:list-available', (event) => {
    requirePetSender(event)
    return listAvailablePets()
  })

  ipcMain.handle('pet:load-manifest', (event, petId: string) => {
    requirePetSender(event)
    requireString(petId)
    if (!isAvailablePet(petId)) {
      return null
    }
    return readPetManifest(petId)
  })

  ipcMain.handle('pet:load-spritesheet', (event, petId: string, spritesheetPath: string) => {
    requirePetSender(event)
    requireString(petId)
    requireString(spritesheetPath)
    if (!isAvailablePet(petId)) {
      return null
    }
    return readPetSpritesheetDataUrl(petId, spritesheetPath)
  })

  ipcMain.handle('pet:set-current', (event, petId: string) => {
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

  ipcMain.handle('pet:show-context-menu', (event) => {
    const window = requirePetSender(event)
    createPetContextMenu(window).popup({ window })
  })

  ipcMain.handle('app:quit', (event) => {
    requirePetSender(event)
    app.quit()
  })

  ipcMain.handle('assistant:open', (event) => {
    const window = requirePetSender(event)
    openAssistantForPet(window)
  })

  ipcMain.handle('assistant:open-external-url', async (event, value: unknown) => {
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

  ipcMain.handle('assistant:get-status', (event) => {
    requirePetSender(event)
    return assistantManager.getStatus()
  })

  ipcMain.handle('assistant:get-web-settings', (event) => {
    requirePetSender(event)
    return assistantManager.getWebSettings()
  })

  ipcMain.handle('assistant:set-web-settings', (event, input: AssistantWebSettingsInput) => {
    requirePetSender(event)
    return assistantManager.configureWebSettings(input)
  })

  ipcMain.handle('assistant:test-web-search', (event) => {
    requirePetSender(event)
    return assistantManager.testWebSearch()
  })

  ipcMain.handle('assistant:get-layout', (event) => {
    return getPetWindowLayout(requirePetSender(event))
  })

  ipcMain.handle('assistant:set-theme', (event, theme: unknown) => {
    const window = requirePetSender(event)
    const next = setAssistantTheme(window, theme)
    rebuildTrayMenu(window)
    return next
  })

  ipcMain.handle('assistant:ask', (event, request: AssistantAskInput) => {
    requirePetSender(event)
    if (!request || typeof request !== 'object') {
      throw new TypeError('Assistant request is invalid.')
    }
    return assistantManager.ask(request)
  })

  ipcMain.handle(
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

  ipcMain.handle('assistant:pick-attachments', async (event) => {
    const window = requirePetSender(event)
    const selection = await dialog.showOpenDialog(window, {
      title: '选择要添加到对话的文本文件',
      properties: ['openFile', 'multiSelections']
    })
    if (selection.canceled || selection.filePaths.length === 0) {
      return []
    }
    return assistantManager.stageAttachments(selection.filePaths)
  })

  ipcMain.handle('assistant:remove-attachment', (event, attachmentId: unknown) => {
    requirePetSender(event)
    requireAttachmentId(attachmentId)
    return assistantManager.removeDraftAttachment(attachmentId)
  })

  ipcMain.handle('assistant:preview-attachment', (event, input: AssistantAttachmentPreviewInput) => {
    requirePetSender(event)
    return assistantManager.previewAttachment(input)
  })

  ipcMain.handle('assistant:preview-artifact', (event, input: AssistantArtifactPreviewInput) => {
    requirePetSender(event)
    return assistantManager.previewArtifact(input)
  })

  ipcMain.handle('assistant:delete-artifact', (event, input: AssistantArtifactAccessInput) => {
    requirePetSender(event)
    return assistantManager.deleteArtifact(input)
  })

  ipcMain.handle('assistant:save-artifact', async (event, input: AssistantArtifactAccessInput) => {
    const window = requirePetSender(event)
    const artifact = await assistantManager.getArtifact(input)
    if (artifact.status !== 'ready') {
      throw new Error('Artifact 尚未生成成功。')
    }
    const extension = extname(artifact.name).slice(1) || 'txt'
    const selection = await dialog.showSaveDialog(window, {
      title: '保存生成文件',
      defaultPath: artifact.name,
      filters: [{ name: `${extension.toUpperCase()} 文件`, extensions: [extension] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
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

  ipcMain.handle('assistant:cancel', (event, taskId: string) => {
    requirePetSender(event)
    return assistantManager.cancel(taskId)
  })

  ipcMain.handle('assistant:resolve-permission', (event, input: AssistantPermissionResolution) => {
    requirePetSender(event)
    if (!input || typeof input !== 'object') {
      throw new TypeError('Permission resolution is invalid.')
    }
    return assistantManager.resolvePermission(input)
  })

  ipcMain.handle('assistant:get-memory', (event) => {
    requirePetSender(event)
    return assistantManager.getMemorySnapshot()
  })

  ipcMain.handle('assistant:get-conversation-messages', (event, conversationId: string) => {
    requirePetSender(event)
    requireMemoryId(conversationId)
    return assistantManager.getConversationMessages(conversationId)
  })

  ipcMain.handle('assistant:delete-memory-item', (event, kind: MemoryItemKind, id: string) => {
    requirePetSender(event)
    requireMemoryKind(kind)
    requireMemoryId(id)
    return assistantManager.deleteMemoryItem(kind, id)
  })

  ipcMain.handle('assistant:clear-memory', (event, scope: MemoryClearScope) => {
    requirePetSender(event)
    requireMemoryScope(scope)
    return assistantManager.clearMemory(scope)
  })

  ipcMain.handle(
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

  ipcMain.handle('assistant:get-knowledge', (event) => {
    requirePetSender(event)
    return assistantManager.getKnowledgeSnapshot()
  })

  ipcMain.handle('assistant:add-knowledge-library', async (event) => {
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

  ipcMain.handle('assistant:start-knowledge-index', (event, libraryId: string) => {
    requirePetSender(event)
    requireKnowledgeLibraryId(libraryId)
    return assistantManager.startKnowledgeIndex(libraryId)
  })

  ipcMain.handle('assistant:pause-knowledge-index', (event, libraryId: string) => {
    requirePetSender(event)
    requireKnowledgeLibraryId(libraryId)
    return assistantManager.pauseKnowledgeIndex(libraryId)
  })

  ipcMain.handle('assistant:delete-knowledge-library', (event, libraryId: string) => {
    requirePetSender(event)
    requireKnowledgeLibraryId(libraryId)
    return assistantManager.deleteKnowledgeLibrary(libraryId).then((deleted) => {
      if (deleted) {
        const selected = loadSettings().assistantKnowledgeLibraryIds.filter((id) => id !== libraryId)
        updateSettings({ assistantKnowledgeLibraryIds: selected })
      }
      return deleted
    })
  })

  ipcMain.handle('assistant:set-knowledge-selection', (event, libraryIds: unknown) => {
    requirePetSender(event)
    if (!Array.isArray(libraryIds) || libraryIds.length > 20) {
      throw new TypeError('Knowledge library selection is invalid.')
    }
    libraryIds.forEach(requireKnowledgeLibraryId)
    const selected = [...new Set(libraryIds)]
    updateSettings({ assistantKnowledgeLibraryIds: selected })
    return selected
  })

  ipcMain.handle('assistant:get-embedding-models', (event) => {
    requirePetSender(event)
    return assistantManager.getEmbeddingSnapshot()
  })

  ipcMain.handle('assistant:get-skills', (event) => {
    requirePetSender(event)
    return assistantManager.getSkillSnapshot()
  })

  ipcMain.handle('assistant:refresh-skills', (event) => {
    requirePetSender(event)
    return assistantManager.refreshSkills()
  })

  ipcMain.handle('assistant:preview-local-skills', async (event) => {
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

  ipcMain.handle('assistant:preview-github-skills', (event, url: string) => {
    requirePetSender(event)
    requireString(url)
    return assistantManager.previewGithubSkills(url)
  })

  ipcMain.handle(
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

  ipcMain.handle('assistant:set-skill-enabled', (event, skillId: string, enabled: boolean) => {
    requirePetSender(event)
    requireString(skillId)
    requireBoolean(enabled)
    return assistantManager.setSkillEnabled(skillId, enabled)
  })

  ipcMain.handle('assistant:uninstall-skill', (event, skillId: string) => {
    requirePetSender(event)
    requireString(skillId)
    return assistantManager.uninstallSkill(skillId)
  })

  ipcMain.handle('assistant:download-embedding-model', (event, modelId: string) => {
    requirePetSender(event)
    requireEmbeddingModelId(modelId)
    return assistantManager.downloadEmbeddingModel(modelId)
  })

  ipcMain.handle('assistant:pause-embedding-download', (event, modelId: string) => {
    requirePetSender(event)
    requireEmbeddingModelId(modelId)
    return assistantManager.pauseEmbeddingModelDownload(modelId)
  })

  ipcMain.handle('assistant:select-embedding-model', (event, modelId: string | null) => {
    requirePetSender(event)
    if (modelId !== null) {
      requireEmbeddingModelId(modelId)
    }
    return assistantManager.selectEmbeddingModel(modelId)
  })

  ipcMain.handle(
    'assistant:configure-online-embedding',
    (event, input: AssistantEmbeddingOnlineInput) => {
      requirePetSender(event)
      return assistantManager.configureOnlineEmbedding(input)
    }
  )

  ipcMain.handle('assistant:delete-embedding-model', (event, modelId: string) => {
    requirePetSender(event)
    requireEmbeddingModelId(modelId)
    return assistantManager.deleteEmbeddingModel(modelId)
  })

  ipcMain.handle('assistant:close', (event) => {
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

app.whenReady().then(() => {
  logInfo('app ready')
  ensureUserPetsRoot()
  ensureSelectedPetIsAvailable()
  registerIpc()
  openPetWindow()
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

function openPetWindow(): void {
  const window = createPetWindow()
  petWindow = window
  window.once('closed', () => {
    if (petWindow === window) {
      petWindow = null
    }
  })
  createTray(window, () => openAssistantForPet(window))
}

function openAssistantForPet(window: BrowserWindow): void {
  expandPetWindowForAssistant(window)
  void assistantManager.start().catch((error: unknown) => {
    logError('assistant runtime failed to start', error)
  })
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

function isAssistantLayoutTrace(value: unknown): value is AssistantLayoutTrace {
  if (!value || typeof value !== 'object') {
    return false
  }
  const trace = value as Partial<AssistantLayoutTrace>
  const phases = new Set(['double-click', 'layout-applied', 'frame-1', 'frame-2'])
  return (
    typeof trace.phase === 'string' &&
    phases.has(trace.phase) &&
    (trace.revision === null || Number.isInteger(trace.revision)) &&
    !!trace.viewport &&
    Number.isFinite(trace.viewport.width) &&
    Number.isFinite(trace.viewport.height) &&
    !!trace.pet &&
    [trace.pet.x, trace.pet.y, trace.pet.width, trace.pet.height].every(Number.isFinite)
  )
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
  logInfo('before quit')
  flushSettings()
  event.preventDefault()
  quitAfterRuntimeStops = true
  void assistantManager
    .stop()
    .catch((error: unknown) => logError('assistant runtime failed to stop', error))
    .finally(() => app.quit())
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
