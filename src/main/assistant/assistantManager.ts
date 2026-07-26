import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import type {
  AssistantAskInput,
  AssistantAskResult,
  AssistantConversationMessage,
  AssistantEvent,
  AssistantEmbeddingOnlineInput,
  AssistantEmbeddingSnapshot,
  AssistantKnowledgeLibrary,
  AssistantKnowledgeSnapshot,
  AssistantMemorySnapshot,
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
import { EmbeddingModelManager } from './embeddingModelManager'
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
  private readonly embeddingModels = new EmbeddingModelManager()
  private readonly runtime: AssistantRuntimeProcess
  private readonly toolHost = new AssistantToolHost()
  private readonly activeTasks = new Map<string, ActiveTask>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()

  constructor(
    onStatus: (status: AssistantRuntimeStatus) => void,
    private readonly onEvent: (event: AssistantEvent) => void
  ) {
    this.runtime = new AssistantRuntimeProcess(
      onStatus,
      () => this.embeddingModels.runtimeEnvironment()
    )
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
    const knowledgeLibraryIds = validateKnowledgeLibraryIds(loadSettings().assistantKnowledgeLibraryIds)
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
      },
      knowledgeLibraryIds
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
    this.recordToolAudit({
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

  /** 获取 Runtime 返回的脱敏记忆摘要，Renderer 不直接访问数据库。 */
  async getMemorySnapshot(): Promise<AssistantMemorySnapshot> {
    const client = await this.runtime.start()
    return client.getMemorySnapshot()
  }

  async getConversationMessages(conversationId: string): Promise<AssistantConversationMessage[]> {
    if (typeof conversationId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(conversationId)) {
      throw new TypeError('Conversation id is invalid.')
    }
    const client = await this.runtime.start()
    return client.getConversationMessages(conversationId)
  }

  async deleteMemoryItem(
    kind: 'conversation' | 'memory' | 'app' | 'directory',
    id: string
  ): Promise<boolean> {
    const client = await this.runtime.start()
    return client.deleteMemoryItem(kind, id)
  }

  async clearMemory(scope: 'all' | 'conversations' | 'memories' | 'tool_logs'): Promise<void> {
    const client = await this.runtime.start()
    await client.clearMemory(scope)
  }

  async resolveMemoryCandidate(
    candidateId: number,
    decision: 'confirmed' | 'rejected'
  ): Promise<boolean> {
    if (!Number.isInteger(candidateId) || candidateId < 1) {
      throw new TypeError('Memory candidate id is invalid.')
    }
    const client = await this.runtime.start()
    return client.resolveMemoryCandidate(candidateId, decision)
  }

  /** 获取知识库管理界面需要的索引状态。 */
  async getKnowledgeSnapshot(): Promise<AssistantKnowledgeSnapshot> {
    const client = await this.runtime.start()
    return client.getKnowledgeSnapshot()
  }

  /** 接收 Main 已经通过原生选择器授权的目录，Renderer 无法传入路径。 */
  async addKnowledgeLibrary(name: string, path: string): Promise<AssistantKnowledgeLibrary> {
    const client = await this.runtime.start()
    return client.addKnowledgeLibrary(name, path)
  }

  async startKnowledgeIndex(libraryId: string): Promise<boolean> {
    validateKnowledgeLibraryId(libraryId)
    const client = await this.runtime.start()
    return client.startKnowledgeIndex(libraryId)
  }

  async pauseKnowledgeIndex(libraryId: string): Promise<boolean> {
    validateKnowledgeLibraryId(libraryId)
    const client = await this.runtime.start()
    return client.pauseKnowledgeIndex(libraryId)
  }

  async deleteKnowledgeLibrary(libraryId: string): Promise<boolean> {
    validateKnowledgeLibraryId(libraryId)
    const client = await this.runtime.start()
    return client.deleteKnowledgeLibrary(libraryId)
  }

  /** 返回本地白名单模型、下载进度和当前活动 Provider。 */
  async getEmbeddingSnapshot(): Promise<AssistantEmbeddingSnapshot> {
    return this.embeddingModels.snapshot()
  }

  async downloadEmbeddingModel(modelId: string): Promise<void> {
    validateEmbeddingModelId(modelId)
    await this.embeddingModels.download(modelId)
  }

  pauseEmbeddingModelDownload(modelId: string): boolean {
    validateEmbeddingModelId(modelId)
    return this.embeddingModels.pause(modelId)
  }

  async selectEmbeddingModel(modelId: string | null): Promise<number> {
    if (modelId !== null) {
      validateEmbeddingModelId(modelId)
    }
    await this.cancelAll()
    const backup = this.embeddingModels.captureConfiguration()
    try {
      await this.embeddingModels.selectLocal(modelId)
      const client = await this.runtime.restart()
      return await client.reindexAllKnowledge()
    } catch (error) {
      await this.embeddingModels.restoreConfiguration(backup)
      await this.runtime.restart().catch((rollbackError: unknown) => {
        logError('embedding provider rollback failed', rollbackError)
      })
      throw error
    }
  }

  async configureOnlineEmbedding(input: AssistantEmbeddingOnlineInput): Promise<number> {
    if (!input || typeof input !== 'object') {
      throw new TypeError('在线向量模型配置无效。')
    }
    await this.cancelAll()
    const backup = this.embeddingModels.captureConfiguration()
    try {
      await this.embeddingModels.configureOnline(input)
      const client = await this.runtime.restart()
      return await client.reindexAllKnowledge()
    } catch (error) {
      await this.embeddingModels.restoreConfiguration(backup)
      await this.runtime.restart().catch((rollbackError: unknown) => {
        logError('online embedding provider rollback failed', rollbackError)
      })
      throw error
    }
  }

  async deleteEmbeddingModel(modelId: string): Promise<void> {
    validateEmbeddingModelId(modelId)
    await this.embeddingModels.delete(modelId)
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
    this.recordToolAudit({
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
    this.recordToolAudit({
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

  /** 同时保留现有脱敏 JSONL 审计，并异步写入 SQLite。 */
  private recordToolAudit(entry: Parameters<typeof writeToolAudit>[0]): void {
    writeToolAudit(entry)
    if (this.runtime.getStatus().state !== 'ready') {
      return
    }
    void this.runtime
      .start()
      .then((client) => client.recordToolLog(entry))
      .catch((error: unknown) => logError('assistant memory tool log failed', error))
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

function validateKnowledgeLibraryIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new TypeError('Knowledge library ids are invalid.')
  }
  const ids = [...new Set(value)]
  ids.forEach(validateKnowledgeLibraryId)
  return ids
}

function validateKnowledgeLibraryId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) {
    throw new TypeError('Knowledge library id is invalid.')
  }
}

function validateEmbeddingModelId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9.-]{1,128}$/.test(value)) {
    throw new TypeError('Embedding model id is invalid.')
  }
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
