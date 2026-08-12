import './styles.css'
import type {
  AssistantAttachmentMessageRef,
  AssistantAttachmentSummary,
  AssistantArtifactSummary,
  AssistantEmbeddingOnlineInput,
  AssistantEmbeddingModelSnapshot,
  AssistantEmbeddingSnapshot,
  AssistantEvent,
  AssistantKnowledgeLibrary,
  AssistantKnowledgeSnapshot,
  AssistantLayoutTracePhase,
  AssistantMemorySnapshot,
  AssistantModelSettingsSnapshot,
  AssistantRuntimeStatus,
  AssistantSkillInstallPreview,
  AssistantSkillSnapshot,
  AssistantSkillSummary,
  AssistantWebProvider,
  AssistantWebSettingsSnapshot,
  AssistantWebSource,
  AssistantVisionSettingsSnapshot,
  AssistantVisionSnapshot,
  AssistantWindowLayout,
  MemoryClearScope,
  MemoryItemKind,
  ToolCall
} from '../../shared/assistant'
import type { AvailablePet, PetSpritesheetSelection } from '../../shared/pet'
import type { AssistantThemeId } from '../../shared/theme'
import {
  getCommandPaletteState,
  type AssistantCommandOption
} from './commandPalette'
import { renderAssistantMarkdownInto } from './markdown'

type PendingEmbeddingAction =
  | { kind: 'download'; modelId: string }
  | { kind: 'switch'; modelId: string | null }
  | { kind: 'configure-online'; input: AssistantEmbeddingOnlineInput }

interface AttachmentPreviewState {
  attachmentId: string
  conversationId: string
  nextOffset: number | null
  loadedCharacters: number
}

interface ArtifactPreviewState {
  artifactId: string
  conversationId: string
  nextOffset: number | null
  loadedCharacters: number
  previewKind: AssistantArtifactSummary['previewKind']
}

const VOLCENGINE_API_KEY_MANAGEMENT_URL = 'https://console.volcengine.com/search-infinity/api-key'
const CONFIGURED_API_KEY_PLACEHOLDER = '••••••••••••'
const EMPTY_API_KEY_PLACEHOLDER = '输入 API Key'

const WEB_PROVIDER_INFO: Record<AssistantWebProvider, {
  label: string
  apiKeyManagementUrl: string | null
}> = {
  volcengine: {
    label: '火山引擎豆包搜索',
    apiKeyManagementUrl: VOLCENGINE_API_KEY_MANAGEMENT_URL
  },
  brave: {
    label: 'Brave Search',
    apiKeyManagementUrl: null
  }
}

