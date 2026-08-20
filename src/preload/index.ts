import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AssistantAttachmentDropResult,
  AssistantAttachmentDropZone,
  AssistantAttachmentPreview,
  AssistantAttachmentPreviewInput,
  AssistantAttachmentSummary,
  AssistantArtifactAccessInput,
  AssistantArtifactPreview,
  AssistantArtifactPreviewInput,
  AssistantArtifactSaveResult,
  AssistantAskInput,
  AssistantAskResult,
  AssistantCapabilitySettingsSnapshot,
  AssistantConversationMessage,
  AssistantDocumentCapabilities,
  AssistantEvent,
  AssistantEmbeddingOnlineInput,
  AssistantEmbeddingSnapshot,
  AssistantLayoutTrace,
  AssistantKnowledgeLibrary,
  AssistantKnowledgeSnapshot,
  AssistantMemorySnapshot,
  AssistantModelSettingsInput,
  AssistantModelSettingsSnapshot,
  AssistantPermissionResolution,
  AssistantRuntimeStatus,
  AssistantSkillInstallPreview,
  AssistantSkillSnapshot,
  AssistantWebSettingsInput,
  AssistantWebSettingsSnapshot,
  AssistantWindowLayout,
  AssistantVisionSnapshot,
  AssistantVisionSettingsInput,
  AssistantVisionSettingsSnapshot,
  MemoryClearScope,
  MemoryItemKind
} from '../shared/assistant'
import type { ScreenshotOverlayPayload, ScreenshotSelectionInput } from '../shared/screenshot'
import type { AssistantThemeId } from '../shared/theme'
import type { ManagedAuthStatus, ManagedPortalTarget } from '../shared/managed'
import type {
  AvailablePet,
  CreatePetInput,
  DragMoveResult,
  PetAction,
  PetManifestInput,
  PetSpritesheetSelection,
  PetSettings
} from '../shared/pet'

const attachmentStagedListeners = new Set<(result: AssistantAttachmentDropResult) => void>()
const attachmentErrorListeners = new Set<(message: string) => void>()
const attachmentDragListeners = new Set<
  (state: { dropZone: AssistantAttachmentDropZone | null; active: boolean }) => void
