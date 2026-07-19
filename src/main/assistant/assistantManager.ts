import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import type {
  AssistantAskInput,
  AssistantAskResult,
  AssistantEvent,
  AssistantPermissionResolution,
  AssistantRequest,
  AssistantRuntimeStatus,
  AssistantToolResultRequest,
  ToolCall
} from '../../shared/assistant'
import { ASSISTANT_PROTOCOL_VERSION } from '../../shared/assistant'
import { loadSettings } from '../store'
import { logError } from '../logger'
import { writeToolAudit } from './auditLog'
import { AssistantRuntimeProcess } from './runtimeProcess'
import { AssistantToolHost } from './toolHost'
import type { ToolPolicyResult } from './toolPolicy'

const PERMISSION_TIMEOUT_MS = 60_000

interface ActiveTask {
  lastRuntimeSequence: number
  lastUiSequence: number
  openToolCalls: Set<string>
}

interface PendingToolContext {
  taskId: string
  call: ToolCall
  policy: ToolPolicyResult
}

interface PendingPermission extends PendingToolContext {
  timeout: NodeJS.Timeout
}

export class AssistantManager {
  private readonly runtime: AssistantRuntimeProcess
  private readonly toolHost = new AssistantToolHost()
  private readonly activeTasks = new Map<string, ActiveTask>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()

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

  /** 创建聊天任务，并把 Runtime 与 Main 产生的事件统一编排后发送给 Renderer。 */
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
    const state: ActiveTask = {
      lastRuntimeSequence: 0,
      lastUiSequence: 0,
      openToolCalls: new Set()
    }
    this.activeTasks.set(taskId, state)
    try {
      await client.createTask(request)
    } catch (error) {
      this.activeTasks.delete(taskId)
      throw error
    }

    void client
      .streamEvents(taskId, (event) => this.handleRuntimeEvent(event))
      .catch((error: unknown) => {
        const active = this.activeTasks.get(taskId)
        if (!active) {
          return
        }
        const errorMessage = error instanceof Error ? error.message : String(error)
        this.emit(taskId, {
          protocolVersion: ASSISTANT_PROTOCOL_VERSION,
          taskId,
          sequence: 0,
          type: 'error',
          payload: { code: 'stream_error', message: errorMessage, retryable: true }
        })
        this.emit(taskId, {
          protocolVersion: ASSISTANT_PROTOCOL_VERSION,
          taskId,
          sequence: 0,
          type: 'done',
          payload: { finishReason: 'error' }
        })
        this.cleanupTask(taskId)
      })

