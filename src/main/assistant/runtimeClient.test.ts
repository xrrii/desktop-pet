import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantEvent } from '../../shared/assistant'
import {
  AssistantRuntimeClient,
  consumeSseBuffer,
  type ManagedAuthRefreshRequiredEvent
} from './runtimeClient'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AssistantRuntimeClient Managed Session', () => {
  it('使用本地启动令牌更新并查询脱敏 Session 状态', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        configured: true,
        expiresAt: '2026-08-16T00:15:00Z',
        capabilitySnapshotVersion: 3
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    const client = runtimeClient()

    await client.updateManagedSession({
      accessToken: 'synthetic-runtime-access-token-value-0001',
      expiresAt: '2026-08-16T00:15:00Z',
      capabilitySnapshotVersion: 3
    })
    await expect(client.getManagedSessionStatus()).resolves.toEqual({
      configured: true,
      expiresAt: '2026-08-16T00:15:00Z',
      capabilitySnapshotVersion: 3
    })

    expect(String(fetcher.mock.calls[0][0])).toBe('http://127.0.0.1:3210/v1/managed/session')
    expect((fetcher.mock.calls[0][1]?.headers as Headers).get('Authorization'))
      .toBe('Bearer local-runtime-start-token')
  })

  it('拒绝 configured 与空字段不一致的 Runtime 状态', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      configured: true,
      expiresAt: null,
      capabilitySnapshotVersion: null
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(runtimeClient().getManagedSessionStatus())
      .rejects.toThrow('无效的 Managed Session 状态')
  })
})

describe('consumeSseBuffer', () => {
  it('parses complete events and keeps an incomplete remainder', () => {
    const events: AssistantEvent[] = []
    const complete = JSON.stringify({
      protocolVersion: 1,
      taskId: 'task-1',
      sequence: 1,
      type: 'message_delta',
      payload: { delta: 'hello' }
    })

    const remainder = consumeSseBuffer(
      `data: ${complete}\n\ndata: {"protocolVersion":1`,
      'task-1',
      (event) => events.push(event)
    )

    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ delta: 'hello' })
    expect(remainder).toBe('data: {"protocolVersion":1')
  })

  it('rejects events for another task', () => {
    const event = JSON.stringify({
      protocolVersion: 1,
      taskId: 'other-task',
      sequence: 1,
      type: 'done',
      payload: { finishReason: 'stop' }
    })

    expect(() => consumeSseBuffer(`data: ${event}\n\n`, 'task-1', () => undefined)).toThrow(
      'invalid assistant event'
    )
  })

  it('接受结构化网页来源事件', () => {
    const events: AssistantEvent[] = []
    const event = JSON.stringify({
      protocolVersion: 1,
      taskId: 'task-1',
      sequence: 2,
      type: 'web_sources',
      payload: { sources: [] }
    })

    expect(consumeSseBuffer(`data: ${event}\n\n`, 'task-1', (value) => events.push(value))).toBe('')
    expect(events[0].type).toBe('web_sources')
  })

  it('把认证刷新控制事件分流给 Main 而不进入普通事件', () => {
    const events: AssistantEvent[] = []
    const controls: ManagedAuthRefreshRequiredEvent[] = []
    const control = JSON.stringify({
      eventVersion: 1,
      type: 'managed_auth_refresh_required',
      sequence: 4,
      taskId: '7a70c803-f62f-4418-81c6-905f848322f1',
      traceId: 'dcecb768-9ff5-4ca4-a10b-6a725695ab5b',
      requestId: '54ca903e-23da-42bb-a69b-125f3669962b',
      reason: 'token_expired',
      outputStarted: false
    })

    expect(consumeSseBuffer(
      `data: ${control}\n\n`,
      '7a70c803-f62f-4418-81c6-905f848322f1',
      (event) => events.push(event),
      (event) => controls.push(event)
    )).toBe('')
    expect(events).toEqual([])
    expect(controls).toHaveLength(1)
  })

  it('拒绝已开始输出的认证刷新控制事件', () => {
    const control = JSON.stringify({
      eventVersion: 1,
      type: 'managed_auth_refresh_required',
      sequence: 4,
      taskId: '7a70c803-f62f-4418-81c6-905f848322f1',
      traceId: 'dcecb768-9ff5-4ca4-a10b-6a725695ab5b',
      requestId: '54ca903e-23da-42bb-a69b-125f3669962b',
      reason: 'token_expired',
      outputStarted: true
    })

    expect(() => consumeSseBuffer(
      `data: ${control}\n\n`,
      '7a70c803-f62f-4418-81c6-905f848322f1',
      () => undefined,
      () => undefined
    )).toThrow('invalid assistant event')
  })
})

function runtimeClient(): AssistantRuntimeClient {
  return new AssistantRuntimeClient({
    type: 'ready',
    protocolVersion: 1,
    port: 3210,
    pid: 1234,
    backend: 'mock'
  }, 'local-runtime-start-token')
}