>()

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
  pickPetSpritesheet: (): Promise<PetSpritesheetSelection | null> =>
    ipcRenderer.invoke('pet:pick-spritesheet'),
  loadPetManifest: (petId: string): Promise<PetManifestInput | null> =>
    ipcRenderer.invoke('pet:load-manifest', petId),
  loadPetSpritesheet: (petId: string, spritesheetPath: string): Promise<string | null> =>
    ipcRenderer.invoke('pet:load-spritesheet', petId, spritesheetPath),
  createPet: (input: CreatePetInput): Promise<AvailablePet> => ipcRenderer.invoke('pet:create', input),
  setCurrentPet: (petId: string): Promise<boolean> => ipcRenderer.invoke('pet:set-current', petId),
  deleteUserPet: (petId: string): Promise<boolean> => ipcRenderer.invoke('pet:delete-user', petId),
  openUserPetsDirectory: (): Promise<void> => ipcRenderer.invoke('pet:open-user-pets-dir'),
  setAlwaysOnTop: (value: boolean): Promise<boolean> =>
    ipcRenderer.invoke('pet:set-always-on-top', value),
  setClickThrough: (value: boolean): Promise<boolean> =>
    ipcRenderer.invoke('pet:set-click-through', value),
  setTransparentAreaClickThrough: (value: boolean): Promise<void> =>
    ipcRenderer.invoke('pet:set-transparent-area-click-through', value),
  openAssistant: (): Promise<void> => ipcRenderer.invoke('assistant:open'),
  openAssistantExternalUrl: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:open-external-url', url),
  copyText: (text: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:copy-text', text),
  getScreenshotOverlay: (): Promise<ScreenshotOverlayPayload> =>
    ipcRenderer.invoke('screenshot:get-overlay'),
  confirmScreenshotSelection: (input: ScreenshotSelectionInput): Promise<void> =>
    ipcRenderer.invoke('screenshot:confirm-selection', input),
  cancelScreenshotSelection: (): Promise<void> =>
    ipcRenderer.invoke('screenshot:cancel'),
  getAssistantStatus: (): Promise<AssistantRuntimeStatus> =>
    ipcRenderer.invoke('assistant:get-status'),
  /** 获取脱敏 Managed 登录状态，永远不返回 Token。 */
  getManagedAuthStatus: (): Promise<ManagedAuthStatus> => ipcRenderer.invoke('managed:get-status'),
  /** 登录前匿名刷新服务端 Feature Flag，永远不发送 Access Token。 */
  refreshManagedFeatures: (): Promise<ManagedAuthStatus> => ipcRenderer.invoke('managed:refresh-features'),
  /** 打开 Main 白名单内的官网业务页，不允许 Renderer 传入任意 URL。 */
  openManagedPortal: (target: ManagedPortalTarget): Promise<boolean> =>
    ipcRenderer.invoke('managed:open-portal', target),
  /** 浏览器回到应用后刷新一次脱敏账号与设备摘要，不返回 Token。 */
  refreshManagedPortalStatus: (): Promise<void> => ipcRenderer.invoke('managed:refresh-portal-return'),
  /** 请求 Main 通过系统浏览器开始 PKCE 登录。 */
  loginManaged: (): Promise<ManagedAuthStatus> => ipcRenderer.invoke('managed:login'),
  /** 取消当前 PKCE 登录并关闭 Main loopback 监听器。 */
  cancelManagedLogin: (): Promise<ManagedAuthStatus> => ipcRenderer.invoke('managed:cancel-login'),
  /** 撤销当前桌面会话的 Refresh Token，成功后清理本地会话。 */
  logoutManaged: (): Promise<ManagedAuthStatus> => ipcRenderer.invoke('managed:logout'),
  /** 撤销当前设备及其关联授权，Renderer 不提交设备 ID。 */
  revokeManagedCurrentDevice: (): Promise<ManagedAuthStatus> => ipcRenderer.invoke('managed:revoke-current-device'),
  getAssistantWebSettings: (): Promise<AssistantWebSettingsSnapshot> =>
    ipcRenderer.invoke('assistant:get-web-settings'),
  setAssistantWebSettings: (
    input: AssistantWebSettingsInput
  ): Promise<AssistantWebSettingsSnapshot> => ipcRenderer.invoke('assistant:set-web-settings', input),
  testAssistantWebSearch: (): Promise<number> =>
    ipcRenderer.invoke('assistant:test-web-search'),
  getAssistantDocumentCapabilities: (): Promise<AssistantDocumentCapabilities> =>
    ipcRenderer.invoke('assistant:get-document-capabilities'),
  testAssistantVision: (): Promise<AssistantVisionSnapshot> =>
    ipcRenderer.invoke('assistant:test-vision'),
  getAssistantVisionSettings: (): Promise<AssistantVisionSettingsSnapshot> =>
    ipcRenderer.invoke('assistant:get-vision-settings'),
  setAssistantVisionSettings: (
    input: AssistantVisionSettingsInput
  ): Promise<AssistantVisionSettingsSnapshot> => ipcRenderer.invoke('assistant:set-vision-settings', input),
  getAssistantModelSettings: (): Promise<AssistantModelSettingsSnapshot> =>
    ipcRenderer.invoke('assistant:get-model-settings'),
  getAssistantCapabilitySettings: (): Promise<AssistantCapabilitySettingsSnapshot> =>
    ipcRenderer.invoke('assistant:get-capability-settings'),
  setAssistantModelSettings: (
    input: AssistantModelSettingsInput
  ): Promise<AssistantModelSettingsSnapshot> => ipcRenderer.invoke('assistant:set-model-settings', input),
  getAssistantLayout: (): Promise<AssistantWindowLayout> =>
    ipcRenderer.invoke('assistant:get-layout'),
  setAssistantTheme: (theme: AssistantThemeId): Promise<AssistantThemeId> =>
    ipcRenderer.invoke('assistant:set-theme', theme),
  askAssistant: (request: AssistantAskInput): Promise<AssistantAskResult> =>
    ipcRenderer.invoke('assistant:ask', request),
  pickAssistantAttachments: (): Promise<AssistantAttachmentSummary[]> =>
    ipcRenderer.invoke('assistant:pick-attachments'),
  removeAssistantAttachment: (attachmentId: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:remove-attachment', attachmentId),
  previewAssistantAttachment: (
    input: AssistantAttachmentPreviewInput
  ): Promise<AssistantAttachmentPreview> => ipcRenderer.invoke('assistant:preview-attachment', input),
  previewAssistantArtifact: (
    input: AssistantArtifactPreviewInput
  ): Promise<AssistantArtifactPreview> => ipcRenderer.invoke('assistant:preview-artifact', input),
  saveAssistantArtifact: (
    input: AssistantArtifactAccessInput
  ): Promise<AssistantArtifactSaveResult> => ipcRenderer.invoke('assistant:save-artifact', input),
  deleteAssistantArtifact: (input: AssistantArtifactAccessInput): Promise<boolean> =>
    ipcRenderer.invoke('assistant:delete-artifact', input),
  cancelAssistant: (taskId: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:cancel', taskId),
  resolveAssistantPermission: (input: AssistantPermissionResolution): Promise<boolean> =>
    ipcRenderer.invoke('assistant:resolve-permission', input),
  getAssistantMemory: (): Promise<AssistantMemorySnapshot> =>
    ipcRenderer.invoke('assistant:get-memory'),
  getAssistantConversationMessages: (conversationId: string): Promise<AssistantConversationMessage[]> =>
    ipcRenderer.invoke('assistant:get-conversation-messages', conversationId),
  deleteAssistantMemoryItem: (kind: MemoryItemKind, id: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:delete-memory-item', kind, id),
  clearAssistantMemory: (scope: MemoryClearScope): Promise<void> =>
    ipcRenderer.invoke('assistant:clear-memory', scope),
  resolveAssistantMemoryCandidate: (
    candidateId: number,
    decision: 'confirmed' | 'rejected'
  ): Promise<boolean> => ipcRenderer.invoke('assistant:resolve-memory-candidate', candidateId, decision),
  getAssistantKnowledge: (): Promise<AssistantKnowledgeSnapshot> =>
    ipcRenderer.invoke('assistant:get-knowledge'),
  addAssistantKnowledgeLibrary: (): Promise<AssistantKnowledgeLibrary | null> =>
    ipcRenderer.invoke('assistant:add-knowledge-library'),
  startAssistantKnowledgeIndex: (libraryId: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:start-knowledge-index', libraryId),
  pauseAssistantKnowledgeIndex: (libraryId: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:pause-knowledge-index', libraryId),
  deleteAssistantKnowledgeLibrary: (libraryId: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:delete-knowledge-library', libraryId),
  setAssistantKnowledgeSelection: (libraryIds: string[]): Promise<string[]> =>
    ipcRenderer.invoke('assistant:set-knowledge-selection', libraryIds),
  getAssistantEmbeddingModels: (): Promise<AssistantEmbeddingSnapshot> =>
    ipcRenderer.invoke('assistant:get-embedding-models'),
  downloadAssistantEmbeddingModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('assistant:download-embedding-model', modelId),
  pauseAssistantEmbeddingDownload: (modelId: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:pause-embedding-download', modelId),
  selectAssistantEmbeddingModel: (modelId: string | null): Promise<number> =>
    ipcRenderer.invoke('assistant:select-embedding-model', modelId),
  configureAssistantOnlineEmbedding: (input: AssistantEmbeddingOnlineInput): Promise<number> =>
    ipcRenderer.invoke('assistant:configure-online-embedding', input),
  deleteAssistantEmbeddingModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('assistant:delete-embedding-model', modelId),
  getAssistantSkills: (): Promise<AssistantSkillSnapshot> =>
    ipcRenderer.invoke('assistant:get-skills'),
  refreshAssistantSkills: (): Promise<AssistantSkillSnapshot> =>
    ipcRenderer.invoke('assistant:refresh-skills'),
  previewLocalAssistantSkills: (): Promise<AssistantSkillInstallPreview | null> =>
    ipcRenderer.invoke('assistant:preview-local-skills'),
  previewGithubAssistantSkills: (url: string): Promise<AssistantSkillInstallPreview> =>
    ipcRenderer.invoke('assistant:preview-github-skills', url),
  installAssistantSkills: (previewToken: string, skillIds: string[]): Promise<AssistantSkillSnapshot> =>
    ipcRenderer.invoke('assistant:install-skills', previewToken, skillIds),
  setAssistantSkillEnabled: (skillId: string, enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('assistant:set-skill-enabled', skillId, enabled),
  uninstallAssistantSkill: (skillId: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:uninstall-skill', skillId),
  closeAssistant: (): Promise<void> => ipcRenderer.invoke('assistant:close'),
  acknowledgeAssistantLayout: (revision: number): void =>
    ipcRenderer.send('assistant:layout-applied', revision),
  traceAssistantLayout: (trace: AssistantLayoutTrace): void =>
    ipcRenderer.send('assistant:layout-trace', trace),
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
  },
  onAssistantEvent: (callback: (event: AssistantEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, assistantEvent: AssistantEvent): void => {
      callback(assistantEvent)
    }
    ipcRenderer.on('assistant:event', listener)
    return () => ipcRenderer.removeListener('assistant:event', listener)
  },
  onAssistantStatus: (callback: (status: AssistantRuntimeStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: AssistantRuntimeStatus): void => {
      callback(status)
    }
    ipcRenderer.on('assistant:status', listener)
    return () => ipcRenderer.removeListener('assistant:status', listener)
  },
  /** 订阅 Main 发布的脱敏 Managed 认证状态，不包含任何 Token。 */
  onManagedAuthStatus: (callback: (status: ManagedAuthStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: ManagedAuthStatus): void => {
      callback(status)
    }
    ipcRenderer.on('managed:status-changed', listener)
    return () => ipcRenderer.removeListener('managed:status-changed', listener)
  },
  onAssistantLayout: (callback: (layout: AssistantWindowLayout) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, layout: AssistantWindowLayout): void => {
      callback(layout)
    }
    ipcRenderer.on('assistant:layout', listener)
    return () => ipcRenderer.removeListener('assistant:layout', listener)
  },
  onAssistantTheme: (callback: (theme: AssistantThemeId) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: AssistantThemeId): void => {
      callback(theme)
    }
    ipcRenderer.on('assistant:theme', listener)
    return () => ipcRenderer.removeListener('assistant:theme', listener)
  },
  onAssistantOpenMemory: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('assistant:open-memory', listener)
    return () => ipcRenderer.removeListener('assistant:open-memory', listener)
  },
  onAssistantAttachmentsStaged: (
    callback: (result: AssistantAttachmentDropResult) => void
  ): (() => void) => {
    attachmentStagedListeners.add(callback)
    return () => attachmentStagedListeners.delete(callback)
  },
  onAssistantAttachmentStageError: (callback: (message: string) => void): (() => void) => {
    attachmentErrorListeners.add(callback)
    return () => attachmentErrorListeners.delete(callback)
  },
  onAssistantAttachmentDragState: (
    callback: (state: { dropZone: AssistantAttachmentDropZone | null; active: boolean }) => void
  ): (() => void) => {
    attachmentDragListeners.add(callback)
    return () => attachmentDragListeners.delete(callback)
  }
}

contextBridge.exposeInMainWorld('desktopPet', api)

/** 安装拖拽拦截器；真实路径只直接提交给 Main，不进入页面上下文。 */
function installAttachmentDropHandlers(): void {
  window.addEventListener('dragover', (event) => {
    const dropZone = findAttachmentDropZone(event.target)
    if (!dropZone || !event.dataTransfer?.types.includes('Files')) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    emitAttachmentDragState(dropZone, true)
  })
  window.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null) {
      emitAttachmentDragState(null, false)
    }
  })
  window.addEventListener('drop', (event) => {
    const dropZone = findAttachmentDropZone(event.target)
    if (!dropZone || !event.dataTransfer) {
      return
    }
    event.preventDefault()
    emitAttachmentDragState(null, false)
    const paths = [...event.dataTransfer.files]
      .map((file) => webUtils.getPathForFile(file))
      .filter((path) => path.length > 0)
    if (paths.length === 0) {
      return
    }
    void ipcRenderer
      .invoke('assistant:stage-dropped-files', paths, dropZone)
      .then((result: AssistantAttachmentDropResult) => {
        attachmentStagedListeners.forEach((listener) => listener(result))
      })
      .catch((error: unknown) => {
        const message = normalizeAttachmentStageError(error)
        attachmentErrorListeners.forEach((listener) => listener(message))
      })
  })
}

/** 根据页面声明的投放区解析桌宠或对话区，不读取页面提供的路径。 */
function findAttachmentDropZone(target: EventTarget | null): AssistantAttachmentDropZone | null {
  if (!(target instanceof Element)) {
    return null
  }
  const value = target.closest<HTMLElement>('[data-assistant-drop-zone]')?.dataset.assistantDropZone
  return value === 'pet' || value === 'conversation' ? value : null
}

/** 向 Renderer 广播不含文件路径的拖拽视觉状态。 */
function emitAttachmentDragState(
  dropZone: AssistantAttachmentDropZone | null,
  active: boolean
): void {
  attachmentDragListeners.forEach((listener) => listener({ dropZone, active }))
}

/** 去除 Electron IPC 包装前缀，只向 Renderer 返回 Main 生成的脱敏业务错误。 */
function normalizeAttachmentStageError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const matched = message.match(/^Error invoking remote method '[^']+': (?:TypeError|Error): (.+)$/)
  return matched?.[1] || message || '附件添加失败。'
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', installAttachmentDropHandlers, { once: true })
} else {
  installAttachmentDropHandlers()
}

ipcRenderer.on('assistant:attachments-staged', (_event, result: AssistantAttachmentDropResult) => {
  attachmentStagedListeners.forEach((listener) => listener(result))
})

ipcRenderer.on('assistant:attachment-stage-error', (_event, message: string) => {
  attachmentErrorListeners.forEach((listener) => listener(message))
})

export type DesktopPetApi = typeof api
