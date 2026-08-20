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
import { ManagedControlPlaneError, ManagedControlPlaneClient } from './managedControlPlaneClient'
import {
  ManagedAccountSessionManager,
  type ManagedAccountSessionSnapshot
} from './managedAccountSessionManager'
import { ManagedDeviceIdentityManager } from './managedDeviceIdentityManager'
import { ManagedRuntimeTokenBroker } from './managedRuntimeTokenBroker'
import { ManagedRefreshCoordinator } from './managedRefreshCoordinator'
import { ManagedServerClock } from './managedServerClock'
import {
  ElectronManagedTokenStore,
  ManagedTokenStoreError,
  type ManagedTokenStore
} from './managedTokenStore'

const DEFAULT_STATUS: ManagedAuthStatus = {
  state: 'disabled',
  managedLoginEnabled: false,
  minimumClientVersion: null,
  errorCode: null,
  sessionSyncState: 'idle',
  runtimeSessionState: 'idle',
  runtimeSessionErrorCode: null,
  account: null,
  device: null
}

/**
 * Electron Main 内的 Managed 登录编排器。
 * Renderer 只能看到脱敏状态，Access/Refresh Token 永远不会通过 IPC 返回。
 */
export class ManagedAuthManager {
  private status: ManagedAuthStatus = { ...DEFAULT_STATUS }
  private activeLogin: Promise<ManagedAuthStatus> | null = null
  private activeRefresh: Promise<ManagedAuthStatus> | null = null
  private activeSessionCommand: Promise<ManagedAuthStatus> | null = null
  private loopback: ManagedOAuthLoopbackSession | null = null
  private cancelRequested = false
  private disposed = false
  private accessToken: string | null = null
  private accessTokenExpiresAt: number | null = null
  private refreshToken: string | null = null
  private pendingTokenSet: ManagedTokenSet | null = null
  private sessionSnapshot: ManagedAccountSessionSnapshot | null = null
  private activeTerminalCleanup: Promise<void> | null = null

  private readonly featureFlags: ManagedFeatureFlags
  private readonly oauthClient: ManagedOAuthClient
  private readonly tokenStore: ManagedTokenStore
  private readonly accountSessionManager: ManagedAccountSessionManager | null
  private readonly deviceIdentityManager: ManagedDeviceIdentityManager | null
  private readonly runtimeTokenBroker: ManagedRuntimeTokenBroker | null
  private readonly serverClock: ManagedServerClock
  private readonly refreshCoordinator = new ManagedRefreshCoordinator<ManagedTokenSet>()

  constructor(
    private readonly policy: ManagedEndpointPolicy = resolveManagedEndpointPolicy(),
    private readonly clientVersion = '0.2.0',
    dependencies: {
      featureFlags?: ManagedFeatureFlags
      oauthClient?: ManagedOAuthClient
      tokenStore?: ManagedTokenStore
      accountSessionManager?: ManagedAccountSessionManager
      runtimeTokenBroker?: ManagedRuntimeTokenBroker
      serverClock?: ManagedServerClock
      openExternal?: (url: string) => Promise<void>
      onStatusChange?: (status: ManagedAuthStatus) => void
    } = {}
  ) {
    this.serverClock = dependencies.serverClock || new ManagedServerClock()
    this.featureFlags = dependencies.featureFlags || new ManagedFeatureFlags(policy, clientVersion)
    const oauthClient = dependencies.oauthClient || new ManagedOidcClient(policy.issuer)
    this.oauthClient = oauthClient
    this.tokenStore = dependencies.tokenStore || new ElectronManagedTokenStore()
    const supportsManagedSession = Boolean(oauthClient.fetchUserInfo && oauthClient.revokeRefreshToken)
    this.deviceIdentityManager = !dependencies.accountSessionManager && supportsManagedSession
      ? new ManagedDeviceIdentityManager(policy.issuer)
      : null
    this.accountSessionManager = dependencies.accountSessionManager || (
      oauthClient.fetchUserInfo && oauthClient.revokeRefreshToken && this.deviceIdentityManager
        ? new ManagedAccountSessionManager(
            oauthClient,
            new ManagedControlPlaneClient(policy, clientVersion, undefined, this.serverClock),
            this.deviceIdentityManager
          )
        : null
    )
    this.openExternal = dependencies.openExternal || ((url) => shell.openExternal(url))
    this.onStatusChange = dependencies.onStatusChange || (() => undefined)
    this.runtimeTokenBroker = dependencies.runtimeTokenBroker || null
    this.runtimeTokenBroker?.setStatusListener((runtimeStatus) => {
      this.setStatus({
        runtimeSessionState: runtimeStatus.state,
        runtimeSessionErrorCode: runtimeStatus.errorCode
      })
    })
    this.runtimeTokenBroker?.setTerminalErrorListener?.((error) => {
      this.handleRuntimeTerminalError(error)
    })
  }

