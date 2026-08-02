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
  AssistantRuntimeStatus,
  AssistantSkillInstallPreview,
  AssistantSkillSnapshot,
  AssistantSkillSummary,
  AssistantWindowLayout,
  MemoryClearScope,
  MemoryItemKind,
  ToolCall
} from '../../shared/assistant'
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

export function initializeAssistant(initialTheme: AssistantThemeId = 'quiet'): void {
  const panel = requireElement<HTMLElement>('#assistant-panel')
  const petRoot = requireElement<HTMLElement>('#pet-root')
  const conversation = requireElement<HTMLElement>('#conversation')
  const memoryView = requireElement<HTMLElement>('#memory-view')
  const knowledgeView = requireElement<HTMLElement>('#knowledge-view')
  const skillView = requireElement<HTMLElement>('#skill-view')
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
  const knowledgeButton = requireElement<HTMLButtonElement>('#knowledge-button')
  const skillButton = requireElement<HTMLButtonElement>('#skill-button')
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
  let knowledgeMode = false
  let skillMode = false
  let skillSnapshot: AssistantSkillSnapshot | null = null
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
        if (knowledgeMode) {
          closeKnowledgeView()
        }
        if (skillMode) {
          closeSkillView()
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
    if (attachmentPreview.open || artifactPreview.open) {
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
        if (knowledgeMode) {
          closeKnowledgeView()
        }
        if (skillMode) {
          closeSkillView()
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
        if (skillMode) {
          closeSkillView()
        }
        void openKnowledgeView()
      }
    }
  })
  skillButton.addEventListener('click', () => {
    if (!busy) {
      if (skillMode) {
        closeSkillView()
      } else {
        if (memoryMode) {
          closeMemoryView()
        }
        if (knowledgeMode) {
          closeKnowledgeView()
        }
        void openSkillView()
      }
    }
  })
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
    window.desktopPet.getSettings()
  ]).then(([snapshot, models, skills, settings]) => {
    knowledgeSnapshot = snapshot
    embeddingSnapshot = models
    skillSnapshot = skills
    const existing = new Set(snapshot.libraries.map((library) => library.id))
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
      messages.forEach((message) => addMessage(message.role, message.content, message.attachments, message.artifacts))
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
      renderAttachmentSources(event.payload.sources)
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
    artifacts: AssistantArtifactSummary[] = []
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
    const anchor = target?.closest<HTMLAnchorElement>('.message.assistant .message-body a[href]')
    const url = anchor?.getAttribute('href')
    if (!anchor || !url) {
      return
    }
    event.preventDefault()
    void window.desktopPet.openAssistantExternalUrl(url).catch(showError)
  }

  /** 在当前助手消息下展示 Runtime 返回的可核查来源。 */
  function renderRetrievalSources(sources: Extract<AssistantEvent, { type: 'retrieval_sources' }>['payload']['sources']): void {
    const article = activeAssistantMessage?.closest('article')
    if (!article || sources.length === 0) {
      return
    }
    article.querySelector('.retrieval-sources')?.remove()
    const details = document.createElement('details')
    details.className = 'retrieval-sources'
    const summary = document.createElement('summary')
    summary.textContent = `参考资料 ${sources.length}`
    details.append(summary)
    sources.forEach((source, index) => {
      const item = document.createElement('div')
      item.className = 'retrieval-source'
      const title = document.createElement('strong')
      title.textContent = `[资料${index + 1}] ${source.title}`
      const path = document.createElement('span')
      path.textContent = `${source.libraryName} / ${source.relativePath}`
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
    sources: Extract<AssistantEvent, { type: 'attachment_sources' }>['payload']['sources']
  ): void {
    const article = activeAssistantMessage?.closest('article')
    if (!article || sources.length === 0) {
      return
    }
    article.querySelector('.attachment-sources')?.remove()
    const details = document.createElement('details')
    details.className = 'retrieval-sources attachment-sources'
    const summary = document.createElement('summary')
    summary.textContent = `已读取附件 ${sources.length}`
    details.append(summary)
    sources.forEach((source) => {
      const item = document.createElement('div')
      item.className = 'retrieval-source attachment-source'
      const title = document.createElement('strong')
      title.textContent = source.name + (source.truncated ? '（内容已截断）' : '')
      const excerpt = document.createElement('p')
      excerpt.textContent = source.excerpt || '附件无可展示摘要。'
      item.append(title, excerpt)
      details.append(item)
    })
    article.append(details)
    scrollConversation()
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
    return error === 'attachment_decode_failed' ? '文件不是有效的 UTF-8 文本' : error
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
      if (knowledgeMode) {
        closeKnowledgeView()
      }
      if (skillMode) {
        closeSkillView()
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
    if (knowledgeMode) {
      closeKnowledgeView()
    }
    if (skillMode) {
      closeSkillView()
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
    errorBanner.textContent = error instanceof Error ? error.message : String(error)
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
