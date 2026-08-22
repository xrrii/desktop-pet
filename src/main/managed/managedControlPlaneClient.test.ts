import { describe, expect, it, vi } from 'vitest'
import type { ManagedEndpointPolicy } from './managedOAuthTypes'
import { ManagedControlPlaneClient, ManagedControlPlaneError } from './managedControlPlaneClient'
import { ManagedServerClock } from './managedServerClock'

const POLICY: ManagedEndpointPolicy = {
  environment: 'local-mock',
  issuer: new URL('http://127.0.0.1:18080'),
  controlPlaneBaseUrl: new URL('http://127.0.0.1:18080')
}

describe('ManagedControlPlaneClient', () => {
  it('查询当前设备时附加认证、版本和 UUID 请求头', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(devicePayload()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    const client = new ManagedControlPlaneClient(POLICY, '0.2.0', fetcher)

    const result = await client.getCurrentDevice('synthetic-access-token')

    expect(result.id).toBe('a01715d2-42e3-4abe-a348-708dda38ab0d')
    const [url, options] = fetcher.mock.calls[0]
    expect(String(url)).toBe('http://127.0.0.1:18080/api/v1/devices/current')
    expect(options?.headers).toMatchObject({
      Authorization: 'Bearer synthetic-access-token',
      'X-PetDock-Client-Version': '0.2.0'
    })
    expect((options?.headers as Record<string, string>)['X-PetDock-Request-Id'])
      .toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('只解析 ErrorEnvelope 稳定字段并保留 device_not_found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'device_not_found',
        message: '合成消息',
        requestId: '45bb9edb-c3bb-4fa9-9a13-60611343aaf4',
        retryable: false,
        retryAfterSeconds: 30,
        responseBody: '不应传播'
      }
    }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
    const client = new ManagedControlPlaneClient(POLICY, '0.2.0', fetcher)

    await expect(client.getCurrentDevice('synthetic-access-token')).rejects.toMatchObject({
      name: 'ManagedControlPlaneError',
      status: 404,
      code: 'device_not_found',
      retryable: false,
      requestId: '45bb9edb-c3bb-4fa9-9a13-60611343aaf4',
      retryAfterSeconds: 30
    } satisfies Partial<ManagedControlPlaneError>)
  })

  it('成功和错误响应都会用标准 Date 更新共享时钟', async () => {
    const localTimes = [
      Date.parse('2026-08-16T00:00:00Z'),
      Date.parse('2026-08-16T00:00:00Z')
    ]
    const clock = new ManagedServerClock(() => localTimes.shift() ?? Date.parse('2026-08-16T00:00:00Z'))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(devicePayload()), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        Date: 'Sun, 16 Aug 2026 00:00:20 GMT'
      }
    }))
    const client = new ManagedControlPlaneClient(POLICY, '0.2.0', fetcher, clock)

    await client.getCurrentDevice('synthetic-access-token')

    expect(client.getServerClock()).toBe(clock)
    expect(clock.getSnapshot()).toEqual({ offsetMs: 20_000, trusted: true })
  })

  it('撤销设备只接受 Main 提供的路径参数并处理 204', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const client = new ManagedControlPlaneClient(POLICY, '0.2.0', fetcher)

    await client.revokeDevice('synthetic-access-token', 'a01715d2-42e3-4abe-a348-708dda38ab0d')

    expect(String(fetcher.mock.calls[0][0]))
      .toBe('http://127.0.0.1:18080/api/v1/devices/a01715d2-42e3-4abe-a348-708dda38ab0d')
    expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE')
  })

  it('拒绝字段不完整的设备响应', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ...devicePayload(),
      id: 'not-a-uuid'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = new ManagedControlPlaneClient(POLICY, '0.2.0', fetcher)

    await expect(client.getCurrentDevice('synthetic-access-token')).rejects.toMatchObject({
      code: 'internal_error'
    })
  })

  it('创建 Runtime Session 时严格校验响应并保留 Entitlement 版本', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(runtimeSessionPayload()), {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    }))
    const client = new ManagedControlPlaneClient(POLICY, '0.2.0', fetcher)

    await expect(client.createRuntimeSession(
      'synthetic-access-token',
      'a01715d2-42e3-4abe-a348-708dda38ab0d'
    )).resolves.toMatchObject({
      sessionId: '039f8b64-dc93-4b7f-a94d-cf88400f2615',
      tokenType: 'Bearer',
      entitlementVersion: 3
    })
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ deviceId: 'a01715d2-42e3-4abe-a348-708dda38ab0d' })
    })
  })

  it('拒绝过期时间早于签发时间的 Runtime Session 响应', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ...runtimeSessionPayload(),
      expiresAt: '2026-08-16T00:00:00Z'
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    const client = new ManagedControlPlaneClient(POLICY, '0.2.0', fetcher)

    await expect(client.createRuntimeSession(
      'synthetic-access-token',
      'a01715d2-42e3-4abe-a348-708dda38ab0d'
    )).rejects.toMatchObject({ code: 'internal_error' })
  })

  it('撤销 Runtime Session 使用路径 ID并处理 204', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const client = new ManagedControlPlaneClient(POLICY, '0.2.0', fetcher)

    await client.revokeRuntimeSession(
      'synthetic-access-token',
      '039f8b64-dc93-4b7f-a94d-cf88400f2615'
    )

    expect(String(fetcher.mock.calls[0][0]))
      .toBe('http://127.0.0.1:18080/api/v1/runtime-sessions/039f8b64-dc93-4b7f-a94d-cf88400f2615')
    expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE')
  })

  it('读取用量摘要时只保留公共额度字段', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      billingMode: 'subscription',
      periodStart: '2026-08-01T00:00:00Z',
      periodEnd: '2026-09-01T00:00:00Z',
      capabilities: { chat: { quotaMode: 'quota', used: 12, remaining: 88, unit: 'tokens' } }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = new ManagedControlPlaneClient(POLICY, '0.2.0', fetcher)

    await expect(client.getUsageSummary('synthetic-access-token')).resolves.toMatchObject({
      capabilities: { chat: { used: 12, remaining: 88, unit: 'tokens' } }
    })
    expect(String(fetcher.mock.calls[0][0])).toContain('/api/v1/usage/summary')
  })
})

/** 返回不含敏感字段的合成设备响应。 */
function devicePayload(): Record<string, unknown> {
  return {
    id: 'a01715d2-42e3-4abe-a348-708dda38ab0d',
    displayName: 'Windows Desktop',
    current: true,
    status: 'active',
    createdAt: '2026-08-16T00:00:00Z',
    lastSeenAt: '2026-08-16T00:00:00Z'
  }
}

/** 返回固定 15 分钟有效期的合成 Runtime Session。 */
function runtimeSessionPayload(): Record<string, unknown> {
  return {
    sessionId: '039f8b64-dc93-4b7f-a94d-cf88400f2615',
    accessToken: 'synthetic-runtime-access-token-value-0001',
    tokenType: 'Bearer',
    issuedAt: '2026-08-16T00:00:00Z',
    expiresAt: '2026-08-16T00:15:00Z',
    entitlementVersion: 3
  }
}
