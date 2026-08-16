import { shell } from 'electron'
import { logError, logInfo } from '../logger'
import type {
  ManagedAuthErrorCode,
  ManagedAuthState,
  ManagedAuthStatus
} from '../../shared/managed'
import { ManagedFeatureFlags } from './managedFeatureFlags'
import { resolveManagedEndpointPolicy } from './managedEndpointPolicy'
import { ManagedOidcClient, ManagedOidcClientError } from './managedOAuthClient'
import { ManagedOAuthLoopbackError, ManagedOAuthLoopbackSession } from './managedOAuthLoopback'
import type { ManagedEndpointPolicy, ManagedOAuthClient, ManagedTokenSet } from './managedOAuthTypes'

const DEFAULT_STATUS: ManagedAuthStatus = {
  state: 'disabled',
  managedLoginEnabled: false,
  minimumClientVersion: null,
  errorCode: null
}

/**
 * Electron Main 内的 Managed 登录编排器。
 * Renderer 只能看到脱敏状态，Access/Refresh Token 永远不会通过 IPC 返回。
 */
export class ManagedAuthManager {
  private status: ManagedAuthStatus = { ...DEFAULT_STATUS }
  private activeLogin: Promise<ManagedAuthStatus> | null = null
  private loopback: ManagedOAuthLoopbackSession | null = null
  private cancelRequested = false
  private accessToken: string | null = null
  private refreshToken: string | null = null

  private readonly featureFlags: ManagedFeatureFlags
  private readonly oauthClient: ManagedOAuthClient

  constructor(
    private readonly policy: ManagedEndpointPolicy = resolveManagedEndpointPolicy(),
    private readonly clientVersion = '0.2.0',
    dependencies: {
      featureFlags?: ManagedFeatureFlags
      oauthClient?: ManagedOAuthClient
      openExternal?: (url: string) => Promise<void>
    } = {}
  ) {
    this.featureFlags = dependencies.featureFlags || new ManagedFeatureFlags(policy, clientVersion)
    this.oauthClient = dependencies.oauthClient || new ManagedOidcClient(policy.issuer)
    this.openExternal = dependencies.openExternal || ((url) => shell.openExternal(url))
  }

  private readonly openExternal: (url: string) => Promise<void>

  /** 获取只包含登录状态和稳定错误分类的快照。 */
  getStatus(): ManagedAuthStatus {
    return { ...this.status }
  }

  /** 登录前刷新服务端开关，供 Renderer 决定是否展示官方登录入口。 */
  async refreshFeatures(): Promise<ManagedAuthStatus> {
    const features = await this.featureFlags.refresh()
    this.applyFeatureSnapshot(features)
    return this.getStatus()
  }

  /**
   * 启动一次登录；重复点击复用 single-flight Promise，不创建第二个监听器或浏览器窗口。
   */
  login(): Promise<ManagedAuthStatus> {
    if (this.activeLogin) {
      return this.activeLogin
    }
    this.cancelRequested = false
    this.activeLogin = this.runLogin().finally(() => {
      this.activeLogin = null
      this.loopback = null
      this.cancelRequested = false
    })
    return this.activeLogin
  }

  /** 取消当前浏览器授权并清理 loopback 监听器。 */
  cancel(): ManagedAuthStatus {
    if (this.activeLogin) {
      this.cancelRequested = true
      this.loopback?.cancel()
      if (!this.loopback) {
        this.setStatus({ state: 'cancelled', errorCode: 'oauth_cancelled' })
      }
    }
    return this.getStatus()
  }

  /** 应用退出时清除短期内存凭据和回调监听器，但不触碰 P2-07 持久化。 */
  dispose(): void {
    this.cancelRequested = true
    this.loopback?.dispose()
    this.loopback = null
    this.activeLogin = null
    this.accessToken = null
    this.refreshToken = null
  }

  /** 暴露给后续控制面调用的 Main 内存 Access Token，当前不通过 IPC 返回。 */
  getAccessTokenForMain(): string | null {
    return this.accessToken
  }

