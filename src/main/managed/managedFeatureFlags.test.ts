import { describe, expect, it } from 'vitest'
import { ManagedFeatureFlags, isVersionAtLeast } from './managedFeatureFlags'
import type { ManagedEndpointPolicy } from './managedOAuthTypes'

const policy: ManagedEndpointPolicy = {
  environment: 'local-mock',
  issuer: new URL('http://127.0.0.1:8080'),
  controlPlaneBaseUrl: new URL('http://127.0.0.1:8080')
}

describe('ManagedFeatureFlags', () => {
  it('匿名读取并接受契约版本', async () => {
    const flags = new ManagedFeatureFlags(policy, '0.2.0', async () =>
      new Response(JSON.stringify({
        version: 1,
        managed_login_enabled: true,
        minimum_client_version: '0.2.0'
      }), { status: 200 })
    )

    await expect(flags.refresh()).resolves.toMatchObject({
      managedLoginEnabled: true,
      minimumClientVersion: '0.2.0',
      errorCode: null
    })
  })

  it('服务不可用、字段错误和最低版本不满足都安全关闭', async () => {
    const unavailable = new ManagedFeatureFlags(policy, '0.2.0', async () => new Response('', { status: 503 }))
    await expect(unavailable.refresh()).resolves.toMatchObject({
      managedLoginEnabled: false,
      errorCode: 'feature_unavailable'
    })

    const invalid = new ManagedFeatureFlags(policy, '0.2.0', async () =>
      new Response(JSON.stringify({ version: 2 }), { status: 200 })
    )
    await expect(invalid.refresh()).resolves.toMatchObject({ errorCode: 'feature_unavailable' })

    const unsupported = new ManagedFeatureFlags(policy, '0.1.1', async () =>
      new Response(JSON.stringify({
        version: 1,
        managed_login_enabled: true,
        minimum_client_version: '0.2.0'
      }), { status: 200 })
    )
    await expect(unsupported.refresh()).resolves.toMatchObject({ errorCode: 'unsupported_client' })
  })

  it('semver 比较正确处理预发布版本', () => {
    expect(isVersionAtLeast('0.2.0', '0.2.0')).toBe(true)
    expect(isVersionAtLeast('0.2.1', '0.2.0')).toBe(true)
    expect(isVersionAtLeast('0.1.9', '0.2.0')).toBe(false)
    expect(isVersionAtLeast('0.2.0-beta.1', '0.2.0')).toBe(false)
  })
})
