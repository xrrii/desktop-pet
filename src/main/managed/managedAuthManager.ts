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
import {
  ElectronManagedTokenStore,
  ManagedTokenStoreError,
  type ManagedTokenStore
} from './managedTokenStore'

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
  private activeRefresh: Promise<ManagedAuthStatus> | null = null
  private loopback: ManagedOAuthLoopbackSession | null = null
  private cancelRequested = false
  private disposed = false
  private accessToken: string | null = null
  private refreshToken: string | null = null
  private pendingTokenSet: ManagedTokenSet | null = null

  private readonly featureFlags: ManagedFeatureFlags
  private readonly oauthClient: ManagedOAuthClient
  private readonly tokenStore: ManagedTokenStore

  constructor(
    private readonly policy: ManagedEndpointPolicy = resolveManagedEndpointPolicy(),
    private readonly clientVersion = '0.2.0',
    dependencies: {
      featureFlags?: ManagedFeatureFlags
      oauthClient?: ManagedOAuthClient
      tokenStore?: ManagedTokenStore
      openExternal?: (url: string) => Promise<void>
      onStatusChange?: (status: ManagedAuthStatus) => void
    } = {}
  ) {
    this.featureFlags = dependencies.featureFlags || new ManagedFeatureFlags(policy, clientVersion)
    this.oauthClient = dependencies.oauthClient || new ManagedOidcClient(policy.issuer)
    this.tokenStore = dependencies.tokenStore || new ElectronManagedTokenStore()
    this.openExternal = dependencies.openExternal || ((url) => shell.openExternal(url))
    this.onStatusChange = dependencies.onStatusChange || (() => undefined)
  }

  private readonly openExternal: (url: string) => Promise<void>
  private readonly onStatusChange: (status: ManagedAuthStatus) => void

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
    if (this.activeRefresh) {
      return this.activeRefresh
    }
    if (this.pendingTokenSet) {
      return this.startRefreshTask(() => this.persistPendingSession())
    }
    this.cancelRequested = false
    this.activeLogin = this.runLogin().finally(() => {
      this.activeLogin = null
      this.loopback = null
      this.cancelRequested = false
    })
    return this.activeLogin
  }

  /** 应用启动或后续 Main 调用时恢复并轮换会话；并发调用只使用一次旧 Refresh Token。 */
  restoreSession(): Promise<ManagedAuthStatus> {
    if (this.activeRefresh) {
      return this.activeRefresh
    }
    if (this.activeLogin) {
      return this.activeLogin
    }
    return this.startRefreshTask(() => this.runSessionRestore())
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

  /** 应用退出时清除短期内存凭据和回调监听器，但保留 safeStorage 密文。 */
  dispose(): void {
    this.disposed = true
    this.cancelRequested = true
    this.loopback?.dispose()
    this.loopback = null
    this.activeLogin = null
    this.activeRefresh = null
    this.accessToken = null
    this.refreshToken = null
    this.pendingTokenSet = null
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
    if (!this.tokenStore.isAvailable()) {
      this.setStatus({ state: 'failed', errorCode: 'managed_token_storage_unavailable' })
      logError('managed OAuth login failed', { errorCode: 'managed_token_storage_unavailable' })
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
      await this.persistTokenSet(tokenSet, 'token_exchange')
      if (this.disposed) {
        return this.getStatus()
      }
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

  /** 从版本化密文恢复 Refresh Token，并在成功轮换和落盘后建立 Main 内存会话。 */
  private async runSessionRestore(): Promise<ManagedAuthStatus> {
    if (this.pendingTokenSet) {
      return this.persistPendingSession()
    }

    const stored = await this.tokenStore.load()
    if (stored.status === 'missing') {
      if (this.status.state === 'restoring_session') {
        this.setStatus({
          state: this.status.managedLoginEnabled ? 'idle' : 'disabled',
          errorCode: this.status.managedLoginEnabled ? null : this.status.errorCode
        })
      }
      return this.getStatus()
    }
    if (stored.status === 'unavailable') {
      this.setStatus({ state: 'failed', errorCode: 'managed_token_storage_unavailable' })
      logError('managed session restore failed', { errorCode: 'managed_token_storage_unavailable' })
      return this.getStatus()
    }
    if (stored.status === 'corrupt') {
      this.setStatus({ state: 'failed', errorCode: 'managed_token_storage_corrupt' })
      logError('managed session restore failed', { errorCode: 'managed_token_storage_corrupt' })
      return this.getStatus()
    }

    this.setStatus({ state: 'restoring_session', errorCode: null })
    try {
      const tokenSet = await this.oauthClient.refresh(stored.refreshToken)
      await this.persistTokenSet(tokenSet, 'refresh')
      if (this.disposed) {
        return this.getStatus()
      }
      this.setStatus({ state: 'authenticated', errorCode: null })
      logInfo('managed session restored')
      return this.getStatus()
    } catch (error) {
      if (isInvalidGrant(error)) {
        this.accessToken = null
        this.refreshToken = null
        this.pendingTokenSet = null
        await this.tokenStore.clear().catch(() => {
          logError('managed invalid session credential cleanup failed', {
            errorCode: 'managed_token_persist_failed'
          })
        })
        this.setStatus({ state: 'reauth_required', errorCode: 'managed_refresh_invalid_grant' })
        logError('managed session restore failed', { errorCode: 'managed_refresh_invalid_grant' })
        return this.getStatus()
      }

      this.accessToken = null
      this.refreshToken = null
      const mapped = mapRefreshError(error)
      this.setStatus({ state: mapped.state, errorCode: mapped.errorCode })
      logError('managed session restore failed', { errorCode: mapped.errorCode })
      return this.getStatus()
    }
  }

  /** 重试保存已由服务端轮换成功的新 Token，不再次提交已经使用过的旧 Refresh Token。 */
  private async persistPendingSession(): Promise<ManagedAuthStatus> {
    const tokenSet = this.pendingTokenSet
    if (!tokenSet) {
      return this.getStatus()
    }
    this.setStatus({ state: 'restoring_session', errorCode: null })
    try {
      await this.persistTokenSet(tokenSet, 'refresh')
      if (!this.disposed) {
        this.setStatus({ state: 'authenticated', errorCode: null })
        logInfo('managed pending session persisted')
      }
    } catch (error) {
      const mapped = mapRefreshError(error)
      this.setStatus({ state: mapped.state, errorCode: mapped.errorCode })
      logError('managed pending session persistence failed', { errorCode: mapped.errorCode })
    }
    return this.getStatus()
  }

  /** 持久化新 Refresh Token 后再替换内存会话，保存失败时保留新 Token 供同进程重试。 */
  private async persistTokenSet(
    tokenSet: ManagedTokenSet,
    stage: 'token_exchange' | 'refresh'
  ): Promise<void> {
    if (!tokenSet.refreshToken) {
      throw new ManagedOidcClientError(stage, 'response_invalid')
    }
    try {
      await this.tokenStore.save(tokenSet.refreshToken)
    } catch (error) {
      this.pendingTokenSet = tokenSet
      throw error
    }
    this.pendingTokenSet = null
    if (!this.disposed) {
      this.accessToken = tokenSet.accessToken
      this.refreshToken = tokenSet.refreshToken
    }
  }

  /** 建立 Refresh Token single-flight，并在完成后释放任务引用。 */
  private startRefreshTask(operation: () => Promise<ManagedAuthStatus>): Promise<ManagedAuthStatus> {
    const task = operation().finally(() => {
      if (this.activeRefresh === task) {
        this.activeRefresh = null
      }
    })
    this.activeRefresh = task
    return task
  }

  /** 仅更新指定字段，避免意外把内部 Token 写进状态。 */
  private setStatus(next: Partial<ManagedAuthStatus>): void {
    this.status = { ...this.status, ...next }
    try {
      this.onStatusChange(this.getStatus())
    } catch {
      logError('managed auth status listener failed')
    }
  }

  /** 应用 Feature Flag 脱敏字段，不覆盖已经认证的状态。 */
  private applyFeatureSnapshot(
    features: Awaited<ReturnType<ManagedFeatureFlags['getSnapshot']>>,
    enabledState: ManagedAuthState = 'idle'
  ): void {
    const preserveSessionState =
      ['authenticated', 'restoring_session', 'reauth_required'].includes(this.status.state) ||
      this.status.errorCode?.startsWith('managed_token_') === true ||
      this.status.errorCode?.startsWith('managed_refresh_') === true
    const nextState = features.managedLoginEnabled
      ? (preserveSessionState ? this.status.state : enabledState)
      : (preserveSessionState ? this.status.state : mapFeatureState(features.errorCode))
    this.setStatus({
      state: nextState,
      managedLoginEnabled: features.managedLoginEnabled,
      minimumClientVersion: features.minimumClientVersion,
      errorCode: preserveSessionState
        ? this.status.errorCode
        : features.managedLoginEnabled ? null : features.errorCode
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
  if (error instanceof ManagedTokenStoreError) {
    return {
      state: 'failed',
      errorCode: error.reason === 'unavailable'
        ? 'managed_token_storage_unavailable'
        : 'managed_token_persist_failed'
    }
  }
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

/** 将刷新与恢复异常映射为不含服务端响应正文的稳定本地状态。 */
function mapRefreshError(error: unknown): { state: ManagedAuthState; errorCode: ManagedAuthErrorCode } {
  if (error instanceof ManagedTokenStoreError) {
    return {
      state: 'failed',
      errorCode: error.reason === 'unavailable'
        ? 'managed_token_storage_unavailable'
        : 'managed_token_persist_failed'
    }
  }
  if (error instanceof ManagedOidcClientError && error.reason === 'response_invalid') {
    return { state: 'failed', errorCode: 'managed_refresh_response_invalid' }
  }
  if (error instanceof ManagedOidcClientError && error.stage === 'discovery') {
    return { state: 'offline', errorCode: 'managed_refresh_failed' }
  }
  return { state: 'offline', errorCode: 'managed_refresh_failed' }
}

/** 检测服务端明确返回的失效、过期、撤销或复用结果。 */
function isInvalidGrant(error: unknown): boolean {
  return error instanceof ManagedOidcClientError &&
    error.stage === 'refresh' &&
    error.reason === 'invalid_grant'
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
