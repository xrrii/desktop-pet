import { describe, expect, it } from 'vitest'
import { ManagedAuthManager } from './managedAuthManager'
import type { ManagedAuthorizationPreparation, ManagedEndpointPolicy, ManagedOAuthClient } from './managedOAuthTypes'
import type { ManagedFeatureSnapshot } from './managedFeatureFlags'
import type { ManagedTokenSet } from './managedOAuthTypes'

const policy: ManagedEndpointPolicy = {
  environment: 'local-mock',
  issuer: new URL('http://127.0.0.1:18080'),
  controlPlaneBaseUrl: new URL('http://127.0.0.1:18081')
}

class FakeFeatureFlags {
  async refresh(): Promise<ManagedFeatureSnapshot> {
    return { managedLoginEnabled: true, minimumClientVersion: '0.2.0', errorCode: null }
  }
}

describe('ManagedAuthManager', () => {
  it('登录前可以通过匿名 Feature Flag 刷新入口状态', async () => {
    const manager = new ManagedAuthManager(policy, '0.2.0', {
      featureFlags: new FakeFeatureFlags() as never
    })

    await expect(manager.refreshFeatures()).resolves.toMatchObject({
      state: 'idle',
      managedLoginEnabled: true,
      minimumClientVersion: '0.2.0'
    })
  })

  it('通过系统浏览器回调完成登录，Renderer 只收到状态且重复点击复用任务', async () => {
    const oauthClient: ManagedOAuthClient = {
      async prepare(redirectUri: string): Promise<ManagedAuthorizationPreparation> {
        return {
          authorizationUrl: new URL(
            `http://127.0.0.1:18080/oauth2/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=manager-state`
          ),
          state: 'manager-state',
          async exchange(callbackUrl: URL): Promise<ManagedTokenSet> {
            expect(callbackUrl.searchParams.get('code')).toBe('mock-code')
            return {
              accessToken: 'access-token-in-main',
              refreshToken: 'refresh-token-in-main',
              tokenType: 'Bearer',
              expiresIn: 300,
              scope: 'openid desktop.session',
              idToken: 'id-token-in-main'
            }
          }
        }
      }
    }
    const manager = new ManagedAuthManager(policy, '0.2.0', {
      featureFlags: new FakeFeatureFlags() as never,
      oauthClient,
      openExternal: async (url) => {
        const authorization = new URL(url)
        const redirect = authorization.searchParams.get('redirect_uri')
        if (!redirect) throw new Error('redirect missing')
        await fetch(`${redirect}?code=mock-code&state=${authorization.searchParams.get('state') || 'manager-state'}`)
      }
    })

    const first = manager.login()
    const second = manager.login()
    expect(first).toBe(second)
    await expect(first).resolves.toMatchObject({ state: 'authenticated' })
    expect(manager.getStatus()).not.toHaveProperty('accessToken')
    expect(manager.getAccessTokenForMain()).toBe('access-token-in-main')
    manager.dispose()
  })

  it('Feature Flag 关闭时不打开浏览器', async () => {
    let opened = false
    const manager = new ManagedAuthManager(policy, '0.2.0', {
      featureFlags: {
        async refresh(): Promise<ManagedFeatureSnapshot> {
          return { managedLoginEnabled: false, minimumClientVersion: '0.2.0', errorCode: 'managed_login_disabled' }
        }
      } as never,
      openExternal: async () => {
        opened = true
      }
    })

    await expect(manager.login()).resolves.toMatchObject({
      state: 'disabled',
      errorCode: 'managed_login_disabled'
    })
    expect(opened).toBe(false)
  })
})