    return { taskId }
  }

  /** 处理用户对工具确认卡片的选择，Renderer 不能覆盖 Main 保存的工具参数。 */
  async resolvePermission(input: AssistantPermissionResolution): Promise<boolean> {
    validateTaskId(input.taskId)
    validateTaskId(input.toolCallId)
    if (input.decision !== 'approved' && input.decision !== 'denied') {
      throw new TypeError('Permission decision is invalid.')
    }

    const key = permissionKey(input.taskId, input.toolCallId)
    const pending = this.pendingPermissions.get(key)
    if (!pending) {
      return false
    }
    clearTimeout(pending.timeout)
    this.pendingPermissions.delete(key)
    writeToolAudit({
      taskId: pending.taskId,
      toolCallId: pending.call.id,
      toolName: pending.call.name,
      args: pending.policy.args,
      risk: pending.policy.risk,
      policyDecision: pending.policy.action,
      userDecision: input.decision
    })

    if (input.decision === 'denied') {
      await this.completeToolCall(pending, {
        decision: 'denied',
        ok: false,
        error: '用户拒绝了这次操作。'
      })
      return true
    }

    const startedAt = Date.now()
    const execution = await this.toolHost.execute(pending.policy)
    await this.completeToolCall(pending, {
      decision: 'approved',
      ...execution,
      durationMs: Date.now() - startedAt
    })
    return true
  }

  async cancel(taskId: string): Promise<boolean> {
    validateTaskId(taskId)
    if (!this.activeTasks.has(taskId)) {
      return false
    }
    this.clearPendingPermissions(taskId)
    const client = await this.runtime.start()
    return client.cancel(taskId)
  }

  async cancelAll(): Promise<void> {
    const taskIds = [...this.activeTasks.keys()]
    if (taskIds.length === 0) {
      return
    }
    taskIds.forEach((taskId) => this.clearPendingPermissions(taskId))
    const client = await this.runtime.start()
    await Promise.allSettled(taskIds.map((taskId) => client.cancel(taskId)))
  }

  async stop(): Promise<void> {
    for (const taskId of this.activeTasks.keys()) {
      this.clearPendingPermissions(taskId)
    }
    this.activeTasks.clear()
    await this.runtime.stop()
  }

  private handleRuntimeEvent(event: AssistantEvent): void {
    const state = this.activeTasks.get(event.taskId)
    if (!state || event.sequence <= state.lastRuntimeSequence) {
      return
    }
    state.lastRuntimeSequence = event.sequence

    if (event.type === 'tool_call') {
      void this.processToolCall(event.taskId, event.payload).catch((error: unknown) => {
        logError('assistant tool call failed', error)
      })
      return
    }

    this.emit(event.taskId, event)
    if (event.type === 'done') {
      this.cleanupTask(event.taskId)
    }
  }

  /** Main 重新计算工具风险，随后自动执行、安全拒绝或等待用户确认。 */
  private async processToolCall(taskId: string, runtimeCall: ToolCall): Promise<void> {
    const state = this.activeTasks.get(taskId)
    if (!state || !isValidToolCallIdentity(runtimeCall) || state.openToolCalls.has(runtimeCall.id)) {
      return
    }
    state.openToolCalls.add(runtimeCall.id)
    const policy = this.toolHost.evaluate(runtimeCall)
    const call: ToolCall = {
      id: runtimeCall.id,
      name: runtimeCall.name,
      args: policy.args,
      risk: policy.risk,
      preview: policy.preview
    }
    const pendingBase = { taskId, call, policy }

    this.emit(taskId, {
      protocolVersion: ASSISTANT_PROTOCOL_VERSION,
      taskId,
      sequence: 0,
      type: 'tool_call',
      payload: call
    })
    writeToolAudit({
      taskId,
      toolCallId: call.id,
      toolName: call.name,
      args: policy.args,
      risk: policy.risk,
      policyDecision: policy.action
    })

    if (policy.action === 'deny') {
      await this.completeToolCall(
        pendingBase,
        { decision: 'denied', ok: false, error: policy.error || '工具被策略拒绝。' }
      )
      return
    }

    if (policy.action === 'execute') {
      const startedAt = Date.now()
      const execution = await this.toolHost.execute(policy)
      await this.completeToolCall(
        pendingBase,
        {
          decision: 'approved',
          ...execution,
          durationMs: Date.now() - startedAt
        }
      )
      return
    }

    const key = permissionKey(taskId, call.id)
    const pending: PendingPermission = {
      ...pendingBase,
      timeout: setTimeout(() => {
        if (this.pendingPermissions.get(key) !== pending) {
          return
        }
        this.pendingPermissions.delete(key)
        void this.completeToolCall(pending, {
          decision: 'denied',
          ok: false,
          error: '工具确认已超时。'
        })
      }, PERMISSION_TIMEOUT_MS)
    }
    this.pendingPermissions.set(key, pending)
    this.emit(taskId, {
      protocolVersion: ASSISTANT_PROTOCOL_VERSION,
      taskId,
      sequence: 0,
      type: 'permission_required',
      payload: call
    })
  }

  private async completeToolCall(
    pending: PendingToolContext,
    result: {
      decision: AssistantToolResultRequest['decision']
      ok: boolean
      result?: unknown
      error?: string
      durationMs?: number
    }
  ): Promise<void> {
    const state = this.activeTasks.get(pending.taskId)
    if (!state || !state.openToolCalls.delete(pending.call.id)) {
      return
    }
    const request: AssistantToolResultRequest = {
      protocolVersion: ASSISTANT_PROTOCOL_VERSION,
      taskId: pending.taskId,
      toolCallId: pending.call.id,
      decision: result.decision,
      result: result.result,
      error: result.error
    }
    try {
      const client = await this.runtime.start()
      await client.submitToolResult(request)
      this.emit(pending.taskId, {
        protocolVersion: ASSISTANT_PROTOCOL_VERSION,
        taskId: pending.taskId,
        sequence: 0,
        type: 'tool_result',
        payload: {
          toolCallId: pending.call.id,
          ok: result.ok,
          result: result.result,
          error: result.error
        }
      })
    } catch (error) {
      logError('assistant tool result failed to submit', error)
    }
    writeToolAudit({
      taskId: pending.taskId,
      toolCallId: pending.call.id,
      toolName: pending.call.name,
      args: pending.policy.args,
      risk: pending.policy.risk,
      policyDecision: pending.policy.action,
      userDecision: result.decision,
      ok: result.ok,
      error: result.error,
      durationMs: result.durationMs
    })
  }

  private emit(taskId: string, event: AssistantEvent): void {
    const state = this.activeTasks.get(taskId)
    if (!state) {
      return
    }
    state.lastUiSequence += 1
    this.onEvent({ ...event, sequence: state.lastUiSequence } as AssistantEvent)
  }

  private clearPendingPermissions(taskId: string): void {
    for (const [key, pending] of this.pendingPermissions) {
      if (pending.taskId !== taskId) {
        continue
      }
      clearTimeout(pending.timeout)
      this.pendingPermissions.delete(key)
    }
  }

  private cleanupTask(taskId: string): void {
    this.clearPendingPermissions(taskId)
    this.activeTasks.delete(taskId)
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
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('Task id is invalid.')
  }
}

function isValidToolCallIdentity(call: ToolCall): boolean {
  return (
    typeof call.id === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(call.id) &&
    typeof call.name === 'string' &&
    /^[a-z_]{1,64}$/.test(call.name)
  )
}

function permissionKey(taskId: string, toolCallId: string): string {
  return `${taskId}:${toolCallId}`
}
