import { describe, expect, it, vi } from 'vitest'
import type { ManagedEndpointPolicy } from './managedOAuthTypes'
import { ManagedControlPlaneClient, ManagedControlPlaneError } from './managedControlPlaneClient'

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
        responseBody: '不应传播'
      }
    }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
    const client = new ManagedControlPlaneClient(POLICY, '0.2.0', fetcher)

    await expect(client.getCurrentDevice('synthetic-access-token')).rejects.toMatchObject({
      name: 'ManagedControlPlaneError',
      status: 404,
      code: 'device_not_found',
      retryable: false,
      requestId: '45bb9edb-c3bb-4fa9-9a13-60611343aaf4'
    } satisfies Partial<ManagedControlPlaneError>)
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