export function initializeAssistant(initialTheme: AssistantThemeId = 'quiet'): void {
  const panel = requireElement<HTMLElement>('#assistant-panel')
  const petRoot = requireElement<HTMLElement>('#pet-root')
  const conversation = requireElement<HTMLElement>('#conversation')
  const memoryView = requireElement<HTMLElement>('#memory-view')
  const settingsView = requireElement<HTMLElement>('#settings-view')
  const petManagerView = requireElement<HTMLElement>('#pet-manager-view')
  const knowledgeView = requireElement<HTMLElement>('#knowledge-view')
  const skillView = requireElement<HTMLElement>('#skill-view')
  const webView = requireElement<HTMLElement>('#web-view')
  const webSettingsScroll = requireElement<HTMLElement>('#web-settings-scroll')
  const petManagerScroll = requireElement<HTMLElement>('#pet-manager-scroll')
  const petManagerForm = requireElement<HTMLFormElement>('#pet-manager-form')
  const petManagerList = requireElement<HTMLElement>('#pet-manager-list')
  const petManagerBack = requireElement<HTMLButtonElement>('#pet-manager-back')
  const petManagerOpenDir = requireElement<HTMLButtonElement>('#pet-manager-open-dir')
  const petManagerPickSpritesheet = requireElement<HTMLButtonElement>('#pet-manager-pick-spritesheet')
  const petManagerSpritesheetName = requireElement<HTMLElement>('#pet-manager-spritesheet-name')
  const petManagerCreateStatus = requireElement<HTMLElement>('#pet-manager-create-status')
  const petManagerId = requireElement<HTMLInputElement>('#pet-manager-id')
  const petManagerName = requireElement<HTMLInputElement>('#pet-manager-name')
  const petManagerDescription = requireElement<HTMLInputElement>('#pet-manager-description')
  const skillContent = requireElement<HTMLElement>('#skill-content')
  const skillAddLocal = requireElement<HTMLButtonElement>('#skill-add-local')
  const skillRefresh = requireElement<HTMLButtonElement>('#skill-refresh')
  const skillBack = requireElement<HTMLButtonElement>('#skill-back')
  const skillGithubForm = requireElement<HTMLFormElement>('#skill-github-form')
  const skillGithubUrl = requireElement<HTMLInputElement>('#skill-github-url')
  const skillInstallPanel = requireElement<HTMLElement>('#skill-install-panel')
  const skillInstallTitle = requireElement<HTMLElement>('#skill-install-title')
  const skillInstallCandidates = requireElement<HTMLElement>('#skill-install-candidates')
  const skillInstallCancel = requireElement<HTMLButtonElement>('#skill-install-cancel')
  const skillInstallConfirm = requireElement<HTMLButtonElement>('#skill-install-confirm')
  const knowledgeContent = requireElement<HTMLElement>('#knowledge-content')
  const knowledgeAdd = requireElement<HTMLButtonElement>('#knowledge-add')
  const knowledgeBack = requireElement<HTMLButtonElement>('#knowledge-back')
  const knowledgeDelete = requireElement<HTMLElement>('#knowledge-delete')
  const knowledgeDeleteTitle = requireElement<HTMLElement>('#knowledge-delete-title')
  const knowledgeDeleteCancel = requireElement<HTMLButtonElement>('#knowledge-delete-cancel')
  const knowledgeDeleteConfirm = requireElement<HTMLButtonElement>('#knowledge-delete-confirm')
  const embeddingSelect = requireElement<HTMLSelectElement>('#embedding-select')
  const embeddingAction = requireElement<HTMLButtonElement>('#embedding-action')
  const embeddingDelete = requireElement<HTMLButtonElement>('#embedding-delete')
  const embeddingStatus = requireElement<HTMLElement>('#embedding-status')
  const embeddingProgress = requireElement<HTMLProgressElement>('#embedding-progress')
  const embeddingOnlineForm = requireElement<HTMLFormElement>('#embedding-online-form')
  const embeddingOnlineUrl = requireElement<HTMLInputElement>('#embedding-online-url')
  const embeddingOnlineModel = requireElement<HTMLInputElement>('#embedding-online-model')
  const embeddingOnlineDimensions = requireElement<HTMLInputElement>('#embedding-online-dimensions')
  const embeddingOnlineKey = requireElement<HTMLInputElement>('#embedding-online-key')
  const embeddingOnlineCancel = requireElement<HTMLButtonElement>('#embedding-online-cancel')
  const embeddingConfirm = requireElement<HTMLDialogElement>('#embedding-confirm')
  const embeddingConfirmTitle = requireElement<HTMLElement>('#embedding-confirm-title')
  const embeddingConfirmCancel = requireElement<HTMLButtonElement>('#embedding-confirm-cancel')
  const embeddingConfirmSubmit = requireElement<HTMLButtonElement>('#embedding-confirm-submit')
  const memoryClearOpen = requireElement<HTMLButtonElement>('#memory-clear-open')
  const memoryBackButton = requireElement<HTMLButtonElement>('#memory-back')
  const memoryContent = requireElement<HTMLElement>('#memory-content')
  const memoryClear = requireElement<HTMLElement>('#memory-clear')
  const memoryClearTitle = requireElement<HTMLElement>('#memory-clear-title')
  const memoryClearCancel = requireElement<HTMLButtonElement>('#memory-clear-cancel')
  const memoryClearConfirm = requireElement<HTMLButtonElement>('#memory-clear-confirm')
  const memoryButton = requireElement<HTMLButtonElement>('#memory-button')
  const settingsButton = requireElement<HTMLButtonElement>('#settings-button')
  const knowledgeButton = requireElement<HTMLButtonElement>('#knowledge-button')
  const skillButton = requireElement<HTMLButtonElement>('#skill-button')
  const webButton = requireElement<HTMLButtonElement>('#web-button')
  const webBack = requireElement<HTMLButtonElement>('#web-back')
  const webSettingsForm = requireElement<HTMLFormElement>('#web-settings-form')
  const webEnabled = requireElement<HTMLInputElement>('#web-enabled')
  const webProvider = requireElement<HTMLSelectElement>('#web-provider')
  const webApiKey = requireElement<HTMLInputElement>('#web-api-key')
  const webApiKeyPage = requireElement<HTMLButtonElement>('#web-api-key-page')
  const webConfiguredStatus = requireElement<HTMLElement>('#web-configured-status')
  const webClearKey = requireElement<HTMLButtonElement>('#web-clear-key')
  const webTest = requireElement<HTMLButtonElement>('#web-test')
  const webSave = requireElement<HTMLButtonElement>('#web-save')
  const webTestStatus = requireElement<HTMLElement>('#web-test-status')
  const modelSettingsForm = requireElement<HTMLFormElement>('#model-settings-form')
  const modelBaseUrl = requireElement<HTMLInputElement>('#model-base-url')
  const modelName = requireElement<HTMLInputElement>('#model-name')
  const modelApiKey = requireElement<HTMLInputElement>('#model-api-key')
  const modelClearKey = requireElement<HTMLButtonElement>('#model-clear-key')
  const modelSave = requireElement<HTMLButtonElement>('#model-save')
  const modelConfiguredStatus = requireElement<HTMLElement>('#model-configured-status')
  const modelSaveStatus = requireElement<HTMLElement>('#model-save-status')
  const settingsBack = requireElement<HTMLButtonElement>('#settings-back')
  const settingsOpenPetManager = requireElement<HTMLButtonElement>('#settings-open-pet-manager')
  const settingsOpenWeb = requireElement<HTMLButtonElement>('#settings-open-web')
  const settingsOpenKnowledge = requireElement<HTMLButtonElement>('#settings-open-knowledge')
  const settingsOpenSkill = requireElement<HTMLButtonElement>('#settings-open-skill')
  const webPrivacyNote = requireElement<HTMLElement>('#web-privacy-note')
  const webEnableConfirm = requireElement<HTMLDialogElement>('#web-enable-confirm')
  const webEnableConfirmTitle = requireElement<HTMLElement>('#web-enable-confirm-title')
  const webEnableCancel = requireElement<HTMLButtonElement>('#web-enable-cancel')
  const webEnableSubmit = requireElement<HTMLButtonElement>('#web-enable-submit')
  const visionSettingsForm = requireElement<HTMLFormElement>('#vision-settings-form')
  const visionMode = requireElement<HTMLSelectElement>('#vision-mode')
  const visionCustomFields = requireElement<HTMLElement>('#vision-custom-fields')
  const visionBaseUrl = requireElement<HTMLInputElement>('#vision-base-url')
  const visionModel = requireElement<HTMLInputElement>('#vision-model')
  const visionIndependentCredentials = requireElement<HTMLInputElement>('#vision-independent-credentials')
  const visionApiKeyField = requireElement<HTMLElement>('#vision-api-key-field')
  const visionApiKey = requireElement<HTMLInputElement>('#vision-api-key')
  const visionTest = requireElement<HTMLButtonElement>('#vision-test')
  const visionSave = requireElement<HTMLButtonElement>('#vision-save')
  const visionConfiguredStatus = requireElement<HTMLElement>('#vision-configured-status')
  const visionStatus = requireElement<HTMLElement>('#vision-status')
  const visionTestStatus = requireElement<HTMLElement>('#vision-test-status')
  const activeSkillChip = requireElement<HTMLButtonElement>('#active-skill-chip')
  const composer = requireElement<HTMLFormElement>('#composer')
  const attachmentList = requireElement<HTMLElement>('#attachment-list')
  const attachmentButton = requireElement<HTMLButtonElement>('#attachment-button')
  const attachmentPreview = requireElement<HTMLDialogElement>('#attachment-preview')
  const attachmentPreviewTitle = requireElement<HTMLElement>('#attachment-preview-title')
  const attachmentPreviewMeta = requireElement<HTMLElement>('#attachment-preview-meta')
  const attachmentPreviewContent = requireElement<HTMLElement>('#attachment-preview-content')
  const attachmentPreviewStatus = requireElement<HTMLElement>('#attachment-preview-status')
  const attachmentPreviewClose = requireElement<HTMLButtonElement>('#attachment-preview-close')
  const attachmentPreviewMore = requireElement<HTMLButtonElement>('#attachment-preview-more')
  const artifactPreview = requireElement<HTMLDialogElement>('#artifact-preview')
  const artifactPreviewTitle = requireElement<HTMLElement>('#artifact-preview-title')
  const artifactPreviewMeta = requireElement<HTMLElement>('#artifact-preview-meta')
  const artifactPreviewContent = requireElement<HTMLElement>('#artifact-preview-content')
  const artifactPreviewStatus = requireElement<HTMLElement>('#artifact-preview-status')
  const artifactPreviewClose = requireElement<HTMLButtonElement>('#artifact-preview-close')
  const artifactPreviewMore = requireElement<HTMLButtonElement>('#artifact-preview-more')
  const input = requireElement<HTMLTextAreaElement>('#message-input')
  const sendButton = requireElement<HTMLButtonElement>('#send-button')
  const newConversationButton = requireElement<HTMLButtonElement>('#new-conversation')
  const closeButton = requireElement<HTMLButtonElement>('#close-button')
  const errorBanner = requireElement<HTMLElement>('#error-banner')
  const runtimeStatus = requireElement<HTMLElement>('#runtime-status')
  const runtimeStatusText = requireElement<HTMLElement>('#runtime-status-text')
  const commandMenu = requireElement<HTMLElement>('#command-menu')

  let conversationId: string = crypto.randomUUID()
  let activeTaskId: string | null = null
  let activeAssistantMessage: HTMLElement | null = null
  let activeAssistantMarkdown = ''
  let markdownRenderTimer: number | null = null
  let lastSequence = 0
  let busy = false
  let expanded = false
  let closing = false
  let transparentAreaClickThrough = false
  let latestLayoutRevision = 0
  let selectedCommandIndex = 0
  let memoryMode = false
  let settingsMode = false
  let returnToSettings = false
  let petManagerMode = false
  let knowledgeMode = false
  let skillMode = false
  let webMode = false
  let availablePets: AvailablePet[] = []
  let currentPetId = 'hammer-dude'
  let selectedPetSpritesheet: PetSpritesheetSelection | null = null
  let skillSnapshot: AssistantSkillSnapshot | null = null
  let webSnapshot: AssistantWebSettingsSnapshot | null = null
  let webBusy = false
  let webEnableConfirmed = false
  let visionSettings: AssistantVisionSettingsSnapshot | null = null
  let visionSnapshot: AssistantVisionSnapshot | null = null
  let visionBusy = false
  let modelSettings: AssistantModelSettingsSnapshot | null = null
  let modelBusy = false
  let pendingSkillPreview: AssistantSkillInstallPreview | null = null
  let pendingSkillUninstall: AssistantSkillSummary | null = null
  let selectedSkillId: string | null = null
  let knowledgeSnapshot: AssistantKnowledgeSnapshot | null = null
  let embeddingSnapshot: AssistantEmbeddingSnapshot | null = null
  let embeddingBusy = false
  let pendingEmbeddingAction: PendingEmbeddingAction | null = null
  let knowledgePoll: number | null = null
  let pendingKnowledgeDelete: AssistantKnowledgeLibrary | null = null
  const selectedKnowledgeIds = new Set<string>()
  let memoryTab: 'conversations' | 'memories' | 'toolLogs' = 'conversations'
  let memorySnapshot: AssistantMemorySnapshot | null = null
  let pendingClearScope: MemoryClearScope | null = null
  let pendingDelete: { kind: MemoryItemKind; id: string; title: string } | null = null
  const permissionCards = new Map<string, HTMLElement>()
  let pendingAttachments: AssistantAttachmentSummary[] = []
  let attachmentPreviewState: AttachmentPreviewState | null = null
  let artifactPreviewState: ArtifactPreviewState | null = null
  const artifactCards = new Map<string, HTMLElement>()

  window.desktopPet.onAssistantEvent(handleEvent)
  window.desktopPet.onAssistantStatus(renderRuntimeStatus)
  window.desktopPet.onAssistantLayout(applyLayout)
  window.desktopPet.onAssistantTheme(applyTheme)
  window.desktopPet.onSwitchPet((petId) => {
    currentPetId = petId
    if (petManagerMode) {
      renderPetManagerView()
    }
  })
  window.desktopPet.onAssistantAttachmentsStaged((result) => {
    addPendingAttachments(result.attachments)
  })
  window.desktopPet.onAssistantAttachmentStageError(showError)
  window.desktopPet.onAssistantAttachmentDragState(({ dropZone, active }) => {
    panel.classList.toggle('is-attachment-drop-target', active && dropZone === 'conversation')
    petRoot.classList.toggle('is-attachment-drop-target', active && dropZone === 'pet')
  })
  window.desktopPet.onAssistantOpenMemory(() => {
    if (!busy) {
      if (memoryMode) {
        closeMemoryView()
      } else {
        if (settingsMode) {
          closeSettingsView()
        }
        if (petManagerMode) {
          closePetManagerView()
        }
        if (knowledgeMode) {
          closeKnowledgeView()
        }
        if (skillMode) {
          closeSkillView()
        }
        if (webMode) {
          closeWebView()
        }
        void openMemoryView()
      }
    }
  })
  applyTheme(initialTheme)
  void window.desktopPet.getAssistantLayout().then(applyLayout).catch(showError)

  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    void sendMessage()
  })

  input.addEventListener('keydown', (event) => {
    if (handleCommandKeydown(event)) {
      event.stopPropagation()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  })

  document.addEventListener('keydown', (event) => {
    if (attachmentPreview.open || artifactPreview.open || webEnableConfirm.open) {
      return
    }
    if (event.key === 'Escape' && expanded) {
      closeAssistant()
    }
  })

  document.addEventListener('mousemove', (event) => {
    if (!expanded) {
      setTransparentAreaClickThrough(false)
      return
    }
    const target = event.target instanceof Element ? event.target : null
    const isInteractive = !!target?.closest('#pet-root, #assistant-panel')
    setTransparentAreaClickThrough(!isInteractive)
  })

  input.addEventListener('input', () => {
    resizeInput()
    updateCommandMenu()
  })

  document.addEventListener('mousedown', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest('#composer, #command-menu')) {
      hideCommandMenu()
    }
  })

  conversation.addEventListener('click', handleConversationClick)
  conversation.addEventListener('auxclick', handleConversationClick)

  newConversationButton.addEventListener('click', () => {
    if (busy) {
      return
    }
    void clearPendingAttachments()
    closeAttachmentPreview()
    closeArtifactPreview()
    conversationId = crypto.randomUUID()
    activeTaskId = null
    activeAssistantMessage = null
    resetAssistantMarkdownRendering()
    lastSequence = 0
    conversation.replaceChildren()
    permissionCards.clear()
    artifactCards.clear()
    hideCommandMenu()
    clearError()
    input.focus()
  })

  closeButton.addEventListener('click', closeAssistant)

  attachmentButton.addEventListener('click', () => {
    if (busy) {
      return
    }
    attachmentButton.disabled = true
    void window.desktopPet
      .pickAssistantAttachments()
      .then(addPendingAttachments)
      .catch(showError)
      .finally(() => {
        attachmentButton.disabled = false
      })
  })

  attachmentPreviewClose.addEventListener('click', closeAttachmentPreview)
  attachmentPreviewMore.addEventListener('click', () => void loadNextAttachmentPreviewPage())
  attachmentPreview.addEventListener('close', () => {
    attachmentPreviewState = null
  })
  artifactPreviewClose.addEventListener('click', closeArtifactPreview)
  artifactPreviewMore.addEventListener('click', () => void loadNextArtifactPreviewPage())
  artifactPreview.addEventListener('close', () => {
    artifactPreviewState = null
  })

  memoryButton.addEventListener('click', () => {
    if (!busy) {
      if (memoryMode) {
        closeMemoryView()
      } else {
        if (petManagerMode) {
          closePetManagerView()
        }
        if (settingsMode) {
          closeSettingsView()
        }
        if (knowledgeMode) {
          closeKnowledgeView()
        }
        if (skillMode) {
          closeSkillView()
        }
        if (webMode) {
          closeWebView()
        }
        void openMemoryView()
      }
    }
  })
  knowledgeButton.addEventListener('click', () => {
    if (!busy) {
      if (knowledgeMode) {
        closeKnowledgeView()
      } else {
        if (memoryMode) {
          closeMemoryView()
        }
        if (petManagerMode) {
          closePetManagerView()
        }
        if (skillMode) {
          closeSkillView()
        }
        if (webMode) {
          closeWebView()
        }
        void openKnowledgeView()
      }
    }
  })
  settingsButton.addEventListener('click', () => {
    if (busy) return
    if (settingsMode) {
      closeSettingsView()
      return
    }
    if (memoryMode) closeMemoryView()
    if (petManagerMode) closePetManagerView()
    if (knowledgeMode) closeKnowledgeView()
    if (skillMode) closeSkillView()
    if (webMode) closeWebView()
    void openSettingsView()
  })
  settingsBack.addEventListener('click', closeSettingsView)
  settingsOpenPetManager.addEventListener('click', () => void openSettingsChild(openPetManagerView))
  settingsOpenWeb.addEventListener('click', () => void openSettingsChild(openWebView))
  settingsOpenKnowledge.addEventListener('click', () => void openSettingsChild(openKnowledgeView))
  settingsOpenSkill.addEventListener('click', () => void openSettingsChild(openSkillView))
  petManagerBack.addEventListener('click', closePetManagerView)
  petManagerOpenDir.addEventListener('click', () => void openUserPetsDirectory())
  petManagerPickSpritesheet.addEventListener('click', () => void pickPetSpritesheet())
  petManagerForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void createPet()
  })
  modelSettingsForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void saveModelSettings()
  })
  modelClearKey.addEventListener('click', () => void clearModelKey())
  skillButton.addEventListener('click', () => {
    if (!busy) {
      if (skillMode) {
        closeSkillView()
      } else {
        if (memoryMode) {
          closeMemoryView()
        }
        if (petManagerMode) {
          closePetManagerView()
        }
        if (knowledgeMode) {
          closeKnowledgeView()
        }
        if (webMode) {
          closeWebView()
        }
        void openSkillView()
      }
    }
  })
  webButton.addEventListener('click', () => {
    if (busy) {
      return
    }
    if (webMode) {
      closeWebView()
      return
    }
    if (memoryMode) {
      closeMemoryView()
    }
    if (petManagerMode) {
      closePetManagerView()
    }
    if (knowledgeMode) {
      closeKnowledgeView()
    }
    if (skillMode) {
      closeSkillView()
    }
    void openWebView()
  })
  webBack.addEventListener('click', closeWebView)
  webSettingsForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void saveWebSettings()
  })
  webEnabled.addEventListener('change', () => {
    const provider = selectedWebProvider()
    const active = webSnapshot?.enabled && webSnapshot.provider === provider
    if (webEnabled.checked && !active && !webEnableConfirmed) {
      webEnableConfirm.showModal()
    }
  })
  webProvider.addEventListener('change', () => {
    webApiKey.value = ''
    webTestStatus.textContent = ''
    webEnabled.checked = Boolean(
      webSnapshot?.enabled && webSnapshot.provider === selectedWebProvider()
    )
    webEnableConfirmed = Boolean(
      webSnapshot?.enabled && webSnapshot.provider === selectedWebProvider()
    )
    renderWebProviderDetails()
  })
  webApiKey.addEventListener('input', () => {
    renderWebProviderDetails()
  })
  webApiKeyPage.addEventListener('click', () => void openWebApiKeyManagementPage())
  webEnableCancel.addEventListener('click', cancelWebEnable)
  webEnableSubmit.addEventListener('click', confirmWebEnable)
  webEnableConfirm.addEventListener('cancel', (event) => {
    event.preventDefault()
    cancelWebEnable()
  })
  webClearKey.addEventListener('click', () => void clearWebApiKey())
  webTest.addEventListener('click', () => void testWebSearch())
  visionMode.addEventListener('change', renderVisionFields)
  visionIndependentCredentials.addEventListener('change', renderVisionFields)
  visionApiKey.addEventListener('input', renderVisionFields)
  visionSettingsForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void saveVisionSettings()
  })
  visionTest.addEventListener('click', () => void testVisionCapability())
  skillBack.addEventListener('click', closeSkillView)
  skillRefresh.addEventListener('click', () => void refreshSkills())
  skillAddLocal.addEventListener('click', () => void previewLocalSkills())
  skillGithubForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void previewGithubSkills()
  })
  skillInstallCancel.addEventListener('click', cancelSkillInstall)
  skillInstallConfirm.addEventListener('click', () => void confirmSkillAction())
  activeSkillChip.addEventListener('click', clearSelectedSkill)
  knowledgeBack.addEventListener('click', closeKnowledgeView)
  knowledgeAdd.addEventListener('click', () => void addKnowledgeLibrary())
  knowledgeDeleteCancel.addEventListener('click', cancelKnowledgeDelete)
  knowledgeDeleteConfirm.addEventListener('click', () => void confirmKnowledgeDelete())
  embeddingSelect.addEventListener('change', () => {
    embeddingOnlineForm.hidden = true
    renderEmbeddingPanel()
  })
  embeddingAction.addEventListener('click', () => void requestEmbeddingAction())
  embeddingDelete.addEventListener('click', () => void deleteSelectedEmbeddingModel())
  embeddingConfirmCancel.addEventListener('click', cancelEmbeddingConfirmation)
  embeddingConfirmSubmit.addEventListener('click', () => void confirmEmbeddingAction())
  embeddingConfirm.addEventListener('cancel', (event) => {
    event.preventDefault()
    cancelEmbeddingConfirmation()
  })
  embeddingOnlineCancel.addEventListener('click', () => {
    embeddingOnlineForm.hidden = true
    renderEmbeddingPanel()
  })
  embeddingOnlineForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void saveOnlineEmbedding()
  })
  memoryBackButton.addEventListener('click', closeMemoryView)
  memoryClearOpen.addEventListener('click', beginMemoryClear)
  memoryClearCancel.addEventListener('click', cancelMemoryClear)
  memoryClearConfirm.addEventListener('click', () => void confirmMemoryClear())
  memoryView.querySelectorAll<HTMLButtonElement>('[data-memory-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const tab = button.dataset.memoryTab
      if (tab === 'conversations' || tab === 'memories' || tab === 'toolLogs') {
        memoryTab = tab
        renderMemoryTab()
      }
    })
  })

  void window.desktopPet.getAssistantStatus().then(renderRuntimeStatus).catch(showError)
  void Promise.all([
    window.desktopPet.getAssistantKnowledge(),
    window.desktopPet.getAssistantEmbeddingModels(),
    window.desktopPet.getAssistantSkills(),
    window.desktopPet.getAssistantWebSettings(),
    window.desktopPet.getSettings()
  ]).then(([snapshot, models, skills, webSettings, settings]) => {
    knowledgeSnapshot = snapshot
    embeddingSnapshot = models
    skillSnapshot = skills
    webSnapshot = webSettings
    const existing = new Set(snapshot.libraries.map((library) => library.id))
    currentPetId = settings.petId
    settings.assistantKnowledgeLibraryIds
      .filter((id) => existing.has(id))
      .forEach((id) => selectedKnowledgeIds.add(id))
  }).catch(() => undefined)

  async function sendMessage(): Promise<void> {
    if (!commandMenu.hidden) {
      selectCommand(selectedCommandIndex)
      return
    }
    if (busy) {
      if (!activeTaskId) {
        return
      }
      sendButton.disabled = true
      void window.desktopPet.cancelAssistant(activeTaskId).catch((error) => {
        sendButton.disabled = false
        showError(error)
      })
      return
    }
    const message = input.value.trim()
    if (pendingAttachments.some((item) => item.status !== 'ready')) {
      showError('请先移除解析失败的附件。')
      return
    }
    const readyAttachments = pendingAttachments.filter((item) => item.status === 'ready')
    if (!message && readyAttachments.length === 0) {
      return
    }

    clearError()
    const skillId = selectedSkillId
    addMessage('user', message, readyAttachments)
    resetAssistantMarkdownRendering()
    activeAssistantMessage = addMessage('assistant', '')
    activeAssistantMessage.classList.add('streaming')
    input.value = ''
    resizeInput()
    setBusy(true)
    activeTaskId = null
    lastSequence = 0

    try {
      const result = await window.desktopPet.askAssistant({
        input: message,
        conversationId,
        attachmentIds: readyAttachments.map((item) => item.id),
        ...(skillId ? { skillId } : {})
      })
      activeTaskId ??= result.taskId
      pendingAttachments = pendingAttachments.filter(
        (item) => !readyAttachments.some((sent) => sent.id === item.id)
      )
      renderPendingAttachments()
      clearSelectedSkill()
    } catch (error) {
      if (activeAssistantMessage) {
        resetAssistantMarkdownRendering()
        activeAssistantMessage.textContent = '暂时无法回复。'
        activeAssistantMessage.classList.remove('streaming')
      }
      setBusy(false)
      showError(error)
    }
  }

  /** 打开统一助手配置页，主模型表单与能力入口均只展示脱敏信息。 */
  async function openSettingsView(): Promise<void> {
    clearError()
    try {
      modelSettings = await window.desktopPet.getAssistantModelSettings()
      settingsMode = true
      conversation.hidden = true
      settingsView.hidden = false
      input.disabled = true
      sendButton.disabled = true
      newConversationButton.disabled = true
      settingsButton.setAttribute('aria-pressed', 'true')
      document.body.dataset.assistantMode = 'settings'
      renderModelSettings()
    } catch (error) {
      showError(error)
    }
  }

  /** 从统一配置页进入一个能力子页面，子页面返回时恢复配置页。 */
  async function openSettingsChild(open: () => Promise<void>): Promise<void> {
    if (busy) return
    returnToSettings = true
    settingsMode = false
    settingsView.hidden = true
    settingsButton.setAttribute('aria-pressed', 'false')
    await open()
  }

  /** 关闭统一配置页并恢复聊天输入状态。 */
  function closeSettingsView(): void {
    settingsMode = false
    settingsView.hidden = true
    conversation.hidden = false
    input.disabled = busy
    sendButton.disabled = false
    sendButton.textContent = busy ? '■' : '↑'
    sendButton.title = busy ? '暂停生成' : '发送'
    sendButton.setAttribute('aria-label', busy ? '暂停生成' : '发送')
    newConversationButton.disabled = busy
    settingsButton.setAttribute('aria-pressed', 'false')
    document.body.dataset.assistantMode = 'chat'
    input.focus()
  }

  /** 打开桌宠管理页，统一展示创建表单和当前可用桌宠列表。 */
  async function openPetManagerView(): Promise<void> {
    clearError()
    try {
      await refreshPetManagerSnapshot()
      petManagerMode = true
      conversation.hidden = true
      petManagerView.hidden = false
      input.disabled = true
      sendButton.disabled = true
      newConversationButton.disabled = true
      document.body.dataset.assistantMode = 'pet-manager'
      renderPetManagerForm()
      renderPetManagerView()
      petManagerScroll.scrollTop = 0
    } catch (error) {
      showError(error)
    }
  }

  /** 关闭桌宠管理页，并按需返回统一设置页。 */
  function closePetManagerView(): void {
    const reopenSettings = returnToSettings
    returnToSettings = false
    petManagerMode = false
    petManagerView.hidden = true
    conversation.hidden = false
    input.disabled = busy
    sendButton.disabled = false
    newConversationButton.disabled = busy
    document.body.dataset.assistantMode = 'chat'
    input.focus()
    if (reopenSettings) void openSettingsView()
  }

  /** 使用当前选择结果刷新图集文件名和创建状态，不回填真实文件路径。 */
  function renderPetManagerForm(statusText = '上传现成 sprite sheet'): void {
    petManagerCreateStatus.textContent = statusText
    petManagerSpritesheetName.textContent = selectedPetSpritesheet?.fileName ?? '未选择文件'
  }

  /** 以与现有管理页一致的卡片列表展示当前、内置和用户桌宠。 */
  function renderPetManagerView(): void {
    petManagerList.replaceChildren()
    if (availablePets.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'memory-empty'
      empty.textContent = '还没有可用桌宠。'
      petManagerList.append(empty)
      return
    }

    const current = availablePets.filter((pet) => pet.id === currentPetId)
    const builtin = availablePets.filter((pet) => pet.source === 'builtin' && pet.id !== currentPetId)
    const userPets = availablePets.filter((pet) => pet.source === 'user' && pet.id !== currentPetId)

    appendPetSection('当前桌宠', current)
    appendPetSection('内置桌宠', builtin)
    appendPetSection('用户桌宠', userPets)
  }

  /** 为每个分组写入标题和条目，避免管理页布局偏离现有知识库/记忆页面。 */
  function appendPetSection(title: string, pets: AvailablePet[]): void {
    if (pets.length === 0) {
      return
    }
    const label = document.createElement('p')
    label.className = 'memory-section-label'
    label.textContent = title
    petManagerList.append(label)
    pets.forEach((pet) => {
      petManagerList.append(createPetRow(pet))
    })
  }

  /** 复用现有卡片样式生成桌宠行，只暴露切换和删除两类操作。 */
  function createPetRow(pet: AvailablePet): HTMLElement {
    const row = document.createElement('article')
    row.className = 'memory-row'

    const main = document.createElement('div')
    main.className = 'memory-row-main'
    const title = document.createElement('strong')
    title.textContent = pet.displayName
    const source = document.createElement('span')
    source.className = 'pet-manager-source'
    source.textContent = pet.source === 'user' ? '用户桌宠' : '内置桌宠'
    const description = document.createElement('small')
    description.textContent = pet.id === currentPetId
      ? (pet.description || '当前正在使用')
      : (pet.description || `ID: ${pet.id}`)
    main.append(title, source, description)

    const actions = document.createElement('div')
    actions.className = 'pet-manager-actions'
    const switchButton = document.createElement('button')
    switchButton.type = 'button'
    switchButton.className = pet.id === currentPetId ? 'primary-button' : 'secondary-button'
    switchButton.textContent = pet.id === currentPetId ? '当前' : '切换'
    switchButton.disabled = pet.id === currentPetId
    switchButton.addEventListener('click', () => void switchPet(pet.id))
    actions.append(switchButton)

    if (pet.source === 'user') {
      const removeButton = document.createElement('button')
      removeButton.type = 'button'
      removeButton.className = 'secondary-button'
      removeButton.textContent = '删除'
      removeButton.addEventListener('click', () => void deletePet(pet))
      actions.append(removeButton)
    }

    row.append(main, actions)
    return row
  }

  /** 从 Main 读取最新桌宠列表和当前选择，保持设置页与托盘切换一致。 */
  async function refreshPetManagerSnapshot(): Promise<void> {
    const [pets, settings] = await Promise.all([
      window.desktopPet.listAvailablePets(),
      window.desktopPet.getSettings()
    ])
    availablePets = pets
    currentPetId = settings.petId
  }

  /** 通过 Main 的原生文件选择器挑选图集，Renderer 仅保留一次性 token。 */
  async function pickPetSpritesheet(): Promise<void> {
    petManagerPickSpritesheet.disabled = true
    try {
      const selection = await window.desktopPet.pickPetSpritesheet()
      if (selection) {
        selectedPetSpritesheet = selection
        renderPetManagerForm('图集已选择，创建后会复制到用户桌宠目录')
      }
    } catch (error) {
      showError(error)
    } finally {
      petManagerPickSpritesheet.disabled = false
    }
  }

  /** 创建用户桌宠并立即切换到该角色，成功后刷新管理列表。 */
  async function createPet(): Promise<void> {
    const id = petManagerId.value.trim()
    const displayName = petManagerName.value.trim()
    const description = petManagerDescription.value.trim()
    if (!id) {
      showError('请先填写桌宠 ID。')
      petManagerId.focus()
      return
    }
    if (!displayName) {
      showError('请先填写桌宠名称。')
      petManagerName.focus()
      return
    }
    if (!selectedPetSpritesheet) {
      showError('请先选择 sprite sheet 图集。')
      return
    }

    petManagerPickSpritesheet.disabled = true
    try {
      await window.desktopPet.createPet({
        id,
        displayName,
        description,
        spritesheetToken: selectedPetSpritesheet.token,
        makeCurrent: true
      })
      await refreshPetManagerSnapshot()
      renderPetManagerView()
      resetPetManagerForm()
      renderPetManagerForm('桌宠已创建并切换')
      clearError()
    } catch (error) {
      showError(error)
    } finally {
      petManagerPickSpritesheet.disabled = false
    }
  }

  /** 切换当前桌宠后刷新管理列表，让“当前”状态立即生效。 */
  async function switchPet(petId: string): Promise<void> {
    try {
      await window.desktopPet.setCurrentPet(petId)
      currentPetId = petId
      renderPetManagerView()
      clearError()
    } catch (error) {
      showError(error)
    }
  }

  /** 删除用户桌宠前做一次确认，避免误删手工导入的角色资源。 */
  async function deletePet(pet: AvailablePet): Promise<void> {
    if (!window.confirm(`确认删除“${pet.displayName}”？会移除用户桌宠目录中的 pet.json 和图集文件。`)) {
      return
    }
    try {
      await window.desktopPet.deleteUserPet(pet.id)
      await refreshPetManagerSnapshot()
      renderPetManagerView()
      renderPetManagerForm('用户桌宠已删除')
      clearError()
    } catch (error) {
      showError(error)
    }
  }

  /** 打开用户桌宠目录，方便继续手工检查或替换资源。 */
  async function openUserPetsDirectory(): Promise<void> {
    try {
      await window.desktopPet.openUserPetsDirectory()
      clearError()
    } catch (error) {
      showError(error)
    }
  }

  /** 创建成功后清空表单，避免旧 token 被重复提交。 */
  function resetPetManagerForm(): void {
    petManagerForm.reset()
    selectedPetSpritesheet = null
  }

  /** 打开记忆管理视图，读取数据失败时保留聊天模式并显示错误。 */
  async function openMemoryView(): Promise<void> {
    clearError()
    try {
      memorySnapshot = await window.desktopPet.getAssistantMemory()
      memoryMode = true
      conversation.hidden = true
      memoryView.hidden = false
      input.disabled = true
      sendButton.disabled = true
      newConversationButton.disabled = true
      memoryButton.setAttribute('aria-pressed', 'true')
      document.body.dataset.assistantMode = 'memory'
      renderMemoryTab()
    } catch (error) {
      showError(error)
    }
  }

  function closeMemoryView(): void {
    memoryMode = false
    pendingClearScope = null
    memoryClear.hidden = true
    memoryView.hidden = true
    conversation.hidden = false
    input.disabled = busy
    sendButton.disabled = false
    sendButton.textContent = busy ? '■' : '↑'
    sendButton.title = busy ? '暂停生成' : '发送'
    sendButton.setAttribute('aria-label', busy ? '暂停生成' : '发送')
    newConversationButton.disabled = busy
    memoryButton.setAttribute('aria-pressed', 'false')
    document.body.dataset.assistantMode = 'chat'
    input.focus()
  }

  /** 打开知识库管理并自动选中可用于回答的就绪知识库。 */
  async function openKnowledgeView(): Promise<void> {
    clearError()
    try {
      ;[knowledgeSnapshot, embeddingSnapshot] = await Promise.all([
        window.desktopPet.getAssistantKnowledge(),
        window.desktopPet.getAssistantEmbeddingModels()
      ])
      knowledgeMode = true
      conversation.hidden = true
      knowledgeView.hidden = false
      input.disabled = true
      sendButton.disabled = true
      newConversationButton.disabled = true
      knowledgeButton.setAttribute('aria-pressed', 'true')
      document.body.dataset.assistantMode = 'knowledge'
      renderEmbeddingPanel()
      renderKnowledgeView()
      scheduleKnowledgePoll()
    } catch (error) {
      showError(error)
    }
  }

  function closeKnowledgeView(): void {
    const reopenSettings = returnToSettings
    returnToSettings = false
    knowledgeMode = false
    pendingKnowledgeDelete = null
    pendingEmbeddingAction = null
    embeddingConfirm.close()
    embeddingOnlineForm.hidden = true
    knowledgeDelete.hidden = true
    knowledgeView.hidden = true
    conversation.hidden = false
    input.disabled = busy
    sendButton.disabled = false
    newConversationButton.disabled = busy
    knowledgeButton.setAttribute('aria-pressed', 'false')
    document.body.dataset.assistantMode = 'chat'
    if (knowledgePoll !== null) {
      window.clearTimeout(knowledgePoll)
      knowledgePoll = null
    }
    input.focus()
    if (reopenSettings) void openSettingsView()
  }

  /** 打开 Skill 管理视图，只读取脱敏元数据快照。 */
  async function openSkillView(): Promise<void> {
    clearError()
    try {
      skillSnapshot = await window.desktopPet.getAssistantSkills()
      skillMode = true
      conversation.hidden = true
      skillView.hidden = false
      input.disabled = true
      sendButton.disabled = true
      newConversationButton.disabled = true
      skillButton.setAttribute('aria-pressed', 'true')
      document.body.dataset.assistantMode = 'skill'
      renderSkillView()
    } catch (error) {
      showError(error)
    }
  }

  function closeSkillView(): void {
    const reopenSettings = returnToSettings
    returnToSettings = false
    skillMode = false
    pendingSkillPreview = null
    pendingSkillUninstall = null
    skillInstallPanel.hidden = true
    skillView.hidden = true
    conversation.hidden = false
    input.disabled = busy
    sendButton.disabled = false
    newConversationButton.disabled = busy
    skillButton.setAttribute('aria-pressed', 'false')
    document.body.dataset.assistantMode = 'chat'
    input.focus()
    if (reopenSettings) void openSettingsView()
  }

  /** 打开联网设置，只读取是否启用和是否已配置等脱敏状态。 */
  async function openWebView(): Promise<void> {
    clearError()
    try {
      const [webSettings, currentVisionSettings, documentCapabilities] = await Promise.all([
        window.desktopPet.getAssistantWebSettings(),
        window.desktopPet.getAssistantVisionSettings(),
        window.desktopPet.getAssistantDocumentCapabilities().catch(() => null)
      ])
      webSnapshot = webSettings
      visionSettings = currentVisionSettings
      visionSnapshot = documentCapabilities?.vision ?? null
      webMode = true
      webEnableConfirmed = webSnapshot.enabled
      conversation.hidden = true
      webView.hidden = false
      input.disabled = true
      sendButton.disabled = true
      newConversationButton.disabled = true
      webButton.setAttribute('aria-pressed', 'true')
      document.body.dataset.assistantMode = 'web'
      renderWebSettings()
      renderVisionSettings()
      webSettingsScroll.scrollTop = 0
    } catch (error) {
      showError(error)
    }
  }

  /** 退出联网设置并恢复聊天输入状态。 */
  function closeWebView(): void {
    const reopenSettings = returnToSettings
    returnToSettings = false
    webMode = false
    webEnableConfirmed = false
    if (webEnableConfirm.open) {
      webEnableConfirm.close()
    }
    visionApiKey.value = ''
    visionTestStatus.textContent = ''
    webView.hidden = true
    conversation.hidden = false
    input.disabled = busy
    sendButton.disabled = false
    newConversationButton.disabled = busy
    webButton.setAttribute('aria-pressed', 'false')
    document.body.dataset.assistantMode = 'chat'
    input.focus()
    if (reopenSettings) void openSettingsView()
  }

  /** 根据 Main 返回的脱敏快照恢复主模型表单，不回填 API Key。 */
  function renderModelSettings(): void {
    const snapshot = modelSettings
    modelBaseUrl.value = snapshot?.baseUrl ?? ''
    modelName.value = snapshot?.model ?? 'gpt-4o-mini'
    modelApiKey.value = ''
    modelApiKey.placeholder = snapshot?.configuredKey ? CONFIGURED_API_KEY_PLACEHOLDER : EMPTY_API_KEY_PLACEHOLDER
    modelConfiguredStatus.textContent = snapshot?.configuredKey
      ? `密钥已安全保存（${snapshot.source === 'saved' ? '应用配置' : '环境变量'}）`
      : '尚未配置 API Key，Runtime 将使用模拟后端'
    renderModelBusyState()
  }

  /** 只更新主模型表单的忙碌态，避免保存前重绘并清空用户输入。 */
  function renderModelBusyState(): void {
    modelClearKey.disabled = modelBusy || !modelSettings?.configuredKey
    modelSave.disabled = modelBusy
    modelBaseUrl.disabled = modelBusy
    modelName.disabled = modelBusy
    modelApiKey.disabled = modelBusy
  }

  /** 保存主模型设置；Runtime 重启期间短暂显示启动状态。 */
  async function saveModelSettings(): Promise<void> {
    const baseUrl = modelBaseUrl.value.trim()
    const model = modelName.value.trim()
    const apiKey = modelApiKey.value.trim()
    if (!model) {
      showError('请填写主模型名称。')
      modelName.focus()
      return
    }
    setModelBusy(true)
    try {
      modelSettings = await window.desktopPet.setAssistantModelSettings({
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {})
      })
      modelSaveStatus.textContent = '主模型配置已保存。'
      clearError()
      renderModelSettings()
    } catch (error) {
      showError(error)
    } finally {
      setModelBusy(false)
    }
  }

  /** 删除主模型密钥并回退到模拟后端，删除前要求用户确认。 */
  async function clearModelKey(): Promise<void> {
    if (!modelSettings?.configuredKey || !window.confirm('确认删除已保存的主模型 API Key？')) return
    setModelBusy(true)
    try {
      modelSettings = await window.desktopPet.setAssistantModelSettings({
        baseUrl: modelBaseUrl.value.trim(),
        model: modelName.value.trim() || modelSettings.model,
        clearApiKey: true
      })
      modelSaveStatus.textContent = '主模型 API Key 已删除。'
      clearError()
      renderModelSettings()
    } catch (error) {
      showError(error)
    } finally {
      setModelBusy(false)
    }
  }

  /** 统一锁定主模型配置控件，防止保存期间重复重启 Runtime。 */
  function setModelBusy(value: boolean): void {
    modelBusy = value
    renderModelBusyState()
  }

  /** 根据 Main 返回的脱敏快照渲染设置，不回填 API Key。 */
  function renderWebSettings(): void {
    const snapshot = webSnapshot
    webEnabled.checked = snapshot?.enabled ?? false
    webProvider.value = snapshot?.provider ?? 'volcengine'
    webApiKey.value = ''
    webSave.disabled = webBusy
    webEnabled.disabled = webBusy
    webProvider.disabled = webBusy
    webApiKey.disabled = webBusy
    renderWebProviderDetails()
  }

  /** 根据当前选择更新脱敏密钥状态、隐私文案和外链入口。 */
  function renderWebProviderDetails(): void {
    const provider = selectedWebProvider()
    const info = WEB_PROVIDER_INFO[provider]
    const configured = isWebProviderConfigured(provider)
    webConfiguredStatus.textContent = configured ? '密钥已安全保存' : '尚未配置密钥'
    webApiKey.placeholder = configured
      ? CONFIGURED_API_KEY_PLACEHOLDER
      : EMPTY_API_KEY_PLACEHOLDER
    webClearKey.disabled = webBusy || !configured
    webTest.disabled = webBusy || (!configured && !webApiKey.value.trim())
    webApiKey.setAttribute('aria-label', `${info.label} API Key`)
    webPrivacyNote.textContent = `联网后，搜索关键词会发送给${info.label}；网页正文仅在当前任务期间处理。`
    webEnableConfirmTitle.textContent = `启用后，搜索关键词将发送给${info.label}，选中的公开网页正文会在当前任务期间交给模型处理。`
    webApiKeyPage.hidden = info.apiKeyManagementUrl === null
    webApiKeyPage.title = info.apiKeyManagementUrl
      ? `打开${info.label} API Key 管理页面`
      : ''
  }

  /** 首次启用必须确认第三方查询和当前任务网页处理范围。 */
  function cancelWebEnable(): void {
    webEnableConfirmed = false
    webEnabled.checked = Boolean(
      webSnapshot?.enabled && webSnapshot.provider === selectedWebProvider()
    )
    webEnableConfirm.close()
  }

  function confirmWebEnable(): void {
    webEnableConfirmed = true
    webEnabled.checked = true
    webEnableConfirm.close()
    webApiKey.focus()
  }

  /** 保存联网设置；空白 API Key 会保留 Main 中已有密钥。 */
  async function saveWebSettings(showSuccess = true): Promise<boolean> {
    const provider = selectedWebProvider()
    const active = webSnapshot?.enabled && webSnapshot.provider === provider
    if (webEnabled.checked && !active && !webEnableConfirmed) {
      webEnableConfirm.showModal()
      return false
    }
    const apiKey = webApiKey.value.trim()
    if (webEnabled.checked && !isWebProviderConfigured(provider) && !apiKey) {
      showError(`启用联网搜索前需要填写${WEB_PROVIDER_INFO[provider].label} API Key。`)
      webApiKey.focus()
      return false
    }
    setWebBusy(true)
    try {
      webSnapshot = await window.desktopPet.setAssistantWebSettings({
        enabled: webEnabled.checked,
        provider,
        ...(apiKey ? { apiKey } : {})
      })
      webEnableConfirmed = webSnapshot.enabled && webSnapshot.provider === provider
      renderWebSettings()
      webTestStatus.textContent = showSuccess ? '设置已保存。' : ''
      clearError()
      return true
    } catch (error) {
      showError(error)
      return false
    } finally {
      setWebBusy(false)
    }
  }

  /** 删除加密密钥时同时关闭联网，避免留下不可执行的启用状态。 */
  async function clearWebApiKey(): Promise<void> {
    const provider = selectedWebProvider()
    const providerLabel = WEB_PROVIDER_INFO[provider].label
    if (!isWebProviderConfigured(provider) || !window.confirm(`确认删除已保存的${providerLabel} API Key？`)) {
      return
    }
    setWebBusy(true)
    try {
      webSnapshot = await window.desktopPet.setAssistantWebSettings({
        enabled: false,
        provider,
        clearApiKey: true
      })
      webEnableConfirmed = false
      renderWebSettings()
      webTestStatus.textContent = '密钥已删除，联网搜索已关闭。'
      clearError()
    } catch (error) {
      showError(error)
    } finally {
      setWebBusy(false)
    }
  }

  /** 测试前先保存表单中的新密钥，再由 Main 发起固定查询。 */
  async function testWebSearch(): Promise<void> {
    const provider = selectedWebProvider()
    if (!(await saveWebSettings(false))) {
      return
    }
    if (!isWebProviderConfigured(provider)) {
      showError(`请先保存${WEB_PROVIDER_INFO[provider].label} API Key。`)
      return
    }
    setWebBusy(true)
    webTestStatus.textContent = '正在测试连接…'
    try {
      const count = await window.desktopPet.testAssistantWebSearch()
      webTestStatus.textContent = `连接成功，收到 ${count} 条测试结果。`
      clearError()
    } catch (error) {
      webTestStatus.textContent = '连接测试失败。'
      showError(error)
    } finally {
      setWebBusy(false)
    }
  }

  /** 统一锁定联网设置控件，防止并发保存和测试。 */
  function setWebBusy(value: boolean): void {
    webBusy = value
    webEnabled.disabled = value
    webProvider.disabled = value
    webApiKey.disabled = value
    webClearKey.disabled = value || !isWebProviderConfigured(selectedWebProvider())
    webTest.disabled = value || (
      !isWebProviderConfigured(selectedWebProvider()) && !webApiKey.value.trim()
    )
    webSave.disabled = value
  }

  /** 使用 Main 返回的脱敏快照恢复视觉设置，绝不回填已保存密钥。 */
  function renderVisionSettings(): void {
    const settings = visionSettings
    visionMode.value = settings?.mode ?? 'inherit'
    visionBaseUrl.value = settings?.baseUrl ?? ''
    visionModel.value = settings?.model ?? ''
    visionIndependentCredentials.checked = settings?.independentCredentials ?? false
    visionApiKey.value = ''
    renderVisionFields()
  }

  /** 根据继承模式和独立凭据开关显示最少必要字段及脱敏状态。 */
  function renderVisionFields(): void {
    const custom = visionMode.value === 'custom'
    const independent = custom && visionIndependentCredentials.checked
    visionCustomFields.hidden = !custom
    visionApiKeyField.hidden = !independent
    visionBaseUrl.disabled = visionBusy || !custom
    visionModel.disabled = visionBusy || !custom
    visionIndependentCredentials.disabled = visionBusy || !custom
    visionApiKey.disabled = visionBusy || !independent
    visionMode.disabled = visionBusy
    visionSave.disabled = visionBusy
    visionTest.disabled = visionBusy
    visionApiKey.placeholder = visionSettings?.configuredKey && independent
      ? CONFIGURED_API_KEY_PLACEHOLDER
      : EMPTY_API_KEY_PLACEHOLDER

    const status = visionSnapshot?.status ?? 'untested'
    visionStatus.dataset.status = status
    visionStatus.textContent = visionStatusLabel(status)
    if (!custom) {
      visionConfiguredStatus.textContent = '继承主模型地址、密钥和模型'
    } else if (!independent) {
      visionConfiguredStatus.textContent = '沿用主模型地址或密钥'
    } else {
      visionConfiguredStatus.textContent = visionSettings?.configuredKey
        ? '独立密钥已安全保存'
        : '尚未保存独立密钥'
    }
  }

  /** 保存视觉配置并重启 Runtime，使新配置从未测试状态重新开始。 */
  async function saveVisionSettings(showSuccess = true): Promise<boolean> {
    const mode = visionMode.value === 'custom' ? 'custom' : 'inherit'
    const baseUrl = visionBaseUrl.value.trim()
    const model = visionModel.value.trim()
    const independentCredentials = mode === 'custom' && visionIndependentCredentials.checked
    const apiKey = visionApiKey.value.trim()
    if (mode === 'custom' && !model) {
      showError('单独配置图片理解时必须填写视觉模型名称。')
      visionModel.focus()
      return false
    }
    if (independentCredentials && !visionSettings?.configuredKey && !apiKey) {
      showError('使用独立视觉凭据时必须填写 API Key。')
      visionApiKey.focus()
      return false
    }

    setVisionBusy(true)
    try {
      visionSettings = await window.desktopPet.setAssistantVisionSettings({
        mode,
        ...(mode === 'custom' && baseUrl ? { baseUrl } : {}),
        ...(mode === 'custom' ? { model, independentCredentials } : {}),
        ...(apiKey ? { apiKey } : {})
      })
      visionSnapshot = (await window.desktopPet.getAssistantDocumentCapabilities()).vision
      renderVisionSettings()
      visionTestStatus.textContent = showSuccess ? '配置已保存，请主动探测图片能力。' : ''
      clearError()
      return true
    } catch (error) {
      showError(error)
      return false
    } finally {
      setVisionBusy(false)
    }
  }

  /** 保存表单后用本地随机验证码图片探测，不依据模型名称猜测能力。 */
  async function testVisionCapability(): Promise<void> {
    if (!(await saveVisionSettings(false))) {
      return
    }
    setVisionBusy(true)
    visionTestStatus.textContent = '正在使用本地随机验证码图片主动探测…'
    try {
      visionSnapshot = await window.desktopPet.testAssistantVision()
      renderVisionFields()
      visionTestStatus.textContent = visionProbeResultText(visionSnapshot)
      clearError()
    } catch (error) {
      visionTestStatus.textContent = '主动探测请求失败，未改变为“不支持”。'
      showError(error)
    } finally {
      setVisionBusy(false)
    }
  }

  /** 统一锁定视觉表单，避免配置重启与探测并发。 */
  function setVisionBusy(value: boolean): void {
    visionBusy = value
    renderVisionFields()
  }

  /** 把固定视觉状态转换为紧凑界面标签。 */
  function visionStatusLabel(status: AssistantVisionSnapshot['status']): string {
    return {
      unconfigured: '未配置',
      untested: '未测试',
      supported: '已支持',
      unsupported: '不支持',
      unavailable: '暂不可用',
      'invalid-credentials': '凭据无效'
    }[status]
  }

  /** 区分永久能力结论与临时服务故障，避免误导用户。 */
  function visionProbeResultText(snapshot: AssistantVisionSnapshot): string {
    if (snapshot.status === 'supported') return '主动探测通过，图片附件已启用。'
    if (snapshot.status === 'unsupported') return '端点可用，但当前模型不支持图片输入。'
    if (snapshot.status === 'invalid-credentials') return '视觉模型凭据无效，请更新后重试。'
    if (snapshot.status === 'unavailable') {
      const reason = snapshot.lastError ? attachmentErrorText(snapshot.lastError) : '视觉服务暂时不可用'
      return `${reason}，本次临时故障不会缓存为“不支持”。`
    }
    if (snapshot.status === 'unconfigured') return '视觉模型尚未配置完整。'
    return '视觉配置尚未完成主动探测。'
  }

  function selectedWebProvider(): AssistantWebProvider {
    return webProvider.value === 'brave' ? 'brave' : 'volcengine'
  }

  function isWebProviderConfigured(provider: AssistantWebProvider): boolean {
    const configuredProviders = webSnapshot?.configuredProviders
    if (Array.isArray(configuredProviders)) return configuredProviders.includes(provider)
    return Boolean(webSnapshot?.configured && webSnapshot.provider === provider)
  }

  /** 只打开代码中登记的 Provider 控制台地址，不接受表单传入任意 URL。 */
  async function openWebApiKeyManagementPage(): Promise<void> {
    const url = WEB_PROVIDER_INFO[selectedWebProvider()].apiKeyManagementUrl
    if (!url) return
    try {
      await window.desktopPet.openAssistantExternalUrl(url)
    } catch (error) {
      showError(error)
    }
  }

  /** 渲染 Skill 启停、来源、兼容性和卸载控制。 */
  function renderSkillView(): void {
    skillContent.replaceChildren()
    const skills = skillSnapshot?.skills ?? []
    if (skills.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'memory-empty'
      empty.textContent = '还没有安装技能。'
      skillContent.append(empty)
      return
    }
    skills.forEach((skill) => {
      const row = document.createElement('article')
      row.className = 'memory-row skill-row'
      const toggle = document.createElement('input')
      toggle.type = 'checkbox'
      toggle.className = 'skill-toggle'
      toggle.checked = skill.enabled
      toggle.disabled = skill.compatibility === 'invalid'
      toggle.title = skill.enabled ? '禁用技能' : '启用技能'
      toggle.setAttribute('aria-label', `${toggle.title}${skill.name}`)
      toggle.addEventListener('change', () => void toggleSkill(skill, toggle.checked))

      const main = document.createElement('div')
      main.className = 'memory-row-main'
      const title = document.createElement('strong')
      title.textContent = skill.name
      const detail = document.createElement('span')
      const lastRun = skill.lastRun ? ` · 最近${skillRunStatusLabel(skill.lastRun.status)}` : ''
      detail.textContent = `${skill.sourceDisplay} · ${skillCompatibilityLabel(skill.compatibility)}${lastRun}`
      const description = document.createElement('small')
      description.textContent = skill.lastError || skill.lastRun?.errorMessage || skill.description
      main.append(title, detail, description)

      const actions = document.createElement('div')
      actions.className = 'skill-row-actions'
      if (skill.sourceType === 'github' && skill.sourceUrl) {
        const update = document.createElement('button')
        update.type = 'button'
        update.className = 'icon-button'
        update.textContent = '↻'
        update.title = '检查更新'
        update.setAttribute('aria-label', `检查${skill.name}更新`)
        update.addEventListener('click', () => void previewSkillUpdate(skill))
        actions.append(update)
      }
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'memory-remove icon-button'
      remove.textContent = '×'
      remove.title = '卸载技能'
      remove.setAttribute('aria-label', `卸载${skill.name}`)
      remove.addEventListener('click', () => beginSkillUninstall(skill))
      actions.append(remove)
      row.append(toggle, main, actions)
      skillContent.append(row)
    })
  }

  async function refreshSkills(): Promise<void> {
    skillRefresh.disabled = true
    clearError()
    try {
      skillSnapshot = await window.desktopPet.refreshAssistantSkills()
      renderSkillView()
      updateCommandMenu()
    } catch (error) {
      showError(error)
    } finally {
      skillRefresh.disabled = false
    }
  }

  async function previewLocalSkills(): Promise<void> {
    clearError()
    try {
      const preview = await window.desktopPet.previewLocalAssistantSkills()
      if (preview) {
        showSkillPreview(preview)
      }
    } catch (error) {
      showError(error)
    }
  }

  async function previewGithubSkills(): Promise<void> {
    const url = skillGithubUrl.value.trim()
    if (!url) {
      return
    }
    clearError()
    const submit = skillGithubForm.querySelector<HTMLButtonElement>('button[type="submit"]')
    if (submit) {
      submit.disabled = true
    }
    try {
      showError('正在读取 GitHub 仓库…')
      const preview = await window.desktopPet.previewGithubAssistantSkills(url)
      clearError()
      showSkillPreview(preview)
    } catch (error) {
      showError(error)
    } finally {
      if (submit) {
        submit.disabled = false
      }
    }
  }

  async function previewSkillUpdate(skill: AssistantSkillSummary): Promise<void> {
    if (!skill.sourceUrl) {
      return
    }
    clearError()
    try {
      const preview = await window.desktopPet.previewGithubAssistantSkills(skill.sourceUrl)
      showSkillPreview(preview)
    } catch (error) {
      showError(error)
    }
  }

  function showSkillPreview(preview: AssistantSkillInstallPreview): void {
    pendingSkillPreview = preview
    pendingSkillUninstall = null
    skillInstallTitle.textContent = `选择要从 ${preview.sourceDisplay} 安装的技能`
    skillInstallCandidates.replaceChildren()
    preview.candidates.forEach((candidate) => {
      const label = document.createElement('label')
      label.className = 'skill-install-candidate'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.value = candidate.id
      checkbox.checked = true
      const text = document.createElement('span')
      text.textContent = `${candidate.name} · ${candidate.description}`
      label.append(checkbox, text)
      skillInstallCandidates.append(label)
    })
    skillInstallConfirm.textContent = '安装'
    skillInstallPanel.hidden = false
    skillInstallConfirm.focus()
  }

  function beginSkillUninstall(skill: AssistantSkillSummary): void {
    pendingSkillUninstall = skill
    pendingSkillPreview = null
    skillInstallTitle.textContent = `确认卸载“${skill.name}”？只删除 PetDock 安装副本。`
    skillInstallCandidates.replaceChildren()
    skillInstallConfirm.textContent = '卸载'
    skillInstallPanel.hidden = false
    skillInstallConfirm.focus()
  }

  function cancelSkillInstall(): void {
    pendingSkillPreview = null
    pendingSkillUninstall = null
    skillInstallPanel.hidden = true
  }

  async function confirmSkillAction(): Promise<void> {
    skillInstallConfirm.disabled = true
    try {
      if (pendingSkillUninstall) {
        await window.desktopPet.uninstallAssistantSkill(pendingSkillUninstall.id)
      } else if (pendingSkillPreview) {
        const selected = [...skillInstallCandidates.querySelectorAll<HTMLInputElement>('input:checked')]
          .map((item) => item.value)
        if (selected.length === 0) {
          throw new Error('请至少选择一个技能。')
        }
        skillSnapshot = await window.desktopPet.installAssistantSkills(
          pendingSkillPreview.previewToken,
          selected
        )
      }
      cancelSkillInstall()
      skillSnapshot = await window.desktopPet.getAssistantSkills()
      renderSkillView()
      skillGithubUrl.value = ''
    } catch (error) {
      showError(error)
    } finally {
      skillInstallConfirm.disabled = false
    }
  }

  async function toggleSkill(skill: AssistantSkillSummary, enabled: boolean): Promise<void> {
    try {
      await window.desktopPet.setAssistantSkillEnabled(skill.id, enabled)
      skillSnapshot = await window.desktopPet.getAssistantSkills()
      if (!enabled && selectedSkillId === skill.id) {
        clearSelectedSkill()
      }
      renderSkillView()
    } catch (error) {
      showError(error)
      skillSnapshot = await window.desktopPet.getAssistantSkills().catch(() => skillSnapshot)
      renderSkillView()
    }
  }

  function skillCompatibilityLabel(value: AssistantSkillSummary['compatibility']): string {
    const labels: Record<AssistantSkillSummary['compatibility'], string> = {
      compatible: '可用',
      'instruction-only': '指令可用，脚本禁用',
      'missing-dependencies': '缺少依赖',
      'unsupported-runtime': '运行时不支持',
      invalid: '无效'
    }
    return labels[value]
  }

  function skillRunStatusLabel(value: NonNullable<AssistantSkillSummary['lastRun']>['status']): string {
    const labels: Record<NonNullable<AssistantSkillSummary['lastRun']>['status'], string> = {
      running: '运行中',
      completed: '已完成',
      error: '失败',
      cancelled: '已取消'
    }
    return labels[value]
  }

  /** 渲染知识库进度、聊天范围复选框和索引控制。 */
  function renderKnowledgeView(): void {
    knowledgeContent.replaceChildren()
    const libraries = knowledgeSnapshot?.libraries ?? []
    if (libraries.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'memory-empty'
      empty.textContent = '还没有知识库。'
      knowledgeContent.append(empty)
      return
    }

    libraries.forEach((library) => {
      const row = document.createElement('article')
      row.className = 'knowledge-row'
      row.dataset.status = library.status

      const selector = document.createElement('input')
      selector.type = 'checkbox'
      selector.className = 'knowledge-selector'
      selector.title = '用于对话检索'
      selector.setAttribute('aria-label', `在对话中使用${library.name}`)
      selector.disabled = library.status !== 'ready'
      selector.checked = selector.disabled ? false : selectedKnowledgeIds.has(library.id)
      selector.addEventListener('change', () => {
        if (selector.checked) {
          selectedKnowledgeIds.add(library.id)
        } else {
          selectedKnowledgeIds.delete(library.id)
        }
        void persistKnowledgeSelection()
      })

      const main = document.createElement('div')
      main.className = 'memory-row-main'
      const title = document.createElement('strong')
      title.textContent = library.name
      const status = document.createElement('span')
      status.textContent = knowledgeStatusText(library)
      const path = document.createElement('small')
      path.textContent = library.error || library.displayPath
      main.append(title, status, path)

      if (library.status === 'indexing') {
        const progress = document.createElement('progress')
        progress.max = Math.max(1, library.totalFiles)
        progress.value = Math.min(library.processedFiles, progress.max)
        progress.setAttribute('aria-label', `${library.name}索引进度`)
        main.append(progress)
      }

      const actions = document.createElement('div')
      actions.className = 'knowledge-actions'
      const indexAction = document.createElement('button')
      indexAction.type = 'button'
      indexAction.className = 'icon-button'
      const isIndexing = library.status === 'indexing'
      indexAction.textContent = isIndexing ? 'Ⅱ' : '↻'
      indexAction.title = isIndexing ? '暂停索引' : library.status === 'ready' ? '刷新索引' : '继续索引'
      indexAction.setAttribute('aria-label', `${indexAction.title}${library.name}`)
      indexAction.addEventListener('click', () => void toggleKnowledgeIndex(library))
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'icon-button'
      remove.textContent = '×'
      remove.title = '删除知识库索引'
      remove.setAttribute('aria-label', `删除${library.name}`)
      remove.addEventListener('click', () => beginKnowledgeDelete(library))
      actions.append(indexAction, remove)
      row.append(selector, main, actions)
      knowledgeContent.append(row)
    })
  }

  /** 渲染当前 Provider、本地模型安装进度和安全的在线配置入口。 */
  function renderEmbeddingPanel(): void {
    if (!embeddingSnapshot) {
      return
    }
    const previous = embeddingSelect.value
    const activeValue = embeddingSnapshot.provider === 'local'
      ? `local:${embeddingSnapshot.activeModelId || ''}`
      : embeddingSnapshot.provider
    embeddingSelect.replaceChildren()
    embeddingSelect.append(new Option('Hash Embedding（兼容）', 'hash'))
    embeddingSnapshot.models.forEach((model) => {
      embeddingSelect.append(new Option(model.displayName, `local:${model.id}`))
    })
    embeddingSelect.append(new Option('在线 Embedding API', 'online'))
    const availableValues = new Set([...embeddingSelect.options].map((option) => option.value))
    embeddingSelect.value = availableValues.has(previous) ? previous : activeValue

    const selected = selectedEmbeddingModel()
    embeddingSelect.disabled = embeddingBusy
    embeddingAction.disabled = embeddingBusy
    embeddingDelete.disabled = true
    embeddingProgress.hidden = true
    embeddingStatus.textContent = ''

    if (embeddingSelect.value === 'hash') {
      const active = embeddingSnapshot.provider === 'hash'
      embeddingStatus.textContent = active ? '当前使用 · 零下载兼容模式' : '零下载离线兼容模式'
      setEmbeddingAction(active ? '已使用' : '切换到 Hash', active ? '✓' : '⇄', active)
      return
    }
    if (embeddingSelect.value === 'online') {
      const active = embeddingSnapshot.provider === 'online'
      embeddingStatus.textContent = active && embeddingSnapshot.online
        ? `当前使用 · ${embeddingSnapshot.online.model}`
        : '在线模型会上传问题和知识库片段'
      setEmbeddingAction(active ? '修改在线配置' : '配置在线模型', '⚙', false)
      return
    }
    if (!selected) {
      return
    }
    const active = embeddingSnapshot.provider === 'local' && embeddingSnapshot.activeModelId === selected.id
    const progress = selected.downloadBytes > 0 ? selected.downloadedBytes / selected.downloadBytes : 0
    embeddingStatus.textContent = `${embeddingModelStatus(selected)} · ${formatBytes(selected.downloadBytes)}`
    embeddingDelete.disabled = embeddingBusy || active || selected.status === 'downloading' || selected.status === 'not-installed'
    if (selected.status === 'downloading') {
      embeddingProgress.hidden = false
      embeddingProgress.value = Math.min(1, progress)
      setEmbeddingAction('暂停下载', 'Ⅱ', false)
    } else if (selected.status === 'installed') {
      setEmbeddingAction(active ? '已使用' : '切换模型', active ? '✓' : '⇄', active)
    } else {
      setEmbeddingAction(selected.status === 'paused' ? '继续下载' : '下载模型', '↓', false)
    }
  }

  function setEmbeddingAction(title: string, symbol: string, disabled: boolean): void {
    embeddingAction.title = title
    embeddingAction.setAttribute('aria-label', title)
    embeddingAction.textContent = symbol
    embeddingAction.disabled = embeddingBusy || disabled
  }

  function selectedEmbeddingModel(): AssistantEmbeddingModelSnapshot | null {
    if (!embeddingSelect.value.startsWith('local:')) {
      return null
    }
    const id = embeddingSelect.value.slice('local:'.length)
    return embeddingSnapshot?.models.find((model) => model.id === id) ?? null
  }

  /** 根据当前选择准备下载、暂停、切换或在线配置，但不因下拉选择直接执行。 */
  async function requestEmbeddingAction(): Promise<void> {
    if (embeddingBusy || !embeddingSnapshot) {
      return
    }
    if (embeddingSelect.value === 'online') {
      const online = embeddingSnapshot.online
      embeddingOnlineUrl.value = online?.baseUrl ?? ''
      embeddingOnlineModel.value = online?.model ?? ''
      embeddingOnlineDimensions.value = online ? String(online.dimensions) : ''
      embeddingOnlineKey.value = ''
      embeddingOnlineForm.hidden = false
      embeddingOnlineKey.focus()
      return
    }

    const selected = selectedEmbeddingModel()
    if (selected?.status === 'downloading') {
      await window.desktopPet.pauseAssistantEmbeddingDownload(selected.id)
      await refreshEmbeddingSnapshot()
      return
    }
    if (selected && selected.status !== 'installed') {
      showEmbeddingConfirmation(
        { kind: 'download', modelId: selected.id },
        `确定下载“${selected.displayName}”（${formatBytes(selected.downloadBytes)}）？`,
        '确定下载'
      )
      return
    }
    const displayName = selected?.displayName ?? 'Hash Embedding'
    showEmbeddingConfirmation(
      { kind: 'switch', modelId: selected?.id ?? null },
      `切换模型将重新加载知识库，确定切换为“${displayName}”吗？`,
      '确定切换'
    )
  }

  /** 在线配置填写完成后先确认重载影响，API Key 仍只发送给 Main。 */
  function saveOnlineEmbedding(): void {
    if (embeddingBusy) {
      return
    }
    const input: AssistantEmbeddingOnlineInput = {
      baseUrl: embeddingOnlineUrl.value,
      model: embeddingOnlineModel.value,
      dimensions: Number(embeddingOnlineDimensions.value),
      apiKey: embeddingOnlineKey.value
    }
    showEmbeddingConfirmation(
      { kind: 'configure-online', input },
      '切换模型将重新加载知识库，确定保存并使用该在线模型吗？',
      '确定切换'
    )
  }

  /** 打开模型操作确认框，只有确认按钮会触发 Main IPC。 */
  function showEmbeddingConfirmation(
    action: PendingEmbeddingAction,
    message: string,
    confirmLabel: string
  ): void {
    pendingEmbeddingAction = action
    embeddingConfirmTitle.textContent = message
    embeddingConfirmSubmit.textContent = confirmLabel
    embeddingConfirm.showModal()
    embeddingConfirmSubmit.focus()
  }

  function cancelEmbeddingConfirmation(): void {
    pendingEmbeddingAction = null
    embeddingConfirm.close()
  }

  /** 执行用户已确认的下载或切换，下载完成后不会自动激活模型。 */
  async function confirmEmbeddingAction(): Promise<void> {
    const action = pendingEmbeddingAction
    if (!action || embeddingBusy) {
      return
    }
    pendingEmbeddingAction = null
    embeddingConfirm.close()
    embeddingBusy = true
    renderEmbeddingPanel()
    try {
      if (action.kind === 'download') {
        const download = window.desktopPet.downloadAssistantEmbeddingModel(action.modelId)
        markEmbeddingDownloadStarted(action.modelId)
        embeddingBusy = false
        renderEmbeddingPanel()
        scheduleKnowledgePoll()
        await download
        await refreshEmbeddingSnapshot()
        return
      }
      if (action.kind === 'switch') {
        await window.desktopPet.selectAssistantEmbeddingModel(action.modelId)
      } else {
        await window.desktopPet.configureAssistantOnlineEmbedding(action.input)
        embeddingOnlineKey.value = ''
        embeddingOnlineForm.hidden = true
      }
      await refreshKnowledgeAndEmbedding()
      scheduleKnowledgePoll()
    } catch (error) {
      await refreshEmbeddingSnapshot().catch(() => undefined)
      if (selectedEmbeddingModel()?.status !== 'paused') {
        showError(error)
      }
    } finally {
      embeddingBusy = false
      renderEmbeddingPanel()
    }
  }

  /** 乐观更新下载状态，随后轮询结果仍以 Main 的真实进度为准。 */
  function markEmbeddingDownloadStarted(modelId: string): void {
    if (!embeddingSnapshot) {
      return
    }
    embeddingSnapshot = {
      ...embeddingSnapshot,
      models: embeddingSnapshot.models.map((model) =>
        model.id === modelId ? { ...model, status: 'downloading', error: null } : model
      )
    }
  }

  async function deleteSelectedEmbeddingModel(): Promise<void> {
    const selected = selectedEmbeddingModel()
    if (!selected || embeddingBusy) {
      return
    }
    embeddingBusy = true
    renderEmbeddingPanel()
    try {
      await window.desktopPet.deleteAssistantEmbeddingModel(selected.id)
      await refreshEmbeddingSnapshot()
    } catch (error) {
      showError(error)
    } finally {
      embeddingBusy = false
      renderEmbeddingPanel()
    }
  }

  async function refreshEmbeddingSnapshot(): Promise<void> {
    embeddingSnapshot = await window.desktopPet.getAssistantEmbeddingModels()
    renderEmbeddingPanel()
  }

  async function refreshKnowledgeAndEmbedding(): Promise<void> {
    ;[knowledgeSnapshot, embeddingSnapshot] = await Promise.all([
      window.desktopPet.getAssistantKnowledge(),
      window.desktopPet.getAssistantEmbeddingModels()
    ])
    renderEmbeddingPanel()
    renderKnowledgeView()
  }

  async function addKnowledgeLibrary(): Promise<void> {
    knowledgeAdd.disabled = true
    try {
      const library = await window.desktopPet.addAssistantKnowledgeLibrary()
      if (library) {
        knowledgeSnapshot = await window.desktopPet.getAssistantKnowledge()
        renderKnowledgeView()
        scheduleKnowledgePoll()
      }
    } catch (error) {
      showError(error)
    } finally {
      knowledgeAdd.disabled = false
    }
  }

  async function toggleKnowledgeIndex(library: AssistantKnowledgeLibrary): Promise<void> {
    try {
      if (library.status === 'indexing') {
        await window.desktopPet.pauseAssistantKnowledgeIndex(library.id)
      } else {
        await window.desktopPet.startAssistantKnowledgeIndex(library.id)
      }
      knowledgeSnapshot = await window.desktopPet.getAssistantKnowledge()
      renderKnowledgeView()
      scheduleKnowledgePoll()
    } catch (error) {
      showError(error)
    }
  }

  function beginKnowledgeDelete(library: AssistantKnowledgeLibrary): void {
    pendingKnowledgeDelete = library
    knowledgeDeleteTitle.textContent = `删除“${library.name}”的索引？原文件不会被删除。`
    knowledgeDelete.hidden = false
    knowledgeDeleteConfirm.focus()
  }

  function cancelKnowledgeDelete(): void {
    pendingKnowledgeDelete = null
    knowledgeDelete.hidden = true
  }

  async function confirmKnowledgeDelete(): Promise<void> {
    const library = pendingKnowledgeDelete
    if (!library) {
      return
    }
    knowledgeDeleteConfirm.disabled = true
    try {
      await window.desktopPet.deleteAssistantKnowledgeLibrary(library.id)
      selectedKnowledgeIds.delete(library.id)
      await persistKnowledgeSelection()
      cancelKnowledgeDelete()
      knowledgeSnapshot = await window.desktopPet.getAssistantKnowledge()
      renderKnowledgeView()
    } catch (error) {
      showError(error)
    } finally {
      knowledgeDeleteConfirm.disabled = false
    }
  }

  function scheduleKnowledgePoll(): void {
    const indexing = knowledgeSnapshot?.libraries.some((item) => item.status === 'indexing')
    const downloading = embeddingSnapshot?.models.some((item) => item.status === 'downloading')
    if (!knowledgeMode || (!indexing && !downloading)) {
      return
    }
    if (knowledgePoll !== null) {
      window.clearTimeout(knowledgePoll)
    }
    knowledgePoll = window.setTimeout(async () => {
      knowledgePoll = null
      if (!knowledgeMode) {
        return
      }
      try {
        await refreshKnowledgeAndEmbedding()
      } catch (error) {
        showError(error)
      }
      scheduleKnowledgePoll()
    }, 750)
  }

  async function persistKnowledgeSelection(): Promise<void> {
    try {
      const selected = await window.desktopPet.setAssistantKnowledgeSelection([...selectedKnowledgeIds])
      selectedKnowledgeIds.clear()
      selected.forEach((id) => selectedKnowledgeIds.add(id))
    } catch (error) {
      showError(error)
    }
  }

  function renderMemoryTab(): void {
    if (!memorySnapshot) {
      return
    }
    memoryView.querySelectorAll<HTMLButtonElement>('[data-memory-tab]').forEach((button) => {
      const selected = button.dataset.memoryTab === memoryTab
      button.classList.toggle('is-selected', selected)
      button.setAttribute('aria-selected', String(selected))
    })
    memoryContent.replaceChildren()
    memoryClear.hidden = true
    pendingClearScope = null
    pendingDelete = null
    memoryClearConfirm.textContent = '确认清理'

    if (memoryTab === 'conversations') {
      renderMemoryRows(
        memorySnapshot.conversations,
        (item) => item.title || '未命名会话',
        (item) => `${formatMemoryDate(item.updatedAt)} · ${item.messageCount} 条消息`,
        'conversation',
        (item) => item.id,
        (item) => item.preview || '暂无消息',
        true
      )
      return
    }
    if (memoryTab === 'memories') {
      if (memorySnapshot.candidates.length > 0) {
        renderMemoryCandidates()
      }
      const memoryItems = [
          ...memorySnapshot.memories,
          ...memorySnapshot.apps.map((item) => ({
            id: item.appId,
            value: item.displayName,
            source: `使用 ${item.useCount} 次`,
            updatedAt: item.lastUsedAt,
            kind: 'app' as const
          })),
          ...memorySnapshot.directories.map((item) => ({
            id: item.id,
            value: item.displayPath,
            source: `使用 ${item.useCount} 次`,
            updatedAt: item.lastUsedAt,
            kind: 'directory' as const
          }))
        ]
      if (memoryItems.length > 0) {
        renderMemoryRows(
          memoryItems,
        (item) => 'kind' in item && item.kind === 'app' ? item.value : 'kind' in item && item.kind === 'directory' ? item.value : item.value,
        (item) => 'source' in item ? item.source : '',
        (item) => 'kind' in item && item.kind !== 'preference' ? item.kind : 'memory',
        (item) => String(item.id),
        (item) => 'updatedAt' in item ? formatMemoryDate(item.updatedAt) : '',
        false
        )
      } else if (memorySnapshot.candidates.length === 0) {
        renderMemoryEmpty('这里还没有记录。')
      }
      return
    }

    const logs = memorySnapshot.toolLogs
    if (logs.length === 0) {
      renderMemoryEmpty('还没有工具使用记录。')
      return
    }
    logs.forEach((log) => {
      const row = document.createElement('article')
      row.className = 'memory-row'
      const main = document.createElement('div')
      main.className = 'memory-row-main'
      const title = document.createElement('strong')
      title.textContent = toolLabel(log.toolName)
      const detail = document.createElement('span')
      detail.textContent = `${formatMemoryDate(log.createdAt)} · ${log.ok === true ? '已完成' : log.ok === false ? '未执行' : '等待结果'}`
      main.append(title, detail)
      row.append(main)
      memoryContent.append(row)
    })
  }

  function renderMemoryRows<T>(
    items: T[],
    titleOf: (item: T) => string,
    detailOf: (item: T) => string,
    kind: MemoryItemKind | ((item: T) => MemoryItemKind | null),
    idOf: (item: T) => string,
    previewOf: (item: T) => string,
    clickable: boolean
  ): void {
    if (items.length === 0) {
      renderMemoryEmpty('这里还没有记录。')
      return
    }
    items.forEach((item) => {
      const row = document.createElement('article')
      row.className = 'memory-row'
      if (clickable) {
        row.classList.add('is-clickable')
        row.addEventListener('click', () => {
          const loadedConversation = item as AssistantMemorySnapshot['conversations'][number]
          void selectConversation(loadedConversation.id)
        })
      }
      const main = document.createElement('div')
      main.className = 'memory-row-main'
      const title = document.createElement('strong')
      title.textContent = titleOf(item)
      const detail = document.createElement('span')
      detail.textContent = detailOf(item)
      const preview = document.createElement('small')
      preview.textContent = previewOf(item)
      main.append(title, detail, preview)
      row.append(main)
      const itemKind = typeof kind === 'function' ? kind(item) : kind
      if (itemKind) {
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'memory-remove icon-button'
        remove.title = '删除'
        remove.setAttribute('aria-label', `删除${titleOf(item)}`)
        remove.textContent = '×'
        remove.addEventListener('click', (event) => {
          event.stopPropagation()
          beginMemoryDelete(itemKind, idOf(item), titleOf(item))
        })
        row.append(remove)
      }
      memoryContent.append(row)
    })
  }

  function renderMemoryEmpty(message: string): void {
    const empty = document.createElement('p')
    empty.className = 'memory-empty'
    empty.textContent = message
    memoryContent.append(empty)
  }

  function renderMemoryCandidates(): void {
    const heading = document.createElement('p')
    heading.className = 'memory-section-label'
    heading.textContent = '待确认记忆'
    memoryContent.append(heading)
    memorySnapshot?.candidates.forEach((candidate) => {
      const row = document.createElement('article')
      row.className = 'memory-candidate'
      const content = document.createElement('strong')
      content.textContent = candidate.content
      const reason = document.createElement('span')
      reason.textContent = candidate.reason || `置信度 ${Math.round(candidate.confidence * 100)}%`
      const actions = document.createElement('div')
      actions.className = 'memory-candidate-actions'
      const reject = document.createElement('button')
      reject.type = 'button'
      reject.className = 'secondary-button'
      reject.textContent = '忽略'
      const confirm = document.createElement('button')
      confirm.type = 'button'
      confirm.className = 'primary-button'
      confirm.textContent = '记住'
      reject.addEventListener('click', () => void resolveMemoryCandidate(candidate.id, 'rejected'))
      confirm.addEventListener('click', () => void resolveMemoryCandidate(candidate.id, 'confirmed'))
      actions.append(reject, confirm)
      row.append(content, reason, actions)
      memoryContent.append(row)
    })
  }

  async function resolveMemoryCandidate(
    candidateId: number,
    decision: 'confirmed' | 'rejected'
  ): Promise<void> {
    try {
      await window.desktopPet.resolveAssistantMemoryCandidate(candidateId, decision)
      memorySnapshot = await window.desktopPet.getAssistantMemory()
      renderMemoryTab()
    } catch (error) {
      showError(error)
    }
  }

  async function selectConversation(id: string): Promise<void> {
    await clearPendingAttachments()
    closeAttachmentPreview()
    closeArtifactPreview()
    conversationId = id
    closeMemoryView()
    conversation.replaceChildren()
    artifactCards.clear()
    activeTaskId = null
    activeAssistantMessage = null
    resetAssistantMarkdownRendering()
    lastSequence = 0
    try {
      const messages = await window.desktopPet.getAssistantConversationMessages(id)
      messages.forEach((message) => addMessage(
        message.role,
        message.content,
        message.attachments,
        message.artifacts,
        message.webSources
      ))
    } catch (error) {
      showError(error)
    }
    input.focus()
  }

  async function deleteMemoryItem(kind: MemoryItemKind, id: string): Promise<void> {
    try {
      const deleted = await window.desktopPet.deleteAssistantMemoryItem(kind, id)
      if (deleted && kind === 'conversation' && id === conversationId) {
        conversationId = crypto.randomUUID()
        conversation.replaceChildren()
        artifactCards.clear()
        closeArtifactPreview()
      }
      memorySnapshot = await window.desktopPet.getAssistantMemory()
      renderMemoryTab()
    } catch (error) {
      showError(error)
    }
  }

  function beginMemoryClear(): void {
    pendingDelete = null
    pendingClearScope = memoryTab === 'conversations' ? 'conversations' : memoryTab === 'toolLogs' ? 'tool_logs' : 'memories'
    memoryClearTitle.textContent = '确认清理当前类别？'
    memoryClearConfirm.textContent = '确认清理'
    memoryClear.hidden = false
    memoryClearConfirm.focus()
  }

  function beginMemoryDelete(kind: MemoryItemKind, id: string, title: string): void {
    pendingClearScope = null
    pendingDelete = { kind, id, title }
    memoryClearTitle.textContent = `确认删除“${title}”？`
    memoryClearConfirm.textContent = '确认删除'
    memoryClear.hidden = false
    memoryClearConfirm.focus()
  }

  function cancelMemoryClear(): void {
    pendingClearScope = null
    pendingDelete = null
    memoryClear.hidden = true
  }

  async function confirmMemoryClear(): Promise<void> {
    if (!pendingClearScope && !pendingDelete) {
      return
    }
    memoryClearConfirm.disabled = true
    try {
      if (pendingDelete) {
        const deletion = pendingDelete
        pendingDelete = null
        await deleteMemoryItem(deletion.kind, deletion.id)
      } else if (pendingClearScope) {
        const scope = pendingClearScope
        pendingClearScope = null
        await window.desktopPet.clearAssistantMemory(scope)
      }
      memorySnapshot = await window.desktopPet.getAssistantMemory()
      renderMemoryTab()
    } catch (error) {
      showError(error)
    } finally {
      memoryClearConfirm.disabled = false
    }
  }

  function handleEvent(event: AssistantEvent): void {
    if (!busy) {
      return
    }
    activeTaskId ??= event.taskId
    if (event.taskId !== activeTaskId || event.sequence <= lastSequence) {
      return
    }
    lastSequence = event.sequence

    if (event.type === 'message_delta') {
      if (activeAssistantMessage) {
        if (activeAssistantMessage.dataset.placeholder === 'true') {
          activeAssistantMessage.textContent = ''
          delete activeAssistantMessage.dataset.placeholder
        }
        activeAssistantMarkdown += event.payload.delta
        scheduleAssistantMarkdownRender()
      }
      return
    }

    if (event.type === 'retrieval_sources') {
      renderRetrievalSources(event.payload.sources)
      return
    }

    if (event.type === 'attachment_sources') {
      renderAttachmentSources(event.payload)
      return
    }

    if (event.type === 'web_sources') {
      renderWebSources(event.payload.sources)
      return
    }

    if (event.type === 'artifact_created' || event.type === 'artifact_status') {
      renderArtifactCard(event.payload.artifact)
      return
    }

    if (event.type === 'skill_started') {
      showAssistantPlaceholder(`正在使用：${event.payload.name}`)
      return
    }

    if (event.type === 'skill_completed') {
      if (activeAssistantMessage?.dataset.placeholder === 'true') {
        showAssistantPlaceholder(`技能“${event.payload.name}”执行完成。`)
      }
      return
    }

    if (event.type === 'skill_error') {
      showError(`Skill ${event.payload.skillId}：${event.payload.message}`)
      return
    }

    if (event.type === 'tool_call') {
      showAssistantPlaceholder(`正在处理：${event.payload.preview}`)
      return
    }

    if (event.type === 'permission_required') {
      renderPermissionCard(event.taskId, event.payload)
      return
    }

    if (event.type === 'tool_result') {
      updatePermissionCard(event.payload.toolCallId, event.payload.ok, event.payload.error)
      showAssistantPlaceholder(
        event.payload.ok ? '操作已完成，正在整理回复…' : `操作未执行：${event.payload.error || '未知错误'}`
      )
      return
    }

    if (event.type === 'error') {
      showError(event.payload.message)
      return
    }

    if (event.type === 'done') {
      if (activeAssistantMessage) {
        flushAssistantMarkdownRender()
        if (!activeAssistantMarkdown.trim() && !activeAssistantMessage.textContent) {
          activeAssistantMessage.textContent =
            event.payload.finishReason === 'cancelled' ? '已停止。' : '暂时无法回复。'
        }
        activeAssistantMessage.classList.remove('streaming')
      }
      disablePendingPermissionCards()
      setBusy(false)
      activeTaskId = null
      input.focus()
    }
  }

  /** 展示 Main 生成的确认请求，按钮只提交决策，不回传工具参数。 */
  function renderPermissionCard(taskId: string, call: ToolCall): void {
    if (permissionCards.has(call.id)) {
      return
    }
    const article = document.createElement('article')
    article.className = 'message assistant permission-message'
    article.dataset.toolCallId = call.id

    const card = document.createElement('div')
    card.className = 'permission-card'
    const title = document.createElement('strong')
    title.className = 'permission-title'
    title.textContent = '需要你的确认'
    const preview = document.createElement('p')
    preview.className = 'permission-preview'
    preview.textContent = call.preview
    const status = document.createElement('span')
    status.className = 'permission-status'
    status.textContent = '等待确认'
    const actions = document.createElement('div')
    actions.className = 'permission-actions'
    const denyButton = document.createElement('button')
    denyButton.type = 'button'
    denyButton.className = 'permission-button deny'
    denyButton.textContent = '拒绝'
    const approveButton = document.createElement('button')
    approveButton.type = 'button'
    approveButton.className = 'permission-button approve'
    approveButton.textContent = '允许'
    actions.append(denyButton, approveButton)
    card.append(title, preview, status, actions)
    article.append(card)

    const activeArticle = activeAssistantMessage?.closest('article')
    conversation.insertBefore(article, activeArticle || null)
    permissionCards.set(call.id, article)
    scrollConversation()

    const resolve = async (decision: 'approved' | 'denied'): Promise<void> => {
      denyButton.disabled = true
      approveButton.disabled = true
      status.textContent = decision === 'approved' ? '正在执行' : '正在拒绝'
      try {
        const accepted = await window.desktopPet.resolveAssistantPermission({
          taskId,
          toolCallId: call.id,
          decision
        })
        if (!accepted) {
          status.textContent = '请求已过期'
          article.dataset.state = 'expired'
          return
        }
        status.textContent = decision === 'approved' ? '已允许' : '已拒绝'
        article.dataset.state = decision
      } catch (error) {
        status.textContent = '提交失败'
        denyButton.disabled = false
        approveButton.disabled = false
        showError(error)
      }
    }

    denyButton.addEventListener('click', () => void resolve('denied'))
    approveButton.addEventListener('click', () => void resolve('approved'))
  }

  function updatePermissionCard(toolCallId: string, ok: boolean, error?: string): void {
    const article = permissionCards.get(toolCallId)
    if (!article) {
      return
    }
    const status = article.querySelector<HTMLElement>('.permission-status')
    if (status) {
      status.textContent = ok ? '执行完成' : error || '未执行'
    }
    article.dataset.state = ok ? 'completed' : 'failed'
    article.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.disabled = true
    })
  }

  function disablePendingPermissionCards(): void {
    for (const article of permissionCards.values()) {
      article.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
        button.disabled = true
      })
      if (!article.dataset.state) {
        article.dataset.state = 'expired'
        const status = article.querySelector<HTMLElement>('.permission-status')
        if (status) {
          status.textContent = '请求已结束'
        }
      }
    }
  }

  function showAssistantPlaceholder(content: string): void {
    if (!activeAssistantMessage || activeAssistantMarkdown) {
      return
    }
    clearMarkdownRenderTimer()
    activeAssistantMessage.textContent = content
    activeAssistantMessage.dataset.placeholder = 'true'
    scrollConversation()
  }

  function addMessage(
    role: 'user' | 'assistant',
    content: string,
    attachments: AssistantAttachmentMessageRef[] = [],
    artifacts: AssistantArtifactSummary[] = [],
    webSources: AssistantWebSource[] = []
  ): HTMLElement {
    const article = document.createElement('article')
    article.className = `message ${role}`
    const body = document.createElement('div')
    body.className = 'message-body'
    if (role === 'assistant') {
      renderAssistantMarkdownInto(body, content)
    } else {
      if (content) {
        const text = document.createElement('div')
        text.textContent = content
        body.append(text)
      }
      if (attachments.length > 0) {
        body.append(createMessageAttachmentList(attachments))
      }
    }
    article.append(body)
    artifacts.forEach((artifact) => article.append(createArtifactCard(artifact)))
    if (artifacts.length > 0) {
      article.classList.add('has-artifact')
    }
    if (role === 'assistant' && webSources.length > 0) {
      article.append(createWebSourcesDetails(webSources))
    }
    conversation.append(article)
    scrollConversation()
    return body
  }

  /** 节流渲染正在生成的 Markdown，避免每个字符都触发布局和解析。 */
  function scheduleAssistantMarkdownRender(): void {
    if (markdownRenderTimer !== null) {
      return
    }
    markdownRenderTimer = window.setTimeout(() => {
      markdownRenderTimer = null
      renderActiveAssistantMarkdown()
    }, 48)
  }

  /** 立即提交最后一批流式内容，确保任务结束时 DOM 与原文一致。 */
  function flushAssistantMarkdownRender(): void {
    clearMarkdownRenderTimer()
    renderActiveAssistantMarkdown()
  }

  /** 渲染当前助手原文，并在内容增长后保持对话区跟随。 */
  function renderActiveAssistantMarkdown(): void {
    if (!activeAssistantMessage || !activeAssistantMarkdown) {
      return
    }
    renderAssistantMarkdownInto(activeAssistantMessage, activeAssistantMarkdown)
    scrollConversation()
  }

  /** 清理上一条助手消息的流式渲染状态。 */
  function resetAssistantMarkdownRendering(): void {
    clearMarkdownRenderTimer()
    activeAssistantMarkdown = ''
  }

  /** 取消尚未执行的 Markdown 渲染定时器。 */
  function clearMarkdownRenderTimer(): void {
    if (markdownRenderTimer === null) {
      return
    }
    window.clearTimeout(markdownRenderTimer)
    markdownRenderTimer = null
  }

  /** 通过受控 IPC 打开助手回复中的 HTTP(S) 链接。 */
  function handleConversationClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null
    const copyButton = target?.closest<HTMLButtonElement>('.markdown-code-copy')
    if (copyButton) {
      event.preventDefault()
      void copyCodeBlock(copyButton)
      return
    }
    const anchor = target?.closest<HTMLAnchorElement>('.message.assistant a[href]')
    const url = anchor?.getAttribute('href')
    if (!anchor || !url) {
      return
    }
    event.preventDefault()
    void window.desktopPet.openAssistantExternalUrl(url).catch(showError)
  }

  /** 复制当前代码块并在按钮上展示短暂的操作结果。 */
  async function copyCodeBlock(button: HTMLButtonElement): Promise<void> {
    const code = button.closest('.markdown-code-block')?.querySelector('pre > code')?.textContent
    if (code === undefined || button.disabled) {
      return
    }

    button.disabled = true
    try {
      await window.desktopPet.copyText(code)
      showCopyButtonFeedback(button, '已复制', 'copied')
    } catch (error) {
      showCopyButtonFeedback(button, '复制失败', 'failed')
      showError(error)
    }
  }

  /** 恢复复制按钮的默认状态，避免结果提示永久占用工具栏。 */
  function showCopyButtonFeedback(
    button: HTMLButtonElement,
    label: string,
    state: 'copied' | 'failed'
  ): void {
    button.textContent = label
    button.dataset.state = state
    window.setTimeout(() => {
      if (!button.isConnected) {
        return
      }
      button.textContent = '复制'
      delete button.dataset.state
      button.disabled = false
    }, 1600)
  }

  /** 在当前助手消息下展示 Runtime 返回的可核查来源。 */
  function renderRetrievalSources(sources: Extract<AssistantEvent, { type: 'retrieval_sources' }>['payload']['sources']): void {
    const article = activeAssistantMessage?.closest('article')
    if (!article || sources.length === 0) {
      return
    }
    article.querySelector('.knowledge-sources')?.remove()
    const details = document.createElement('details')
    details.className = 'retrieval-sources knowledge-sources'
    const summary = document.createElement('summary')
    summary.textContent = `参考资料 ${sources.length}`
    details.append(summary)
    sources.forEach((source, index) => {
      const item = document.createElement('div')
      item.className = 'retrieval-source'
      const title = document.createElement('strong')
      title.textContent = `[资料${index + 1}] ${source.title}`
      const path = document.createElement('span')
      path.textContent = `${source.libraryName} / ${source.relativePath}${formatDocumentLocation(source.location)}`
      const excerpt = document.createElement('p')
      excerpt.textContent = source.excerpt
      item.append(title, path, excerpt)
      details.append(item)
    })
    article.append(details)
    scrollConversation()
  }

  /** 展示本轮实际进入模型上下文的附件来源和截断状态。 */
  function renderAttachmentSources(
    payload: Extract<AssistantEvent, { type: 'attachment_sources' }>['payload']
  ): void {
    const article = activeAssistantMessage?.closest('article')
    if (!article || payload.totalAttachments === 0) {
      return
    }
    article.querySelector('.attachment-sources')?.remove()
    const details = document.createElement('details')
    details.className = 'retrieval-sources attachment-sources'
    const summary = document.createElement('summary')
    summary.textContent = payload.mode === 'direct'
      ? `已直接读取附件 ${payload.sources.length}`
      : `附件命中 ${new Set(payload.sources.map((source) => source.attachmentId)).size} / ${payload.totalAttachments}`
    details.append(summary)
    payload.sources.forEach((source) => {
      const item = document.createElement('div')
      item.className = 'retrieval-source attachment-source'
      const title = document.createElement('strong')
      title.textContent = `[附件资料${source.citationIndex}] ${source.name}${source.mode === 'retrieval' ? '（命中片段）' : ''}`
      const location = document.createElement('span')
      location.textContent = formatDocumentLocation(source.location).replace(/^ · /, '')
      location.hidden = !location.textContent
      const excerpt = document.createElement('p')
      excerpt.textContent = source.excerpt || '附件无可展示摘要。'
      item.append(title, location, excerpt)
      details.append(item)
    })
    payload.unmatchedAttachments.forEach((source) => {
      const item = document.createElement('div')
      item.className = 'retrieval-source attachment-source'
      const title = document.createElement('strong')
      title.textContent = `${source.name}（未命中）`
      const reason = document.createElement('p')
      reason.textContent = source.reason
      item.append(title, reason)
      details.append(item)
    })
    payload.warnings.forEach((warning) => {
      const item = document.createElement('div')
      item.className = 'retrieval-source attachment-source'
      const title = document.createElement('strong')
      title.textContent = `${warning.name}（解析警告）`
      const message = document.createElement('p')
      message.textContent = warning.message
      item.append(title, message)
      details.append(item)
    })
    article.append(details)
    scrollConversation()
  }

  /** 展示最终回答实际引用的网页，并标明是否读取过正文。 */
  function renderWebSources(sources: AssistantWebSource[]): void {
    const article = activeAssistantMessage?.closest('article')
    if (!article || sources.length === 0) {
      return
    }
    article.querySelector('.web-sources')?.remove()
    article.append(createWebSourcesDetails(sources))
    scrollConversation()
  }

  /** 创建可用于实时事件和历史恢复的网页来源列表。 */
  function createWebSourcesDetails(sources: AssistantWebSource[]): HTMLElement {
    const details = document.createElement('details')
    details.className = 'retrieval-sources web-sources'
    const summary = document.createElement('summary')
    summary.textContent = `网页来源 ${sources.length}`
    details.append(summary)
    sources.forEach((source) => {
      const item = document.createElement('div')
      item.className = 'retrieval-source web-source'
      const title = document.createElement('a')
      title.className = 'web-source-link'
      title.href = source.url
      title.textContent = `[网页${source.citationIndex}] ${source.title}`
      title.title = source.url
      const meta = document.createElement('span')
      meta.className = 'web-source-meta'
      const kind = source.kind === 'fetched-page' ? '已读取正文' : '搜索摘要'
      meta.textContent = `${source.domain} · ${kind}${source.publishedAt ? ` · ${source.publishedAt}` : ''}`
      const excerpt = document.createElement('p')
      excerpt.textContent = source.excerpt || '没有可展示的摘要。'
      item.append(title, meta, excerpt)
      details.append(item)
    })
    return details
  }

  /** 将实时 Artifact 事件挂到当前助手消息，并按 ID 更新已有状态。 */
  function renderArtifactCard(artifact: AssistantArtifactSummary): void {
    const existing = artifactCards.get(artifact.id)
    if (existing) {
      existing.replaceWith(createArtifactCard(artifact))
      return
    }
    const article = activeAssistantMessage?.closest<HTMLElement>('article')
    if (!article) {
      return
    }
    article.classList.add('has-artifact')
    article.append(createArtifactCard(artifact))
    scrollConversation()
  }

  /** 创建包含预览、另存、重试和删除操作的稳定 Artifact 卡片。 */
  function createArtifactCard(artifact: AssistantArtifactSummary): HTMLElement {
    const card = document.createElement('section')
    card.className = 'artifact-card'
    card.dataset.artifactId = artifact.id
    card.dataset.status = artifact.status
    const header = document.createElement('div')
    header.className = 'artifact-card-header'
    const icon = document.createElement('span')
    icon.className = 'artifact-file-icon'
    icon.textContent = artifact.name.split('.').pop()?.slice(0, 4) || 'FILE'
    const title = document.createElement('div')
    title.className = 'artifact-card-title'
    const name = document.createElement('strong')
    name.textContent = artifact.name
    name.title = artifact.name
    const meta = document.createElement('small')
    meta.textContent = `${formatAttachmentSize(artifact.sizeBytes)} · ${artifact.detectedMime}`
    title.append(name, meta)
    header.append(icon, title)
    const status = document.createElement('span')
    status.className = 'artifact-card-status'
    status.textContent = artifactStatusText(artifact)
    const actions = document.createElement('div')
    actions.className = 'artifact-card-actions'

    if (artifact.status === 'ready') {
      const preview = createArtifactAction('预览', `预览 ${artifact.name}`)
      preview.addEventListener('click', () => void openArtifactPreview(artifact))
      const save = createArtifactAction(artifact.saved ? '再次保存' : '保存', `保存 ${artifact.name}`)
      save.addEventListener('click', () => void saveArtifact(artifact, status, save))
      actions.append(preview, save)
    } else if (artifact.status === 'error') {
      const retry = createArtifactAction('重新生成', `重新生成 ${artifact.name}`)
      retry.addEventListener('click', () => void retryArtifact(artifact))
      actions.append(retry)
    }

    const remove = createArtifactAction('删除', `删除 ${artifact.name}`)
    remove.addEventListener('click', () => void deleteArtifact(artifact, card))
    actions.append(remove)
    card.append(header, status, actions)
    artifactCards.set(artifact.id, card)
    return card
  }

  /** 创建 Artifact 文本命令按钮并设置可访问名称。 */
  function createArtifactAction(label: string, title: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'secondary-button'
    button.textContent = label
    button.title = title
    button.setAttribute('aria-label', title)
    return button
  }

  /** 调用 Main 原生保存流程，取消或失败时保留应用内 Artifact 供重试。 */
  async function saveArtifact(
    artifact: AssistantArtifactSummary,
    status: HTMLElement,
    button: HTMLButtonElement
  ): Promise<void> {
    button.disabled = true
    status.textContent = '正在打开保存位置...'
    try {
      const result = await window.desktopPet.saveAssistantArtifact({
        artifactId: artifact.id,
        conversationId: artifact.conversationId
      })
      if (result.status === 'saved') {
        renderArtifactCard(result.artifact)
      } else if (result.status === 'cancelled') {
        status.textContent = '已取消保存，应用内文件仍然保留'
      } else {
        status.textContent = '保存失败，可以重试'
        showError(result.error || '文件保存失败。')
      }
    } catch (error) {
      status.textContent = '保存失败，可以重试'
      showError(error)
    } finally {
      button.disabled = false
    }
  }

  /** 删除应用内 Artifact，已另存到外部的副本不受影响。 */
  async function deleteArtifact(artifact: AssistantArtifactSummary, card: HTMLElement): Promise<void> {
    if (!window.confirm(`删除应用内生成文件“${artifact.name}”？`)) {
      return
    }
    try {
      const deleted = await window.desktopPet.deleteAssistantArtifact({
        artifactId: artifact.id,
        conversationId: artifact.conversationId
      })
      if (!deleted) {
        showError('生成文件不存在或已经被删除。')
        return
      }
      if (artifactPreviewState?.artifactId === artifact.id) {
        closeArtifactPreview()
      }
      artifactCards.delete(artifact.id)
      card.remove()
    } catch (error) {
      showError(error)
    }
  }

  /** 以一条明确用户消息要求模型修正上次失败的 Artifact 参数。 */
  async function retryArtifact(artifact: AssistantArtifactSummary): Promise<void> {
    if (busy) {
      showError('请等待当前回复完成后再重试。')
      return
    }
    input.value = `请修正参数并重新生成刚才失败的文件“${artifact.name}”。`
    resizeInput()
    await sendMessage()
  }

  /** 打开 Artifact 预览并加载第一页；完整内容仍由 Runtime 按 ID 返回。 */
  async function openArtifactPreview(artifact: AssistantArtifactSummary): Promise<void> {
    artifactPreviewState = {
      artifactId: artifact.id,
      conversationId: artifact.conversationId,
      nextOffset: 0,
      loadedCharacters: 0,
      previewKind: artifact.previewKind
    }
    artifactPreviewTitle.textContent = artifact.name
    artifactPreviewMeta.textContent = `${formatAttachmentSize(artifact.sizeBytes)} · ${artifact.detectedMime}`
    artifactPreviewContent.replaceChildren()
    artifactPreviewStatus.textContent = '正在加载...'
    artifactPreviewMore.hidden = true
    if (!artifactPreview.open) {
      artifactPreview.showModal()
    }
    await loadNextArtifactPreviewPage()
  }

  /** 分页加载文本 Artifact；表格只渲染前 50 行、每行前 12 列。 */
  async function loadNextArtifactPreviewPage(): Promise<void> {
    const state = artifactPreviewState
    if (!state || state.nextOffset === null) {
      return
    }
    const requestedOffset = state.nextOffset
    artifactPreviewMore.disabled = true
    artifactPreviewStatus.textContent = requestedOffset === 0 ? '正在加载...' : '正在加载更多...'
    try {
      const preview = await window.desktopPet.previewAssistantArtifact({
        artifactId: state.artifactId,
        conversationId: state.conversationId,
        offset: requestedOffset
      })
      if (artifactPreviewState !== state || !artifactPreview.open) {
        return
      }
      if (preview.status === 'error') {
        artifactPreviewContent.textContent = artifactErrorText(preview.error)
        artifactPreviewStatus.textContent = '无法预览'
        state.nextOffset = null
        return
      }
      if (state.previewKind === 'table') {
        renderArtifactTable(preview.content, preview.detectedMime)
        state.nextOffset = null
        artifactPreviewMore.hidden = true
        artifactPreviewStatus.textContent = '最多展示前 50 行、每行前 12 列'
        return
      }
      let content = artifactPreviewContent.querySelector('pre')
      if (!content) {
        content = document.createElement('pre')
        artifactPreviewContent.append(content)
      }
      content.textContent = requestedOffset === 0
        ? preview.content || '文件没有可预览文本。'
        : `${content.textContent || ''}${preview.content}`
      state.nextOffset = preview.nextOffset
      state.loadedCharacters = preview.nextOffset ?? preview.totalCharacters
      artifactPreviewStatus.textContent = preview.truncated
        ? `已加载 ${state.loadedCharacters} / ${preview.totalCharacters} 字符`
        : `共 ${preview.totalCharacters} 字符`
      artifactPreviewMore.hidden = !preview.truncated
    } catch (error) {
      if (artifactPreviewState === state) {
        artifactPreviewStatus.textContent = '预览加载失败'
        artifactPreviewContent.textContent = error instanceof Error ? error.message : String(error)
        artifactPreviewMore.hidden = true
      }
    } finally {
      artifactPreviewMore.disabled = false
    }
  }

  /** 解析 CSV/TSV 的有限预览，支持引号包裹和双引号转义。 */
  function renderArtifactTable(content: string, mime: string): void {
    const delimiter = mime === 'text/tab-separated-values' ? '\t' : ','
    const rows = parseDelimitedRows(content, delimiter, 50, 12)
    const scroll = document.createElement('div')
    scroll.className = 'artifact-table-scroll'
    const table = document.createElement('table')
    const body = document.createElement('tbody')
    rows.forEach((row) => {
      const tr = document.createElement('tr')
      row.forEach((value) => {
        const td = document.createElement('td')
        td.textContent = value
        td.title = value
        tr.append(td)
      })
      body.append(tr)
    })
    table.append(body)
    scroll.append(table)
    artifactPreviewContent.replaceChildren(scroll)
  }

  /** 在限定行列内解析分隔文本，避免超大表格撑开窗口。 */
  function parseDelimitedRows(
    content: string,
    delimiter: string,
    maxRows: number,
    maxColumns: number
  ): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let quoted = false
    for (let index = 0; index < content.length && rows.length < maxRows; index += 1) {
      const character = content[index]
      if (character === '"') {
        if (quoted && content[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = !quoted
        }
      } else if (!quoted && character === delimiter) {
        if (row.length < maxColumns) row.push(field)
        field = ''
      } else if (!quoted && (character === '\n' || character === '\r')) {
        if (character === '\r' && content[index + 1] === '\n') index += 1
        if (row.length < maxColumns) row.push(field)
        rows.push(row)
        row = []
        field = ''
      } else {
        field += character
      }
    }
    if (rows.length < maxRows && (field || row.length > 0)) {
      if (row.length < maxColumns) row.push(field)
      rows.push(row)
    }
    return rows
  }

  /** 关闭 Artifact 预览并丢弃分页状态。 */
  function closeArtifactPreview(): void {
    artifactPreviewState = null
    if (artifactPreview.open) {
      artifactPreview.close()
    }
  }

  /** 将 Artifact 内部状态映射为卡片短文案。 */
  function artifactStatusText(artifact: AssistantArtifactSummary): string {
    if (artifact.status === 'error') {
      return `生成失败：${artifactErrorText(artifact.error)}`
    }
    if (artifact.saved) {
      return '已另存，应用内文件仍然保留'
    }
    return artifact.status === 'generating' ? '正在生成...' : '已生成，尚未另存'
  }

  /** 将 Runtime Artifact 错误码转换为用户可理解的中文。 */
  function artifactErrorText(error: string | null): string {
    const messages: Record<string, string> = {
      artifact_format_unsupported: '不支持该输出格式',
      artifact_too_large: '文件超过 25 MB 上限',
      artifact_content_invalid: '文件内容无效',
      artifact_write_failed: '应用内文件写入失败'
    }
    return messages[error || ''] || '生成文件不可用'
  }

  /** 合并新暂存附件并限制当前草稿最多十个，多余项立即回收。 */
  function addPendingAttachments(attachments: AssistantAttachmentSummary[]): void {
    clearError()
    const existingIds = new Set(pendingAttachments.map((item) => item.id))
    const unique = attachments.filter((item) => !existingIds.has(item.id))
    const accepted = unique.slice(0, Math.max(0, 10 - pendingAttachments.length))
    const rejected = unique.slice(accepted.length)
    pendingAttachments.push(...accepted)
    renderPendingAttachments()
    rejected.forEach((item) => {
      void window.desktopPet.removeAssistantAttachment(item.id).catch(() => undefined)
    })
    if (rejected.length > 0) {
      showError('每轮最多添加 10 个附件。')
    }
    if (accepted.some((item) => item.status === 'error')) {
      showError('部分附件不是有效的 UTF-8 文本，发送前请移除。')
    }
    if (accepted.length > 0) {
      input.focus()
    }
  }

  /** 渲染待发送附件及解析状态，文件名过长时由 CSS 省略。 */
  function renderPendingAttachments(): void {
    attachmentList.replaceChildren()
    pendingAttachments.forEach((attachment) => {
      const chip = document.createElement('div')
      chip.className = 'attachment-chip'
      chip.dataset.status = attachment.status
      chip.title = attachment.error
        ? `${attachment.name}：${attachmentErrorText(attachment.error)}`
        : attachment.name
      const name = document.createElement('button')
      name.type = 'button'
      name.className = 'attachment-chip-name attachment-preview-button'
      name.title = `预览 ${attachment.name}`
      name.textContent = attachment.name
      name.addEventListener('click', () => void openAttachmentPreview(attachment.id, conversationId))
      const size = document.createElement('small')
      size.textContent = attachment.status === 'error'
        ? '解析失败'
        : formatAttachmentSize(attachment.sizeBytes)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'attachment-remove'
      remove.title = '移除附件'
      remove.setAttribute('aria-label', `移除附件 ${attachment.name}`)
      remove.textContent = '×'
      remove.disabled = busy
      remove.addEventListener('click', () => void removePendingAttachment(attachment.id))
      chip.append(name, size, remove)
      attachmentList.append(chip)
    })
    attachmentList.hidden = pendingAttachments.length === 0
  }

  /** 删除单个未发送草稿，Runtime 拒绝删除已绑定历史附件。 */
  async function removePendingAttachment(attachmentId: string): Promise<void> {
    try {
      await window.desktopPet.removeAssistantAttachment(attachmentId)
      pendingAttachments = pendingAttachments.filter((item) => item.id !== attachmentId)
      renderPendingAttachments()
    } catch (error) {
      showError(error)
    }
  }

  /** 回收当前对话框内全部未发送附件。 */
  async function clearPendingAttachments(): Promise<void> {
    const drafts = pendingAttachments
    pendingAttachments = []
    renderPendingAttachments()
    await Promise.allSettled(
      drafts.map((item) => window.desktopPet.removeAssistantAttachment(item.id))
    )
  }

  /** 创建历史用户消息中的只读附件标签。 */
  function createMessageAttachmentList(attachments: AssistantAttachmentMessageRef[]): HTMLElement {
    const list = document.createElement('div')
    list.className = 'message-attachments'
    attachments.forEach((attachment) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'message-attachment attachment-preview-button'
      item.title = `预览 ${attachment.name}`
      item.textContent = `${attachment.name} · ${formatAttachmentSize(attachment.sizeBytes)}`
      item.addEventListener('click', () => void openAttachmentPreview(attachment.id, conversationId))
      list.append(item)
    })
    return list
  }

  /** 把字节数格式化为附件标签使用的短文本。 */
  function formatAttachmentSize(sizeBytes: number): string {
    if (sizeBytes < 1024) {
      return `${sizeBytes} B`
    }
    if (sizeBytes < 1024 * 1024) {
      return `${Math.ceil(sizeBytes / 1024)} KB`
    }
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
  }

  /** 把 Runtime 内部解析码转换为用户可理解的错误。 */
  function attachmentErrorText(error: string): string {
    const messages: Record<string, string> = {
      attachment_decode_failed: '文件不是有效的 UTF-8 文本',
      document_corrupt: '文档已损坏或格式不完整',
      document_encrypted: '文档已加密，暂不支持读取',
      document_archive_limit_exceeded: '文档解压后超过安全限制',
      document_archive_unsafe: '文档压缩结构不安全',
      document_xml_unsafe: '文档包含不安全的 XML 内容',
      document_active_content: '文档包含脚本或主动内容',
      document_ocr_required: 'PDF 没有文本层，需要 OCR',
      image_decode_failed: '图片无法安全解码',
      image_too_large: '图片像素、帧数或派生图大小超限',
      vision_not_configured: '尚未配置视觉模型',
      vision_capability_untested: '视觉模型尚未通过能力测试',
      vision_model_unsupported: '当前模型不支持图片理解',
      vision_invalid_credentials: '视觉模型凭据无效',
      vision_provider_unavailable: '视觉服务暂时不可用',
      vision_provider_timeout: '视觉服务响应超时',
      vision_rate_limited: '视觉服务请求过于频繁',
      vision_summary_failed: '图片摘要生成失败'
    }
    return messages[error] || error
  }

  /** 把结构位置转换为简短来源标签。 */
  function formatDocumentLocation(location: import('../../shared/assistant').AssistantDocumentLocation | null | undefined): string {
    if (!location) return ''
    if (location.page) return ` · 第 ${location.page} 页`
    if (location.sheet) return ` · ${location.sheet}${location.cellRange ? `!${location.cellRange}` : ''}`
    if (location.slide) return ` · 幻灯片 ${location.slide}`
    if (location.headingPath?.length > 0) return ` · ${location.headingPath.join(' / ')}${location.paragraph ? ` / 段落 ${location.paragraph}` : ''}`
    if (location.paragraph) return ` · 段落 ${location.paragraph}`
    if (location.lineStart) return ` · 第 ${location.lineStart}-${location.lineEnd || location.lineStart} 行`
    if (location.block) return ` · 块 ${location.block}`
    return location.value ? ` · ${location.value}` : ''
  }

  /** 打开附件预览并加载第一页，真实路径和完整数据库记录不会进入 Renderer。 */
  async function openAttachmentPreview(
    attachmentId: string,
    ownerConversationId: string
  ): Promise<void> {
    attachmentPreviewState = {
      attachmentId,
      conversationId: ownerConversationId,
      nextOffset: 0,
      loadedCharacters: 0
    }
    attachmentPreviewTitle.textContent = '附件预览'
    attachmentPreviewMeta.textContent = ''
    attachmentPreviewContent.textContent = ''
    attachmentPreviewStatus.textContent = '正在加载...'
    attachmentPreviewMore.hidden = true
    if (!attachmentPreview.open) {
      attachmentPreview.showModal()
    }
    await loadNextAttachmentPreviewPage()
  }

  /** 按 Runtime 返回的字符偏移继续追加文本，避免一次把大文件放入页面。 */
  async function loadNextAttachmentPreviewPage(): Promise<void> {
    const state = attachmentPreviewState
    if (!state || state.nextOffset === null) {
      return
    }
    const requestedOffset = state.nextOffset
    attachmentPreviewMore.disabled = true
    attachmentPreviewStatus.textContent = requestedOffset === 0 ? '正在加载...' : '正在加载更多...'
    try {
      const preview = await window.desktopPet.previewAssistantAttachment({
        attachmentId: state.attachmentId,
        conversationId: state.conversationId,
        offset: requestedOffset
      })
      if (attachmentPreviewState !== state || !attachmentPreview.open) {
        return
      }
      attachmentPreviewTitle.textContent = preview.name
      attachmentPreviewMeta.textContent = `${formatAttachmentSize(preview.sizeBytes)} · ${preview.detectedMime}`
      if (preview.status === 'error') {
        attachmentPreviewContent.textContent = attachmentErrorText(preview.error || '附件解析失败。')
        attachmentPreviewStatus.textContent = '无法预览'
        state.nextOffset = null
        attachmentPreviewMore.hidden = true
        return
      }
      if (requestedOffset === 0) {
        attachmentPreviewContent.textContent = preview.content || '文件没有可预览文本。'
      } else {
        attachmentPreviewContent.textContent += preview.content
      }
      state.nextOffset = preview.nextOffset
      state.loadedCharacters = preview.nextOffset ?? preview.totalCharacters
      attachmentPreviewStatus.textContent = preview.truncated
        ? `已加载 ${state.loadedCharacters} / ${preview.totalCharacters} 字符`
        : `共 ${preview.totalCharacters} 字符`
      attachmentPreviewMore.hidden = !preview.truncated
    } catch (error) {
      if (attachmentPreviewState === state) {
        attachmentPreviewStatus.textContent = '预览加载失败'
        attachmentPreviewContent.textContent = error instanceof Error ? error.message : String(error)
        attachmentPreviewMore.hidden = true
      }
    } finally {
      attachmentPreviewMore.disabled = false
    }
  }

  /** 关闭附件预览并丢弃分页状态。 */
  function closeAttachmentPreview(): void {
    attachmentPreviewState = null
    if (attachmentPreview.open) {
      attachmentPreview.close()
    }
  }

  function setBusy(value: boolean): void {
    busy = value
    input.disabled = value
    sendButton.hidden = false
    sendButton.disabled = false
    sendButton.textContent = value ? '■' : '↑'
    sendButton.title = value ? '暂停生成' : '发送'
    sendButton.setAttribute('aria-label', value ? '暂停生成' : '发送')
    newConversationButton.disabled = value
    knowledgeButton.disabled = value
    memoryButton.disabled = value
    skillButton.disabled = value
    webButton.disabled = value
    attachmentButton.disabled = value
    renderPendingAttachments()
  }

  /** 根据输入框末尾的 `~` 或 `$` 触发符刷新本地命令列表。 */
  function updateCommandMenu(): void {
    const state = getCommandPaletteState(input.value, skillCommandOptions())
    if (!state.trigger || state.options.length === 0 || busy) {
      hideCommandMenu()
      return
    }

    selectedCommandIndex = Math.min(selectedCommandIndex, state.options.length - 1)
    commandMenu.replaceChildren()
    state.options.forEach((option, index) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'command-item'
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(index === selectedCommandIndex))
      item.dataset.commandIndex = String(index)

      const label = document.createElement('span')
      label.className = 'command-item-label'
      label.textContent = option.label
      const description = document.createElement('span')
      description.className = 'command-item-description'
      description.textContent = option.description
      item.append(label, description)
      item.addEventListener('mouseenter', () => {
        selectedCommandIndex = index
        updateCommandSelection()
      })
      item.addEventListener('click', () => selectCommand(index))
      commandMenu.append(item)
    })
    commandMenu.hidden = false
    input.setAttribute('aria-expanded', 'true')
    updateCommandSelection()
  }

  function updateCommandSelection(): void {
    commandMenu.querySelectorAll<HTMLElement>('.command-item').forEach((item, index) => {
      item.classList.toggle('is-selected', index === selectedCommandIndex)
      item.setAttribute('aria-selected', String(index === selectedCommandIndex))
    })
  }

  function hideCommandMenu(): void {
    commandMenu.hidden = true
    commandMenu.replaceChildren()
    input.setAttribute('aria-expanded', 'false')
    selectedCommandIndex = 0
  }

  function selectCommand(index: number): void {
    const state = getCommandPaletteState(input.value, skillCommandOptions())
    const option: AssistantCommandOption | undefined = state.options[index]
    if (!state.trigger || !option || state.tokenStart < 0) {
      hideCommandMenu()
      return
    }
    if (option.kind === 'skill' && option.skillId) {
      selectedSkillId = option.skillId
      activeSkillChip.textContent = `$ ${option.label} ×`
      activeSkillChip.hidden = false
      composer.classList.add('has-active-skill')
      input.value = input.value.slice(0, state.tokenStart).trimEnd()
      input.focus()
      resizeInput()
      hideCommandMenu()
      return
    }
    input.value = `${input.value.slice(0, state.tokenStart)}${option.inputPrefix}`
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    resizeInput()
    hideCommandMenu()
  }

  function skillCommandOptions(): AssistantCommandOption[] {
    return (skillSnapshot?.skills ?? [])
      .filter((skill) => skill.enabled && skill.compatibility !== 'invalid')
      .map((skill) => ({
        id: skill.id,
        kind: 'skill',
        label: skill.name,
        description: skill.description,
        inputPrefix: '',
        searchText: `${skill.name} ${skill.description}`,
        skillId: skill.id
      }))
  }

  function clearSelectedSkill(): void {
    selectedSkillId = null
    activeSkillChip.hidden = true
    activeSkillChip.textContent = ''
    composer.classList.remove('has-active-skill')
  }

  function handleCommandKeydown(event: KeyboardEvent): boolean {
    if (commandMenu.hidden) {
      return false
    }
    const itemCount = commandMenu.querySelectorAll('.command-item').length
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      selectedCommandIndex = (selectedCommandIndex + 1) % itemCount
      updateCommandSelection()
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      selectedCommandIndex = (selectedCommandIndex - 1 + itemCount) % itemCount
      updateCommandSelection()
      return true
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      selectCommand(selectedCommandIndex)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      hideCommandMenu()
      return true
    }
    return false
  }

  function renderRuntimeStatus(status: AssistantRuntimeStatus): void {
    runtimeStatus.dataset.state = status.state
    let label: string
    switch (status.state) {
      case 'ready':
        label = status.backend === 'langchain' ? '在线' : '离线模式'
        break
      case 'starting':
        label = '正在启动'
        break
      case 'stopping':
        label = '正在停止'
        break
      case 'failed':
        label = '暂不可用'
        if (status.error) {
          showError(status.error)
        }
        break
      default:
        label = '未启动'
    }
    runtimeStatus.title = label
    runtimeStatus.setAttribute('aria-label', label)
    runtimeStatusText.textContent = label
  }

  function applyTheme(theme: AssistantThemeId): void {
    document.body.dataset.theme = theme
  }

  function applyLayout(layout: AssistantWindowLayout): void {
    latestLayoutRevision = layout.revision
    expanded = layout.expanded
    document.body.dataset.side = layout.side
    document.body.dataset.assistantOpen = String(layout.expanded)
    document.documentElement.style.setProperty('--pet-x', `${layout.pet.x}px`)
    document.documentElement.style.setProperty('--pet-y', `${layout.pet.y}px`)
    document.documentElement.style.setProperty('--assistant-x', `${layout.panel.x}px`)
    document.documentElement.style.setProperty('--assistant-y', `${layout.panel.y}px`)
    document.documentElement.style.setProperty('--assistant-width', `${layout.panel.width}px`)
    document.documentElement.style.setProperty('--assistant-height', `${layout.panel.height}px`)
    traceAssistantLayout('layout-applied', layout.revision)

    if (!layout.expanded) {
      if (memoryMode) {
        closeMemoryView()
      }
      if (petManagerMode) {
        closePetManagerView()
      }
      if (knowledgeMode) {
        closeKnowledgeView()
      }
      if (skillMode) {
        closeSkillView()
      }
      if (webMode) {
        closeWebView()
      }
      closing = false
      composer.classList.remove('is-open', 'is-closing')
      panel.hidden = true
      setTransparentAreaClickThrough(false)
      return
    }

    panel.hidden = false
    composer.classList.remove('is-closing')
    requestAnimationFrame(() => {
      traceAssistantLayout('frame-1', layout.revision)
      composer.classList.add('is-open')
      input.focus()
      requestAnimationFrame(() => {
        if (latestLayoutRevision !== layout.revision || !layout.expanded) {
          return
        }
        traceAssistantLayout('frame-2', layout.revision)
        window.desktopPet.acknowledgeAssistantLayout(layout.revision)
      })
    })
  }

  function closeAssistant(): void {
    if (!expanded || closing) {
      return
    }
    if (memoryMode) {
      closeMemoryView()
    }
    if (petManagerMode) {
      closePetManagerView()
    }
    if (knowledgeMode) {
      closeKnowledgeView()
    }
    if (skillMode) {
      closeSkillView()
    }
    if (webMode) {
      closeWebView()
    }
    closeAttachmentPreview()
    closeArtifactPreview()
    closing = true
    void clearPendingAttachments()
    composer.classList.add('is-closing')
    window.setTimeout(() => {
      void window.desktopPet.closeAssistant().catch(showError)
    }, 180)
  }

  function resizeInput(): void {
    input.style.height = 'auto'
    const height = Math.min(input.scrollHeight, 112)
    input.style.height = `${height}px`
    input.style.overflowY = input.scrollHeight > 112 ? 'auto' : 'hidden'
  }

  function scrollConversation(): void {
    conversation.scrollTop = conversation.scrollHeight
  }

  function setTransparentAreaClickThrough(value: boolean): void {
    if (transparentAreaClickThrough === value) {
      return
    }
    transparentAreaClickThrough = value
    void window.desktopPet.setTransparentAreaClickThrough(value)
  }

  function showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    errorBanner.textContent = message
      .replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '')
      .replace(/^Error:\s*/i, '')
    errorBanner.hidden = false
  }

  function clearError(): void {
    errorBanner.hidden = true
    errorBanner.textContent = ''
  }
}

