import './styles.css'
import type {
  AssistantEvent,
  AssistantKnowledgeLibrary,
  AssistantKnowledgeSnapshot,
  AssistantLayoutTracePhase,
  AssistantMemorySnapshot,
  AssistantRuntimeStatus,
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

export function initializeAssistant(initialTheme: AssistantThemeId = 'quiet'): void {
  const panel = requireElement<HTMLElement>('#assistant-panel')
  const conversation = requireElement<HTMLElement>('#conversation')
  const memoryView = requireElement<HTMLElement>('#memory-view')
  const knowledgeView = requireElement<HTMLElement>('#knowledge-view')
  const knowledgeContent = requireElement<HTMLElement>('#knowledge-content')
  const knowledgeAdd = requireElement<HTMLButtonElement>('#knowledge-add')
  const knowledgeBack = requireElement<HTMLButtonElement>('#knowledge-back')
  const knowledgeDelete = requireElement<HTMLElement>('#knowledge-delete')
  const knowledgeDeleteTitle = requireElement<HTMLElement>('#knowledge-delete-title')
  const knowledgeDeleteCancel = requireElement<HTMLButtonElement>('#knowledge-delete-cancel')
  const knowledgeDeleteConfirm = requireElement<HTMLButtonElement>('#knowledge-delete-confirm')
  const memoryClearOpen = requireElement<HTMLButtonElement>('#memory-clear-open')
  const memoryBackButton = requireElement<HTMLButtonElement>('#memory-back')
  const memoryContent = requireElement<HTMLElement>('#memory-content')
  const memoryClear = requireElement<HTMLElement>('#memory-clear')
  const memoryClearTitle = requireElement<HTMLElement>('#memory-clear-title')
  const memoryClearCancel = requireElement<HTMLButtonElement>('#memory-clear-cancel')
  const memoryClearConfirm = requireElement<HTMLButtonElement>('#memory-clear-confirm')
  const memoryButton = requireElement<HTMLButtonElement>('#memory-button')
  const knowledgeButton = requireElement<HTMLButtonElement>('#knowledge-button')
  const composer = requireElement<HTMLFormElement>('#composer')
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
  let lastSequence = 0
  let busy = false
  let expanded = false
  let closing = false
  let transparentAreaClickThrough = false
  let latestLayoutRevision = 0
  let selectedCommandIndex = 0
  let memoryMode = false
  let knowledgeMode = false
  let knowledgeSnapshot: AssistantKnowledgeSnapshot | null = null
  let knowledgePoll: number | null = null
  let pendingKnowledgeDelete: AssistantKnowledgeLibrary | null = null
  const selectedKnowledgeIds = new Set<string>()
  let memoryTab: 'conversations' | 'memories' | 'toolLogs' = 'conversations'
  let memorySnapshot: AssistantMemorySnapshot | null = null
  let pendingClearScope: MemoryClearScope | null = null
  let pendingDelete: { kind: MemoryItemKind; id: string; title: string } | null = null
  const permissionCards = new Map<string, HTMLElement>()

  window.desktopPet.onAssistantEvent(handleEvent)
  window.desktopPet.onAssistantStatus(renderRuntimeStatus)
  window.desktopPet.onAssistantLayout(applyLayout)
  window.desktopPet.onAssistantTheme(applyTheme)
  window.desktopPet.onAssistantOpenMemory(() => {
    if (!busy) {
      if (memoryMode) {
        closeMemoryView()
      } else {
        if (knowledgeMode) {
          closeKnowledgeView()
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

  newConversationButton.addEventListener('click', () => {
    if (busy) {
      return
    }
    conversationId = crypto.randomUUID()
    activeTaskId = null
    activeAssistantMessage = null
    lastSequence = 0
    conversation.replaceChildren()
    permissionCards.clear()
    hideCommandMenu()
    clearError()
    input.focus()
  })

  closeButton.addEventListener('click', closeAssistant)

  memoryButton.addEventListener('click', () => {
    if (!busy) {
      if (memoryMode) {
        closeMemoryView()
      } else {
        if (knowledgeMode) {
          closeKnowledgeView()
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
        void openKnowledgeView()
      }
    }
  })
  knowledgeBack.addEventListener('click', closeKnowledgeView)
  knowledgeAdd.addEventListener('click', () => void addKnowledgeLibrary())
  knowledgeDeleteCancel.addEventListener('click', cancelKnowledgeDelete)
  knowledgeDeleteConfirm.addEventListener('click', () => void confirmKnowledgeDelete())
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
    window.desktopPet.getSettings()
  ]).then(([snapshot, settings]) => {
    knowledgeSnapshot = snapshot
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
    if (!message) {
      return
    }

    clearError()
    addMessage('user', message)
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
        conversationId
      })
      activeTaskId ??= result.taskId
    } catch (error) {
      if (activeAssistantMessage) {
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
      knowledgeSnapshot = await window.desktopPet.getAssistantKnowledge()
      knowledgeMode = true
      conversation.hidden = true
      knowledgeView.hidden = false
      input.disabled = true
      sendButton.disabled = true
      newConversationButton.disabled = true
      knowledgeButton.setAttribute('aria-pressed', 'true')
      document.body.dataset.assistantMode = 'knowledge'
      renderKnowledgeView()
      scheduleKnowledgePoll()
    } catch (error) {
      showError(error)
    }
  }

  function closeKnowledgeView(): void {
    knowledgeMode = false
    pendingKnowledgeDelete = null
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
    if (!knowledgeMode || !(knowledgeSnapshot?.libraries.some((item) => item.status === 'indexing'))) {
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
        knowledgeSnapshot = await window.desktopPet.getAssistantKnowledge()
        renderKnowledgeView()
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
    conversationId = id
    closeMemoryView()
    conversation.replaceChildren()
    activeTaskId = null
    activeAssistantMessage = null
    lastSequence = 0
    try {
      const messages = await window.desktopPet.getAssistantConversationMessages(id)
      messages.forEach((message) => addMessage(message.role, message.content))
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
        activeAssistantMessage.textContent += event.payload.delta
        scrollConversation()
      }
      return
    }

    if (event.type === 'retrieval_sources') {
      renderRetrievalSources(event.payload.sources)
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
        if (!activeAssistantMessage.textContent) {
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
    if (!activeAssistantMessage) {
      return
    }
    activeAssistantMessage.textContent = content
    activeAssistantMessage.dataset.placeholder = 'true'
    scrollConversation()
  }

  function addMessage(role: 'user' | 'assistant', content: string): HTMLElement {
    const article = document.createElement('article')
    article.className = `message ${role}`
    const body = document.createElement('div')
    body.className = 'message-body'
    body.textContent = content
    article.append(body)
    conversation.append(article)
    scrollConversation()
    return body
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
  }

  /** 根据输入框末尾的 `~` 触发符刷新命令列表，`$` 暂时保留给 Skill。 */
  function updateCommandMenu(): void {
    const state = getCommandPaletteState(input.value)
    if (state.trigger !== '~' || state.options.length === 0 || busy) {
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
    const state = getCommandPaletteState(input.value)
    const option: AssistantCommandOption | undefined = state.options[index]
    if (state.trigger !== '~' || !option || state.tokenStart < 0) {
      hideCommandMenu()
      return
    }
    input.value = `${input.value.slice(0, state.tokenStart)}${option.inputPrefix}`
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    resizeInput()
    hideCommandMenu()
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
    closing = true
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