  private readonly openExternal: (url: string) => Promise<void>
  private readonly onStatusChange: (status: ManagedAuthStatus) => void

  /** 获取只包含登录状态和稳定错误分类的快照。 */
  getStatus(): ManagedAuthStatus {
    return {
      ...this.status,
      account: this.status.account ? { ...this.status.account } : null,
      device: this.status.device ? { ...this.status.device } : null
    }
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
    if (this.activeTerminalCleanup) {
      return this.activeTerminalCleanup.then(() => this.login())
    }
    if (this.refreshCoordinator.isActive()) {
      return this.startRefreshTask(async () => {
        await this.refreshCoordinator.waitForIdle()
        return this.getStatus()
      })
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
    if (this.activeSessionCommand) {
      return this.activeSessionCommand.then(() => this.restoreSession())
    }
    if (this.activeTerminalCleanup) {
      return this.activeTerminalCleanup.then(() => this.restoreSession())
    }
    if (this.refreshCoordinator.isActive()) {
      return this.startRefreshTask(async () => {
        await this.refreshCoordinator.waitForIdle()
        if (this.accessToken && this.refreshToken) {
          return this.getStatus()
        }
        return this.runSessionRestore()
      })
    }
    return this.startRefreshTask(() => this.runSessionRestore())
  }

  /** 撤销当前桌面会话的 Refresh Token，并在服务端确认后清理本地凭据。 */
  logout(): Promise<ManagedAuthStatus> {
    if (this.activeSessionCommand) {
      return this.activeSessionCommand
    }
    if (this.activeLogin) {
      return this.activeLogin.then(() => this.logout())
    }
    if (this.activeTerminalCleanup) {
      return this.activeTerminalCleanup.then(() => this.logout())
    }
    if (this.activeRefresh) {
      return this.activeRefresh.then(() => this.logout())
    }
    if (this.refreshCoordinator.isActive()) {
      return this.refreshCoordinator.waitForIdle().then(() => this.logout())
    }
    this.activeSessionCommand = this.runLogout().finally(() => {
      this.activeSessionCommand = null
    })
    return this.activeSessionCommand
  }

  /** 撤销当前设备及其服务端授权关联，禁止 Renderer 指定任意设备 ID。 */
  revokeCurrentDevice(): Promise<ManagedAuthStatus> {
    if (this.activeSessionCommand) {
      return this.activeSessionCommand
    }
    if (this.activeLogin) {
      return this.activeLogin.then(() => this.revokeCurrentDevice())
    }
    if (this.activeTerminalCleanup) {
      return this.activeTerminalCleanup.then(() => this.revokeCurrentDevice())
    }
    if (this.activeRefresh) {
      return this.activeRefresh.then(() => this.revokeCurrentDevice())
    }
    if (this.refreshCoordinator.isActive()) {
      return this.refreshCoordinator.waitForIdle().then(() => this.revokeCurrentDevice())
    }
    this.activeSessionCommand = this.runRevokeCurrentDevice().finally(() => {
      this.activeSessionCommand = null
    })
    return this.activeSessionCommand
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
    this.activeSessionCommand = null
    this.runtimeTokenBroker?.dispose()
    this.accessToken = null
    this.accessTokenExpiresAt = null
    this.refreshToken = null
    this.pendingTokenSet = null
    this.sessionSnapshot = null
    this.status = {
      ...this.status,
      account: null,
      device: null,
      sessionSyncState: 'idle'
    }
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
      const syncFailure = await this.establishSession(tokenSet.idTokenSubject, true)
      if (syncFailure) {
        return syncFailure
      }
      this.setStatus({ state: 'authenticated', errorCode: null })
      logInfo('managed OAuth login authenticated')
      return this.getStatus()
    } catch (error) {
      const mapped = mapLoginError(error)
      this.accessToken = null
      this.accessTokenExpiresAt = null
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
      const tokenSet = await this.refreshSession(stored.refreshToken)
      if (this.disposed) {
        return this.getStatus()
      }
      const syncFailure = await this.establishSession(tokenSet.idTokenSubject, false)
      if (syncFailure) {
        return syncFailure
      }
      this.setStatus({ state: 'authenticated', errorCode: null })
      logInfo('managed session restored')
      return this.getStatus()
    } catch (error) {
      if (isInvalidGrant(error)) {
        this.accessToken = null
        this.accessTokenExpiresAt = null
        this.refreshToken = null
        this.pendingTokenSet = null
        await this.tokenStore.clear().catch(() => {
          logError('managed invalid session credential cleanup failed', {
            errorCode: 'managed_token_persist_failed'
          })
        })
        await this.runtimeTokenBroker?.clear()
        this.setStatus({ state: 'reauth_required', errorCode: 'managed_refresh_invalid_grant' })
        logError('Managed 会话恢复失败', {
          errorCode: 'managed_refresh_invalid_grant',
          stage: 'refresh',
          reason: 'invalid_grant'
        })
        return this.getStatus()
      }

      this.accessToken = null
      this.accessTokenExpiresAt = null
      this.refreshToken = null
      const mapped = mapRefreshError(error)
      this.setStatus({ state: mapped.state, errorCode: mapped.errorCode })
      logError('Managed 会话恢复失败', {
        errorCode: mapped.errorCode,
        ...managedErrorDiagnostic(error)
      })
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
        const syncFailure = await this.establishSession(tokenSet.idTokenSubject, true)
        if (syncFailure) {
          return syncFailure
        }
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
      this.accessTokenExpiresAt = tokenSet.expiresIn === null
        ? null
        : this.serverClock.now() + tokenSet.expiresIn * 1_000
      this.refreshToken = tokenSet.refreshToken
    }
  }

