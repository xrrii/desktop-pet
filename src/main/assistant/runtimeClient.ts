import type { AssistantEvent, AssistantRequest, AssistantRuntimeReady } from '../../shared/assistant'

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
    ['message_delta', 'tool_call', 'permission_required', 'tool_result', 'done', 'error'].includes(
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
