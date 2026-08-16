import { describe, expect, it } from 'vitest'
import { ManagedAuthManager } from './managedAuthManager'
import { ManagedOidcClientError } from './managedOAuthClient'
import type { ManagedFeatureSnapshot } from './managedFeatureFlags'
import type {
  ManagedAuthorizationPreparation,
  ManagedEndpointPolicy,
  ManagedOAuthClient,
  ManagedTokenSet
} from './managedOAuthTypes'
import {
  ManagedTokenStoreError,
  type ManagedTokenLoadResult,
  type ManagedTokenStore
} from './managedTokenStore'

const policy: ManagedEndpointPolicy = {
  environment: 'local-mock',
  issuer: new URL('http://127.0.0.1:18080'),
  controlPlaneBaseUrl: new URL('http://127.0.0.1:18081')
}

class FakeFeatureFlags {
  /** 返回始终开启的合成 Feature Flag。 */
  async refresh(): Promise<ManagedFeatureSnapshot> {
    return { managedLoginEnabled: true, minimumClientVersion: '0.2.0', errorCode: null }
  }
}

/** 模拟版本化 Token Store，并记录持久化顺序和清理行为。 */
class FakeTokenStore implements ManagedTokenStore {
  available = true
  loadResult: ManagedTokenLoadResult = { status: 'missing' }
  saved: string[] = []
  clearCount = 0
  saveFailures = 0

  /** 返回测试设置的安全存储可用性。 */
  isAvailable(): boolean {
    return this.available
  }

  /** 返回测试设置的持久化读取结果。 */
  async load(): Promise<ManagedTokenLoadResult> {
    return this.loadResult
  }

  /** 保存轮换 Token，或按测试设置模拟一次原子写入失败。 */
  async save(refreshToken: string): Promise<void> {
    if (this.saveFailures > 0) {
      this.saveFailures -= 1
      throw new ManagedTokenStoreError('write_failed')
    }
    this.saved.push(refreshToken)
    this.loadResult = { status: 'available', refreshToken }
  }

