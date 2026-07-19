import './styles.css'
import type {
  AssistantEvent,
  AssistantLayoutTracePhase,
  AssistantRuntimeStatus,
  AssistantWindowLayout,
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
  const composer = requireElement<HTMLFormElement>('#composer')
  const input = requireElement<HTMLTextAreaElement>('#message-input')
  const sendButton = requireElement<HTMLButtonElement>('#send-button')
  const stopButton = requireElement<HTMLButtonElement>('#stop-button')
  const newConversationButton = requireElement<HTMLButtonElement>('#new-conversation')
  const closeButton = requireElement<HTMLButtonElement>('#close-button')
  const errorBanner = requireElement<HTMLElement>('#error-banner')
  const runtimeStatus = requireElement<HTMLElement>('#runtime-status')
  const runtimeStatusText = requireElement<HTMLElement>('#runtime-status-text')
  const commandMenu = requireElement<HTMLElement>('#command-menu')

  let conversationId = crypto.randomUUID()
  let activeTaskId: string | null = null
  let activeAssistantMessage: HTMLElement | null = null
  let lastSequence = 0
  let busy = false
  let expanded = false
  let closing = false
  let transparentAreaClickThrough = false
  let latestLayoutRevision = 0
  let selectedCommandIndex = 0
  const permissionCards = new Map<string, HTMLElement>()

  window.desktopPet.onAssistantEvent(handleEvent)
  window.desktopPet.onAssistantStatus(renderRuntimeStatus)
  window.desktopPet.onAssistantLayout(applyLayout)
  window.desktopPet.onAssistantTheme(applyTheme)
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

  stopButton.addEventListener('click', () => {
    if (!activeTaskId) {
      return
    }
    stopButton.disabled = true
    void window.desktopPet.cancelAssistant(activeTaskId).catch(showError)
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

  void window.desktopPet.getAssistantStatus().then(renderRuntimeStatus).catch(showError)

  async function sendMessage(): Promise<void> {
    if (!commandMenu.hidden) {
      selectCommand(selectedCommandIndex)
      return
    }
    const message = input.value.trim()
    if (!message || busy) {
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
      const result = await window.desktopPet.askAssistant({ input: message, conversationId })
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

  function setBusy(value: boolean): void {
    busy = value
    input.disabled = value
    sendButton.hidden = value
    stopButton.hidden = !value
    stopButton.disabled = false
    newConversationButton.disabled = value
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