  /** 执行 Feature Flag、Discovery、浏览器授权、回调校验和 Token Exchange。 */
  private async runLogin(): Promise<ManagedAuthStatus> {
    this.setStatus({ state: 'preparing', errorCode: null })
    const features = await this.featureFlags.refresh()
    if (this.cancelRequested) {
      this.setStatus({ state: 'cancelled', errorCode: 'oauth_cancelled' })
      return this.getStatus()
    }
    this.applyFeatureSnapshot(features, 'preparing')
    if (!features.managedLoginEnabled) {
      return this.getStatus()
    }

    try {
      this.loopback = await ManagedOAuthLoopbackSession.listen()
      const callbackPromise = this.loopback.waitForCallback()
      // Discovery 或浏览器打开失败时仍需消费拒绝，避免应用退出阶段产生未处理 Promise。
      void callbackPromise.catch(() => undefined)
      const preparation = await this.oauthClient.prepare(this.loopback.redirectUri)
      if (this.cancelRequested) {
        throw new ManagedOAuthLoopbackError('cancelled', 'OAuth 登录已取消。')
      }
      this.loopback.setExpectedState(preparation.state)
      this.setStatus({ state: 'waiting_callback', errorCode: null })
      await this.openExternal(preparation.authorizationUrl.href)
      const callbackUrl = await callbackPromise
      this.setStatus({ state: 'exchanging_code', errorCode: null })
      const tokenSet = await preparation.exchange(callbackUrl)
      this.accessToken = tokenSet.accessToken
      this.refreshToken = tokenSet.refreshToken
      this.setStatus({ state: 'authenticated', errorCode: null })
      logInfo('managed OAuth login authenticated')
      return this.getStatus()
    } catch (error) {
      const mapped = mapLoginError(error)
      this.accessToken = null
      this.refreshToken = null
      this.setStatus({ state: mapped.state, errorCode: mapped.errorCode })
      logError('managed OAuth login failed', { errorCode: mapped.errorCode })
      return this.getStatus()
    } finally {
      this.loopback?.dispose()
    }
  }

  /** 仅更新指定字段，避免意外把内部 Token 写进状态。 */
  private setStatus(next: Partial<ManagedAuthStatus>): void {
    this.status = { ...this.status, ...next }
  }

  /** 应用 Feature Flag 脱敏字段，不覆盖已经认证的状态。 */
  private applyFeatureSnapshot(
    features: Awaited<ReturnType<ManagedFeatureFlags['getSnapshot']>>,
    enabledState: ManagedAuthState = 'idle'
  ): void {
    const nextState = features.managedLoginEnabled
      ? (this.status.state === 'authenticated' ? 'authenticated' : enabledState)
      : (this.status.state === 'authenticated' ? 'authenticated' : mapFeatureState(features.errorCode))
    this.setStatus({
      state: nextState,
      managedLoginEnabled: features.managedLoginEnabled,
      minimumClientVersion: features.minimumClientVersion,
      errorCode: features.managedLoginEnabled ? null : features.errorCode
    })
  }
}

/** Feature Flag 关闭、离线和版本不兼容使用不同的稳定状态。 */
function mapFeatureState(errorCode: ManagedAuthErrorCode | null): ManagedAuthState {
  if (errorCode === 'unsupported_client') {
    return 'unsupported_client'
  }
  if (errorCode === 'feature_unavailable') {
    return 'offline'
  }
  return 'disabled'
}

/** 将底层 OIDC/loopback 异常映射为不包含敏感详情的本地错误。 */
function mapLoginError(error: unknown): { state: ManagedAuthState; errorCode: ManagedAuthErrorCode } {
  if (error instanceof ManagedOAuthLoopbackError) {
    if (error.reason === 'cancelled') {
      return { state: 'cancelled', errorCode: 'oauth_cancelled' }
    }
    if (error.reason === 'timed_out') {
      return { state: 'timed_out', errorCode: 'oauth_timeout' }
    }
    return { state: 'failed', errorCode: 'oauth_callback_invalid' }
  }
  if (error instanceof ManagedOidcClientError && error.stage === 'authorization_denied') {
    return { state: 'failed', errorCode: 'oauth_authorization_denied' }
  }
  if (error instanceof ManagedOidcClientError && error.stage === 'discovery') {
    return { state: 'failed', errorCode: 'oauth_discovery_failed' }
  }
  return { state: 'failed', errorCode: 'oauth_token_exchange_failed' }
}

/** 测试和后续流程使用的 Token 类型守卫，当前仅保证 Main 内部类型闭合。 */
export function isManagedTokenSet(value: unknown): value is ManagedTokenSet {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as ManagedTokenSet).accessToken === 'string' &&
      typeof (value as ManagedTokenSet).tokenType === 'string'
  )
}