  /** 模拟幂等删除持久化 Token。 */
  async clear(): Promise<void> {
    this.clearCount += 1
    this.loadResult = { status: 'missing' }
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

  it('登录时先持久化 Refresh Token，再向 Renderer 发布认证状态', async () => {
    const tokenStore = new FakeTokenStore()
    const statuses: string[] = []
    const oauthClient: ManagedOAuthClient = {
      async prepare(redirectUri: string): Promise<ManagedAuthorizationPreparation> {
        return {
          authorizationUrl: new URL(
            `http://127.0.0.1:18080/oauth2/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=manager-state`
          ),
          state: 'manager-state',
          async exchange(callbackUrl: URL): Promise<ManagedTokenSet> {
            expect(callbackUrl.searchParams.get('code')).toBe('mock-code')
            return tokenSet('access-token-in-main', 'refresh-token-in-main')
          }
        }
      },
      async refresh(): Promise<ManagedTokenSet> {
        throw new Error('本测试不应刷新 Token。')
      }
    }
    const manager = new ManagedAuthManager(policy, '0.2.0', {
      featureFlags: new FakeFeatureFlags() as never,
      oauthClient,
      tokenStore,
      onStatusChange: (status) => statuses.push(status.state),
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
    expect(tokenStore.saved).toEqual(['refresh-token-in-main'])
    expect(statuses.at(-1)).toBe('authenticated')
    expect(manager.getStatus()).not.toHaveProperty('accessToken')
    expect(manager.getAccessTokenForMain()).toBe('access-token-in-main')
    manager.dispose()
  })

  it('safeStorage 不可用时不打开浏览器或产生不可恢复会话', async () => {
    let opened = false
    const tokenStore = new FakeTokenStore()
    tokenStore.available = false
    const manager = new ManagedAuthManager(policy, '0.2.0', {
      featureFlags: new FakeFeatureFlags() as never,
      tokenStore,
      openExternal: async () => {
        opened = true
      }
    })

    await expect(manager.login()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'managed_token_storage_unavailable'
    })
    expect(opened).toBe(false)
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

  it('启动恢复只使用一次旧 Token，并持久化轮换后的新 Token', async () => {
    const tokenStore = new FakeTokenStore()
    tokenStore.loadResult = { status: 'available', refreshToken: 'old-refresh-token' }
    let refreshCount = 0
    const manager = new ManagedAuthManager(policy, '0.2.0', {
      tokenStore,
      oauthClient: oauthClientWithRefresh(async (refreshToken) => {
        refreshCount += 1
        expect(refreshToken).toBe('old-refresh-token')
        return tokenSet('restored-access-token', 'rotated-refresh-token')
      })
    })

    const first = manager.restoreSession()
    const second = manager.restoreSession()

    expect(first).toBe(second)
    await expect(first).resolves.toMatchObject({ state: 'authenticated' })
    expect(refreshCount).toBe(1)
    expect(tokenStore.saved).toEqual(['rotated-refresh-token'])
    expect(manager.getAccessTokenForMain()).toBe('restored-access-token')
    manager.dispose()
    expect(tokenStore.clearCount).toBe(0)
  })

  it('没有持久化会话时不调用 Token Endpoint', async () => {
    const tokenStore = new FakeTokenStore()
    let refreshCount = 0
    const manager = new ManagedAuthManager(policy, '0.2.0', {
      tokenStore,
      oauthClient: oauthClientWithRefresh(async () => {
        refreshCount += 1
        return tokenSet('unexpected-access-token', 'unexpected-refresh-token')
      })
    })

    await expect(manager.restoreSession()).resolves.toMatchObject({ state: 'disabled' })
    expect(refreshCount).toBe(0)
  })

  it('临时网络失败保留原 Refresh Token，供下次恢复重试', async () => {
    const tokenStore = new FakeTokenStore()
    tokenStore.loadResult = { status: 'available', refreshToken: 'still-valid-refresh-token' }
    const manager = new ManagedAuthManager(policy, '0.2.0', {
      tokenStore,
      oauthClient: oauthClientWithRefresh(async () => {
        throw new ManagedOidcClientError('refresh', 'network')
      })
    })

    await expect(manager.restoreSession()).resolves.toMatchObject({
      state: 'offline',
      errorCode: 'managed_refresh_failed'
    })
    expect(tokenStore.loadResult).toEqual({
      status: 'available',
      refreshToken: 'still-valid-refresh-token'
    })
    expect(tokenStore.clearCount).toBe(0)
  })

  it('invalid_grant 清理本地凭据并要求重新登录', async () => {
    const tokenStore = new FakeTokenStore()
    tokenStore.loadResult = { status: 'available', refreshToken: 'revoked-refresh-token' }
    const manager = new ManagedAuthManager(policy, '0.2.0', {
      tokenStore,
      oauthClient: oauthClientWithRefresh(async () => {
        throw new ManagedOidcClientError('refresh', 'invalid_grant')
      })
    })

    await expect(manager.restoreSession()).resolves.toMatchObject({
      state: 'reauth_required',
      errorCode: 'managed_refresh_invalid_grant'
    })
    expect(tokenStore.clearCount).toBe(1)
    expect(manager.getAccessTokenForMain()).toBeNull()
  })

  it('服务端轮换成功但首次落盘失败时，只重试保存新 Token', async () => {
    const tokenStore = new FakeTokenStore()
    tokenStore.loadResult = { status: 'available', refreshToken: 'old-refresh-token' }
    tokenStore.saveFailures = 1
    let refreshCount = 0
    const manager = new ManagedAuthManager(policy, '0.2.0', {
      tokenStore,
      oauthClient: oauthClientWithRefresh(async () => {
        refreshCount += 1
        return tokenSet('rotated-access-token', 'rotated-refresh-token')
      })
    })

    await expect(manager.restoreSession()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'managed_token_persist_failed'
    })
    await expect(manager.restoreSession()).resolves.toMatchObject({ state: 'authenticated' })

    expect(refreshCount).toBe(1)
    expect(tokenStore.saved).toEqual(['rotated-refresh-token'])
    expect(manager.getAccessTokenForMain()).toBe('rotated-access-token')
  })

  it('密文损坏时不调用 Token Endpoint', async () => {
    const tokenStore = new FakeTokenStore()
    tokenStore.loadResult = { status: 'corrupt' }
    let refreshCount = 0
    const manager = new ManagedAuthManager(policy, '0.2.0', {
      tokenStore,
      oauthClient: oauthClientWithRefresh(async () => {
        refreshCount += 1
        return tokenSet('unexpected-access-token', 'unexpected-refresh-token')
      })
    })

    await expect(manager.restoreSession()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'managed_token_storage_corrupt'
    })
    expect(refreshCount).toBe(0)
  })

  it('刷新响应缺少新 Refresh Token 时保留旧密文但拒绝认证', async () => {
    const tokenStore = new FakeTokenStore()
    tokenStore.loadResult = { status: 'available', refreshToken: 'old-refresh-token' }
    const manager = new ManagedAuthManager(policy, '0.2.0', {
      tokenStore,
      oauthClient: oauthClientWithRefresh(async () => tokenSet('new-access-token', null))
    })

    await expect(manager.restoreSession()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'managed_refresh_response_invalid'
    })
    expect(tokenStore.saved).toEqual([])
    expect(tokenStore.loadResult).toEqual({
      status: 'available',
      refreshToken: 'old-refresh-token'
    })
    expect(manager.getAccessTokenForMain()).toBeNull()
  })
})

/** 构造只支持刷新路径的 OAuth 测试替身。 */
function oauthClientWithRefresh(
  refresh: (refreshToken: string) => Promise<ManagedTokenSet>
): ManagedOAuthClient {
  return {
    async prepare(): Promise<ManagedAuthorizationPreparation> {
      throw new Error('本测试不应准备浏览器授权。')
    },
    refresh
  }
}

/** 构造不含真实凭据的合成 Token Response。 */
function tokenSet(accessToken: string, refreshToken: string | null): ManagedTokenSet {
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: 300,
    scope: 'openid desktop.session',
    idToken: null
  }
}
