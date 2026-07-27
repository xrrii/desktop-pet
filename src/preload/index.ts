import { contextBridge, ipcRenderer } from 'electron'
import type {
  AssistantAskInput,
  AssistantAskResult,
  AssistantConversationMessage,
  AssistantEvent,
  AssistantEmbeddingOnlineInput,
  AssistantEmbeddingSnapshot,
  AssistantLayoutTrace,
  AssistantKnowledgeLibrary,
  AssistantKnowledgeSnapshot,
  AssistantMemorySnapshot,
  AssistantPermissionResolution,
  AssistantRuntimeStatus,
  AssistantSkillInstallPreview,
  AssistantSkillSnapshot,
  AssistantWindowLayout,
  MemoryClearScope,
  MemoryItemKind
} from '../shared/assistant'
import type { AssistantThemeId } from '../shared/theme'
import type {
  AvailablePet,
  DragMoveResult,
  PetAction,
  PetManifestInput,
  PetSettings
} from '../shared/pet'

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
  loadPetManifest: (petId: string): Promise<PetManifestInput | null> =>
    ipcRenderer.invoke('pet:load-manifest', petId),
  loadPetSpritesheet: (petId: string, spritesheetPath: string): Promise<string | null> =>
    ipcRenderer.invoke('pet:load-spritesheet', petId, spritesheetPath),
  setCurrentPet: (petId: string): Promise<boolean> => ipcRenderer.invoke('pet:set-current', petId),
  setAlwaysOnTop: (value: boolean): Promise<boolean> =>
    ipcRenderer.invoke('pet:set-always-on-top', value),
  setClickThrough: (value: boolean): Promise<boolean> =>
    ipcRenderer.invoke('pet:set-click-through', value),
  setTransparentAreaClickThrough: (value: boolean): Promise<void> =>
    ipcRenderer.invoke('pet:set-transparent-area-click-through', value),
  openAssistant: (): Promise<void> => ipcRenderer.invoke('assistant:open'),
  openAssistantExternalUrl: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('assistant:open-external-url', url),
  getAssistantStatus: (): Promise<AssistantRuntimeStatus> =>
    ipcRenderer.invoke('assistant:get-status'),
  getAssistantLayout: (): Promise<AssistantWindowLayout> =>
    ipcRenderer.invoke('assistant:get-layout'),
  setAssistantTheme: (theme: AssistantThemeId): Promise<AssistantThemeId> =>
    ipcRenderer.invoke('assistant:set-theme', theme),
  askAssistant: (request: AssistantAskInput): Promise<AssistantAskResult> =>
    ipcRenderer.invoke('assistant:ask', request),
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
  }
}

contextBridge.exposeInMainWorld('desktopPet', api)

export type DesktopPetApi = typeof api
