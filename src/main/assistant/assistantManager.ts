import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import type {
  AssistantAskInput,
  AssistantAskResult,
  AssistantEvent,
  AssistantRequest,
  AssistantRuntimeStatus
} from '../../shared/assistant'
import { ASSISTANT_PROTOCOL_VERSION } from '../../shared/assistant'
import { loadSettings } from '../store'
import { AssistantRuntimeProcess } from './runtimeProcess'

export class AssistantManager {
  private readonly runtime: AssistantRuntimeProcess
  private readonly activeTasks = new Set<string>()

  constructor(
    onStatus: (status: AssistantRuntimeStatus) => void,
    private readonly onEvent: (event: AssistantEvent) => void
  ) {
    this.runtime = new AssistantRuntimeProcess(onStatus)
  }

  getStatus(): AssistantRuntimeStatus {
    return this.runtime.getStatus()
  }

  async start(): Promise<void> {
    await this.runtime.start()
  }

  async ask(input: AssistantAskInput): Promise<AssistantAskResult> {
    const message = validateMessage(input.input)
    const conversationId = validateConversationId(input.conversationId)
    const taskId = randomUUID()
    const request: AssistantRequest = {
      protocolVersion: ASSISTANT_PROTOCOL_VERSION,
      taskId,
      conversationId,
      input: message,
      source: 'assistant-window',
      context: {
        activePetId: loadSettings().petId,
        locale: app.getLocale() || 'zh-CN',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      }
    }
    const client = await this.runtime.start()
    await client.createTask(request)
    this.activeTasks.add(taskId)

    let lastSequence = 0
    void client
      .streamEvents(taskId, (event) => {
        lastSequence = Math.max(lastSequence, event.sequence)
        this.onEvent(event)
        if (event.type === 'done') {
          this.activeTasks.delete(taskId)
        }
      })
      .catch((error: unknown) => {
        this.activeTasks.delete(taskId)
        const message = error instanceof Error ? error.message : String(error)
        this.onEvent({
          protocolVersion: ASSISTANT_PROTOCOL_VERSION,
          taskId,
          sequence: lastSequence + 1,
          type: 'error',
          payload: { code: 'stream_error', message, retryable: true }
        })
        this.onEvent({
          protocolVersion: ASSISTANT_PROTOCOL_VERSION,
          taskId,
          sequence: lastSequence + 2,
          type: 'done',
          payload: { finishReason: 'error' }
        })
      })

    return { taskId }
  }

  async cancel(taskId: string): Promise<boolean> {
    validateTaskId(taskId)
    if (!this.activeTasks.has(taskId)) {
      return false
    }
    const client = await this.runtime.start()
    return client.cancel(taskId)
  }

  async cancelAll(): Promise<void> {
    const taskIds = [...this.activeTasks]
    if (taskIds.length === 0) {
      return
    }
    this.activeTasks.clear()
    const client = await this.runtime.start()
    await Promise.allSettled(taskIds.map((taskId) => client.cancel(taskId)))
  }

  async stop(): Promise<void> {
    this.activeTasks.clear()
    await this.runtime.stop()
  }
}

function validateMessage(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Message must be a string.')
  }
  const message = value.trim()
  if (!message || message.length > 12_000) {
    throw new TypeError('Message must contain between 1 and 12000 characters.')
  }
  return message
}

function validateConversationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value)) {
    throw new TypeError('Conversation id is invalid.')
  }
  return value
}

function validateTaskId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value)) {
    throw new TypeError('Task id is invalid.')
  }
}
