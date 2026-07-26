import type {
  AssistantMemorySnapshot,
  AssistantConversationMessage,
  AssistantEvent,
  AssistantKnowledgeLibrary,
  AssistantKnowledgeSnapshot,
  AssistantRequest,
  AssistantRuntimeReady,
  AssistantToolResultRequest,
  MemoryClearScope,
  MemoryItemKind
} from '../../shared/assistant'
import type { ToolAuditEntry } from './auditLog'

export class AssistantRuntimeClient {
  private readonly baseUrl: string
  private readonly authorization: string

  constructor(readiness: AssistantRuntimeReady, token: string) {
    this.baseUrl = `http://127.0.0.1:${readiness.port}`
    this.authorization = `Bearer ${token}`
  }

  async health(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(1_000)
    })
    if (!response.ok) {
      throw new Error(`Runtime health check failed (${response.status}).`)
    }
  }

  async createTask(request: AssistantRequest): Promise<void> {
    await this.request('/v1/chat', {
      method: 'POST',
      body: JSON.stringify(request)
    })
  }

  async streamEvents(
    taskId: string,
    onEvent: (event: AssistantEvent) => void
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/events/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: this.authorization }
    })
    if (!response.ok || !response.body) {
      throw new Error(await responseError(response, 'Unable to open the Runtime event stream.'))
    }

    const decoder = new TextDecoder()
    let buffer = ''

    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      const chunk = value
      buffer += decoder.decode(chunk, { stream: true })
      buffer = consumeSseBuffer(buffer, taskId, onEvent)
    }

    buffer += decoder.decode()
    consumeSseBuffer(`${buffer}\n\n`, taskId, onEvent)
  }

  async cancel(taskId: string): Promise<boolean> {
    const response = await this.request(`/v1/cancel/${encodeURIComponent(taskId)}`, {
      method: 'POST'
    })
    const payload = (await response.json()) as { cancelled?: unknown }
    return payload.cancelled === true
  }

  async submitToolResult(request: AssistantToolResultRequest): Promise<void> {
    await this.request('/v1/tool-result', {
      method: 'POST',
      body: JSON.stringify(request)
    })
  }

  async getMemorySnapshot(): Promise<AssistantMemorySnapshot> {
    const response = await this.request('/v1/memory', { method: 'GET' })
    return (await response.json()) as AssistantMemorySnapshot
  }

  async getConversationMessages(conversationId: string): Promise<AssistantConversationMessage[]> {
    const response = await this.request(`/v1/memory/conversation/${encodeURIComponent(conversationId)}`, { method: 'GET' })
    const payload = (await response.json()) as { messages?: unknown }
    return Array.isArray(payload.messages) ? (payload.messages as AssistantConversationMessage[]) : []
  }

  async recordToolLog(entry: ToolAuditEntry): Promise<void> {
    await this.request('/v1/memory/tool-log', {
      method: 'POST',
      body: JSON.stringify(entry)
    })
  }

  async deleteMemoryItem(kind: MemoryItemKind, id: string): Promise<boolean> {
    const response = await this.request('/v1/memory/item', {
      method: 'DELETE',
      body: JSON.stringify({ kind, id })
    })
    const payload = (await response.json()) as { deleted?: unknown }
    return payload.deleted === true
  }

  async clearMemory(scope: MemoryClearScope): Promise<void> {
    await this.request('/v1/memory/clear', {
      method: 'POST',
      body: JSON.stringify({ scope })
    })
  }

  async resolveMemoryCandidate(candidateId: number, decision: 'confirmed' | 'rejected'): Promise<boolean> {
    const response = await this.request(`/v1/memory/candidate/${candidateId}`, {
      method: 'POST',
      body: JSON.stringify({ decision })
    })
    const payload = (await response.json()) as { accepted?: unknown }
    return payload.accepted === true
  }

  /** 获取知识库与后台索引状态。 */
  async getKnowledgeSnapshot(): Promise<AssistantKnowledgeSnapshot> {
    const response = await this.request('/v1/knowledge', { method: 'GET' })
    return (await response.json()) as AssistantKnowledgeSnapshot
  }

  /** 把 Main 原生目录选择器授权的路径创建为知识库。 */
  async addKnowledgeLibrary(name: string, path: string): Promise<AssistantKnowledgeLibrary> {
    const response = await this.request('/v1/knowledge/library', {
      method: 'POST',
      body: JSON.stringify({ name, path })
    })
    const payload = (await response.json()) as { library: AssistantKnowledgeLibrary }
    return payload.library
  }

  /** 启动、恢复或刷新知识库索引。 */
  async startKnowledgeIndex(libraryId: string): Promise<boolean> {
    const response = await this.request(`/v1/knowledge/library/${encodeURIComponent(libraryId)}/index`, {
      method: 'POST'
    })
    const payload = (await response.json()) as { started?: unknown }
    return payload.started === true
  }

  /** 请求在当前文件结束后暂停索引。 */
  async pauseKnowledgeIndex(libraryId: string): Promise<boolean> {
    const response = await this.request(`/v1/knowledge/library/${encodeURIComponent(libraryId)}/pause`, {
      method: 'POST'
    })
    const payload = (await response.json()) as { paused?: unknown }
    return payload.paused === true
  }

  /** 删除知识库索引；Runtime 不会修改来源目录。 */
  async deleteKnowledgeLibrary(libraryId: string): Promise<boolean> {
    const response = await this.request(`/v1/knowledge/library/${encodeURIComponent(libraryId)}`, {
      method: 'DELETE'
    })
    const payload = (await response.json()) as { deleted?: unknown }
    return payload.deleted === true
  }

  /** 为当前活动 Embedding 签名启动全部知识库重建。 */
  async reindexAllKnowledge(): Promise<number> {
    const response = await this.request('/v1/knowledge/reindex-all', { method: 'POST' })
    const payload = (await response.json()) as { started?: unknown }
    return Number.isInteger(payload.started) ? Number(payload.started) : 0
  }

  async shutdown(): Promise<void> {
    await this.request('/v1/shutdown', { method: 'POST' })
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', this.authorization)
    if (init.body) {
      headers.set('Content-Type', 'application/json')
    }
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers })
    if (!response.ok) {
      throw new Error(await responseError(response, `Runtime request failed (${response.status}).`))
    }
    return response
  }
}

export function consumeSseBuffer(
  buffer: string,
  taskId: string,
  onEvent: (event: AssistantEvent) => void
): string {
  const blocks = buffer.split(/\r?\n\r?\n/)
  const remainder = blocks.pop() ?? ''

  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) {
      continue
    }
    const event = JSON.parse(data) as unknown
    if (!isAssistantEvent(event) || event.taskId !== taskId) {
      throw new Error('Runtime returned an invalid assistant event.')
    }
    onEvent(event)
  }

  return remainder
}

function isAssistantEvent(value: unknown): value is AssistantEvent {
  if (!value || typeof value !== 'object') {
    return false
  }
  const event = value as Record<string, unknown>
  return (
    event.protocolVersion === 1 &&
    typeof event.taskId === 'string' &&
    Number.isInteger(event.sequence) &&
    typeof event.type === 'string' &&
    ['message_delta', 'retrieval_sources', 'tool_call', 'permission_required', 'tool_result', 'done', 'error'].includes(
      event.type
    ) &&
    !!event.payload &&
    typeof event.payload === 'object'
  )
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.text().catch(() => '')
  if (!body) {
    return fallback
  }
  try {
    const payload = JSON.parse(body) as { detail?: unknown }
    return typeof payload.detail === 'string' ? payload.detail : fallback
  } catch {
    return fallback
  }
}
