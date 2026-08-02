import type {
  AssistantAttachmentSummary,
  AssistantAttachmentPreview,
  AssistantArtifactPreview,
  AssistantArtifactSummary,
  AssistantMemorySnapshot,
  AssistantConversationMessage,
  AssistantEvent,
  AssistantKnowledgeLibrary,
  AssistantKnowledgeSnapshot,
  AssistantRequest,
  AssistantRuntimeReady,
  AssistantSkillInstallPreview,
  AssistantSkillSnapshot,
  AssistantToolResultRequest,
  MemoryClearScope,
  MemoryItemKind
} from '../../shared/assistant'
import type { ToolAuditEntry } from './auditLog'
import type { AssistantAttachmentRegistration } from './attachmentManager'

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

  /** 登记 Main 已复制的附件，响应中不包含受控文件路径或正文。 */
  async registerAttachments(
    registrations: AssistantAttachmentRegistration[]
  ): Promise<AssistantAttachmentSummary[]> {
    const response = await this.request('/v1/attachments', {
      method: 'POST',
      body: JSON.stringify({ attachments: registrations })
    })
    const payload = (await response.json()) as { attachments?: unknown }
    return Array.isArray(payload.attachments)
      ? (payload.attachments as AssistantAttachmentSummary[])
      : []
  }

  /** 删除尚未绑定到会话的附件草稿。 */
  async deleteDraftAttachment(attachmentId: string): Promise<boolean> {
    const response = await this.request(`/v1/attachments/${encodeURIComponent(attachmentId)}`, {
      method: 'DELETE'
    })
    const payload = (await response.json()) as { deleted?: unknown }
    return payload.deleted === true
  }

  /** 按附件 ID 获取一段已解析文本，Runtime 负责校验草稿或会话归属。 */
  async previewAttachment(
    attachmentId: string,
    conversationId: string | null,
    offset: number
  ): Promise<AssistantAttachmentPreview> {
    const response = await this.request(
      `/v1/attachments/${encodeURIComponent(attachmentId)}/preview`,
      {
        method: 'POST',
        body: JSON.stringify({ conversationId, offset, limit: 65_536 })
      }
    )
    return (await response.json()) as AssistantAttachmentPreview
  }

  /** 获取指定会话 Artifact 的脱敏元数据。 */
  async getArtifact(artifactId: string, conversationId: string): Promise<AssistantArtifactSummary> {
    const query = new URLSearchParams({ conversationId })
    const response = await this.request(
      `/v1/artifacts/${encodeURIComponent(artifactId)}?${query.toString()}`,
      { method: 'GET' }
    )
    return (await response.json()) as AssistantArtifactSummary
  }

  /** 获取 Artifact 的分页纯文本预览。 */
  async previewArtifact(
    artifactId: string,
    conversationId: string,
    offset: number
  ): Promise<AssistantArtifactPreview> {
    const response = await this.request(`/v1/artifacts/${encodeURIComponent(artifactId)}/preview`, {
      method: 'POST',
      body: JSON.stringify({ conversationId, offset, limit: 65_536 })
    })
    return (await response.json()) as AssistantArtifactPreview
  }

  /** 读取 Main 原生保存流程需要的完整 Artifact 字节。 */
  async getArtifactContent(artifactId: string, conversationId: string): Promise<Uint8Array> {
    const query = new URLSearchParams({ conversationId })
    const response = await this.request(
      `/v1/artifacts/${encodeURIComponent(artifactId)}/content?${query.toString()}`,
      { method: 'GET' }
    )
    return new Uint8Array(await response.arrayBuffer())
  }

  /** 标记 Artifact 已经由 Main 另存到用户选择的位置。 */
  async markArtifactSaved(artifactId: string, conversationId: string): Promise<AssistantArtifactSummary> {
    const response = await this.request(`/v1/artifacts/${encodeURIComponent(artifactId)}/saved`, {
      method: 'POST',
      body: JSON.stringify({ conversationId })
    })
    return (await response.json()) as AssistantArtifactSummary
  }

  /** 删除应用内 Artifact，Runtime 会复核会话归属。 */
  async deleteArtifact(artifactId: string, conversationId: string): Promise<boolean> {
    const response = await this.request(`/v1/artifacts/${encodeURIComponent(artifactId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ conversationId })
    })
    const payload = (await response.json()) as { deleted?: unknown }
    return payload.deleted === true
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

  /** 获取当前 Skill 元数据快照，不包含完整指令和真实路径。 */
  async getSkillSnapshot(): Promise<AssistantSkillSnapshot> {
    const response = await this.request('/v1/skills', { method: 'GET' })
    return (await response.json()) as AssistantSkillSnapshot
  }

  async refreshSkills(): Promise<AssistantSkillSnapshot> {
    await this.request('/v1/skills/refresh', { method: 'POST' })
    return this.getSkillSnapshot()
  }

  async previewLocalSkills(path: string): Promise<AssistantSkillInstallPreview> {
    const response = await this.request('/v1/skills/install/local/preview', {
      method: 'POST',
      body: JSON.stringify({ path })
    })
    return (await response.json()) as AssistantSkillInstallPreview
  }

  async previewGithubSkills(url: string): Promise<AssistantSkillInstallPreview> {
    const response = await this.request('/v1/skills/install/github/preview', {
      method: 'POST',
      body: JSON.stringify({ url })
    })
    return (await response.json()) as AssistantSkillInstallPreview
  }

  async installSkills(previewToken: string, skillIds: string[]): Promise<AssistantSkillSnapshot> {
    const response = await this.request('/v1/skills/install', {
      method: 'POST',
      body: JSON.stringify({ previewToken, skillIds })
    })
    const payload = (await response.json()) as { snapshot: AssistantSkillSnapshot }
    return payload.snapshot
  }

  async setSkillEnabled(skillId: string, enabled: boolean): Promise<boolean> {
    const response = await this.request(
      `/v1/skills/${encodeURIComponent(skillId)}/${enabled ? 'enable' : 'disable'}`,
      { method: 'POST' }
    )
    const payload = (await response.json()) as { updated?: unknown }
    return payload.updated === true
  }

  async uninstallSkill(skillId: string): Promise<boolean> {
    const response = await this.request(`/v1/skills/${encodeURIComponent(skillId)}`, {
      method: 'DELETE'
    })
    const payload = (await response.json()) as { deleted?: unknown }
    return payload.deleted === true
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
    ['message_delta', 'retrieval_sources', 'attachment_sources', 'artifact_created', 'artifact_status', 'skill_started', 'skill_completed', 'skill_error', 'tool_call', 'permission_required', 'tool_result', 'done', 'error'].includes(
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