export function traceAssistantLayout(
  phase: AssistantLayoutTracePhase,
  revision: number | null
): void {
  const pet = document.querySelector('#pet-root')?.getBoundingClientRect()
  if (!pet) {
    return
  }
  window.desktopPet.traceAssistantLayout({
    phase,
    revision,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    pet: { x: pet.x, y: pet.y, width: pet.width, height: pet.height }
  })
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Assistant DOM is missing ${selector}.`)
  }
  return element
}

function formatMemoryDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '时间未知'
  }
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    open_url: '打开网页',
    open_app: '打开应用',
    open_file_or_folder: '打开文件或文件夹'
  }
  return labels[name] || name
}

function knowledgeStatusText(library: AssistantKnowledgeLibrary): string {
  switch (library.status) {
    case 'indexing':
      return `正在索引 ${library.processedFiles}/${library.totalFiles}`
    case 'paused':
      return `已暂停 · ${library.documentCount} 个文档`
    case 'ready':
      return `${library.documentCount} 个文档 · ${library.chunkCount} 个片段`
    case 'error':
      return '索引失败'
    default:
      return '等待索引'
  }
}

function embeddingModelStatus(model: AssistantEmbeddingModelSnapshot): string {
  switch (model.status) {
    case 'downloading':
      return `正在下载 ${Math.round((model.downloadedBytes / Math.max(1, model.downloadBytes)) * 100)}%`
    case 'paused':
      return '下载已暂停'
    case 'installed':
      return '已安装'
    case 'error':
      return model.error || '下载失败'
    default:
      return '未安装'
  }
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`
  }
  return `${Math.ceil(value / 1024)} KB`
}