  /** 统一执行一次 Refresh Token Grant 和新 Token 原子落盘。 */
  private refreshSession(refreshToken: string): Promise<ManagedTokenSet> {
    return this.refreshCoordinator.run(refreshToken, async () => {
      const tokenSet = await this.oauthClient.refresh(refreshToken)
      await this.persistTokenSet(tokenSet, 'refresh')
      return tokenSet
    })
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

  /** 同步 UserInfo 和当前设备；失败时保留可重试凭据但不伪造 ready。 */
  private async establishSession(
    expectedSubject?: string | null,
    retryExpiredAccessToken = false
  ): Promise<ManagedAuthStatus | null> {
    if (!this.accountSessionManager || !this.accessToken) {
      this.setStatus({ sessionSyncState: 'ready' })
      return null
    }
    this.setStatus({ sessionSyncState: 'syncing', account: null, device: null })
    try {
      const snapshot = await this.synchronizeAccountSession(expectedSubject, retryExpiredAccessToken)
      this.sessionSnapshot = snapshot
      this.setStatus({
        sessionSyncState: 'ready',
        account: snapshot.account,
        device: toManagedDeviceStatus(snapshot.device)
      })
      if (this.runtimeTokenBroker) {
        await this.runtimeTokenBroker.activate({
          deviceId: snapshot.device.id,
          getAccessToken: (forceRefresh) => this.ensureAccessTokenForRuntime(forceRefresh)
        }).catch(() => undefined)
      }
      return null
    } catch (error) {
      if (isControlPlaneDeviceRevoked(error)) {
        this.accessToken = null
        this.accessTokenExpiresAt = null
        this.refreshToken = null
        this.pendingTokenSet = null
        await this.tokenStore.clear().catch(() => undefined)
        await this.runtimeTokenBroker?.clear()
        this.sessionSnapshot = null
        this.setStatus({
          state: 'reauth_required',
          sessionSyncState: 'device_revoked',
          account: null,
          device: null,
          errorCode: 'managed_device_revoked'
        })
        return this.getStatus()
      }
      const mapped = mapSessionError(error)
      this.setStatus({
        state: mapped.state,
        sessionSyncState: 'failed',
        errorCode: mapped.errorCode
      })
      logError('managed account session synchronization failed', { errorCode: mapped.errorCode })
      return this.getStatus()
    }
  }

  /** 执行 RFC 7009 退出；撤销成功后才清理本地 Refresh Token。 */
  private async runLogout(): Promise<ManagedAuthStatus> {
    if (!this.refreshToken) {
      await this.clearLocalSession()
      this.setStatus({
        state: this.status.managedLoginEnabled ? 'idle' : 'disabled',
        sessionSyncState: 'idle',
        errorCode: null
      })
      return this.getStatus()
    }
    if (!this.accountSessionManager) {
      this.setStatus({ sessionSyncState: 'failed', errorCode: 'managed_logout_failed' })
      return this.getStatus()
    }
    this.setStatus({ sessionSyncState: 'logging_out', errorCode: null })
    try {
      await this.accountSessionManager.revokeRefreshToken(this.refreshToken)
      await this.clearLocalSession()
      this.setStatus({
        state: this.status.managedLoginEnabled ? 'idle' : 'disabled',
        sessionSyncState: 'idle',
        errorCode: null
      })
      logInfo('managed session logged out')
      return this.getStatus()
    } catch {
      this.setStatus({ sessionSyncState: 'failed', errorCode: 'managed_logout_failed' })
      logError('managed logout failed', { errorCode: 'managed_logout_failed' })
      return this.getStatus()
    }
  }

  /** 执行当前设备撤销并删除该账号本地设备映射。 */
  private async runRevokeCurrentDevice(): Promise<ManagedAuthStatus> {
    const snapshot = this.sessionSnapshot
    if (!this.accessToken || !snapshot || !this.accountSessionManager) {
      this.setStatus({ state: 'reauth_required', sessionSyncState: 'reauth_required', errorCode: 'managed_device_not_found' })
      return this.getStatus()
    }
    this.setStatus({ sessionSyncState: 'logging_out', errorCode: null })
    try {
      await this.revokeDeviceWithAccessTokenRetry(this.accountSessionManager, snapshot.device.id)
    } catch (error) {
      if (!isControlPlaneDeviceRevoked(error)) {
        if (error instanceof ManagedControlPlaneError &&
            (error.code === 'authentication_required' || error.code === 'token_expired')) {
          this.setStatus({
            state: 'reauth_required',
            sessionSyncState: 'reauth_required',
            errorCode: 'managed_refresh_invalid_grant'
          })
          return this.getStatus()
        }
        const code = error instanceof ManagedControlPlaneError && error.code === 'device_not_found'
          ? 'managed_device_not_found'
          : 'managed_session_sync_failed'
        this.setStatus({ sessionSyncState: 'failed', errorCode: code })
        return this.getStatus()
      }
    }
    await this.deviceIdentityManager?.clear(snapshot.subject).catch(() => undefined)
    try {
      await this.clearLocalSession()
    } catch {
      this.setStatus({
        state: 'reauth_required',
        sessionSyncState: 'device_revoked',
        errorCode: 'managed_token_persist_failed'
      })
      return this.getStatus()
    }
    this.setStatus({ state: 'reauth_required', sessionSyncState: 'device_revoked', errorCode: 'managed_device_revoked' })
    logInfo('managed current device revoked')
    return this.getStatus()
  }

  /** 清理 Main 内存和本地加密凭据，设备映射由调用方决定是否删除。 */
  private async clearLocalSession(): Promise<void> {
    await this.runtimeTokenBroker?.clear()
    this.accessToken = null
    this.accessTokenExpiresAt = null
    this.refreshToken = null
    this.pendingTokenSet = null
    this.sessionSnapshot = null
    await this.tokenStore.clear()
    this.status = {
      ...this.status,
      account: null,
      device: null
    }
  }

  /** 当前 Access Token 失效时只轮换一次 Refresh Token，再重试账号同步。 */
  private async synchronizeAccountSession(
    expectedSubject: string | null | undefined,
    retryExpiredAccessToken: boolean
  ): Promise<ManagedAccountSessionSnapshot> {
    if (!this.accountSessionManager || !this.accessToken) {
      throw new Error('Managed 会话客户端未准备完成。')
    }
    try {
      return await this.accountSessionManager.synchronize(this.accessToken, expectedSubject)
    } catch (error) {
      if (!retryExpiredAccessToken || !isAccessTokenRetryable(error)) {
        throw error
      }
      await this.refreshAccessTokenForSession()
      if (!this.accessToken) {
        throw error
      }
      return this.accountSessionManager.synchronize(this.accessToken, expectedSubject)
    }
  }

  /** 当前设备操作遇到 Access Token 过期时只执行一次 Refresh 并重试。 */
  private async revokeDeviceWithAccessTokenRetry(
    sessionManager: ManagedAccountSessionManager,
    deviceId: string
  ): Promise<void> {
    if (!this.accessToken) {
      throw new ManagedControlPlaneError(401, 'authentication_required', false)
    }
    try {
      await sessionManager.revokeCurrentDevice(this.accessToken, deviceId)
    } catch (error) {
      if (!isAccessTokenRetryable(error)) {
        throw error
      }
      await this.refreshAccessTokenForSession()
      if (!this.accessToken) {
        throw error
      }
      await sessionManager.revokeCurrentDevice(this.accessToken, deviceId)
    }
  }

  /** 使用当前 Refresh Token 轮换 Access Token，失败时不清理可重试凭据。 */
  private async refreshAccessTokenForSession(): Promise<void> {
    if (!this.refreshToken) {
      throw new ManagedOidcClientError('refresh', 'invalid_grant')
    }
    try {
      await this.refreshSession(this.refreshToken)
    } catch (error) {
      if (isInvalidGrant(error)) {
        this.accessToken = null
        this.accessTokenExpiresAt = null
        this.refreshToken = null
        this.pendingTokenSet = null
        await this.tokenStore.clear().catch(() => undefined)
        this.sessionSnapshot = null
        await this.runtimeTokenBroker?.clear()
        this.setStatus({
          state: 'reauth_required',
          sessionSyncState: 'reauth_required',
          errorCode: 'managed_refresh_invalid_grant'
        })
        throw new ManagedControlPlaneError(401, 'authentication_required', false)
      }
      throw error
    }
  }

  /** 为 Runtime Token Broker 返回 Main 内存 Access Token，必要时先轮换 OAuth Token。 */
  private async ensureAccessTokenForRuntime(forceRefresh = false): Promise<string | null> {
    if (!this.accessToken) {
      return null
    }
    const minimumLifetimeMs = 30_000
    if (!forceRefresh && (
      this.accessTokenExpiresAt === null ||
      this.accessTokenExpiresAt - this.serverClock.now() >= minimumLifetimeMs
    )) {
      return this.accessToken
    }
    await this.refreshAccessTokenForSession()
    return this.accessToken
  }

  /** Runtime 发现设备或认证已终止时，串行清理 Main、Runtime 和设备映射。 */
  private handleRuntimeTerminalError(error: ManagedControlPlaneError): void {
    if (
      this.disposed ||
      !['device_revoked', 'authentication_required', 'token_expired'].includes(error.code || '') ||
      this.activeTerminalCleanup
    ) {
      return
    }
    const snapshot = this.sessionSnapshot
    const deviceRevoked = error.code === 'device_revoked'
    const task = (async () => {
      if (deviceRevoked && snapshot) {
        await this.deviceIdentityManager?.clear(snapshot.subject).catch(() => undefined)
      }
      await this.clearLocalSession().catch(() => {
        logError('managed Runtime terminal session cleanup failed', {
          errorCode: 'managed_token_persist_failed'
        })
      })
      this.setStatus({
        state: 'reauth_required',
        sessionSyncState: deviceRevoked ? 'device_revoked' : 'reauth_required',
        errorCode: deviceRevoked ? 'managed_device_revoked' : 'managed_refresh_invalid_grant'
      })
    })().finally(() => {
      if (this.activeTerminalCleanup === task) {
        this.activeTerminalCleanup = null
      }
    })
    this.activeTerminalCleanup = task
  }

  /** 应用 Feature Flag 脱敏字段，不覆盖已经认证的状态。 */
  private applyFeatureSnapshot(
    features: Awaited<ReturnType<ManagedFeatureFlags['getSnapshot']>>,
    enabledState: ManagedAuthState = 'idle'
  ): void {
    const preserveSessionState =
      ['authenticated', 'restoring_session', 'reauth_required'].includes(this.status.state) ||
      this.status.sessionSyncState !== 'idle' ||
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

/** 只记录稳定阶段与原因，禁止把 OAuth 原始异常或凭据写入日志。 */
function managedErrorDiagnostic(error: unknown): {
  stage: ManagedOidcClientError['stage'] | 'local'
  reason: ManagedOidcClientError['reason']
} {
  if (error instanceof ManagedOidcClientError) {
    return { stage: error.stage, reason: error.reason }
  }
  return { stage: 'local', reason: null }
}

/** 将账号同步错误映射为稳定的 Renderer 错误分类。 */
function mapSessionError(error: unknown): { state: ManagedAuthState; errorCode: ManagedAuthErrorCode } {
  if (error instanceof ManagedControlPlaneError) {
    switch (error.code) {
      case 'device_conflict':
        return { state: 'failed', errorCode: 'managed_device_conflict' }
      case 'device_access_denied':
        return { state: 'failed', errorCode: 'managed_device_access_denied' }
      case 'device_not_found':
        return { state: 'failed', errorCode: 'managed_device_not_found' }
      case 'unsupported_client_version':
        return { state: 'unsupported_client', errorCode: 'managed_unsupported_client_version' }
      case 'authentication_required':
      case 'token_expired':
        return { state: 'reauth_required', errorCode: 'managed_refresh_invalid_grant' }
      default:
        return { state: 'offline', errorCode: 'managed_session_sync_failed' }
    }
  }
  if (error instanceof ManagedOidcClientError && error.stage === 'userinfo') {
    return { state: error.reason === 'network' ? 'offline' : 'failed', errorCode: 'managed_userinfo_failed' }
  }
  if (isInvalidGrant(error)) {
    return { state: 'reauth_required', errorCode: 'managed_refresh_invalid_grant' }
  }
  return { state: 'offline', errorCode: 'managed_session_sync_failed' }
}

/** 判断服务端明确返回的设备撤销错误，供撤销操作幂等收敛。 */
function isControlPlaneDeviceRevoked(error: unknown): boolean {
  return error instanceof ManagedControlPlaneError && error.code === 'device_revoked'
}

/** 只把明确的 Access Token 失效视为一次性 Refresh 重试条件。 */
function isAccessTokenRetryable(error: unknown): boolean {
  return (
    error instanceof ManagedControlPlaneError &&
      (error.code === 'authentication_required' || error.code === 'token_expired')
  ) || (
    error instanceof ManagedOidcClientError &&
      error.stage === 'userinfo' &&
      error.reason === 'invalid_grant'
  )
}

/** 从 Main 完整设备模型生成 IPC 可见脱敏快照。 */
function toManagedDeviceStatus(device: ManagedAccountSessionSnapshot['device']): ManagedAuthStatus['device'] {
  return {
    displayName: device.displayName,
    current: device.current,
    status: device.status,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt
  }
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
