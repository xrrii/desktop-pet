import { logError, logInfo } from '../logger'
import {
  ManagedControlPlaneClient,
  ManagedControlPlaneError,
  type ManagedRuntimeSessionLease
} from './managedControlPlaneClient'
import { ManagedOidcClientError } from './managedOAuthClient'
import {
  ManagedRuntimeSessionBridge,
  type ManagedRuntimeSessionTransport
} from './managedRuntimeSessionBridge'

const REFRESH_WINDOW_MS = 3 * 60 * 1_000
const MAX_RETRY_DELAY_MS = 30 * 1_000
const RETRY_JITTER_MS = 250

export type ManagedRuntimeTokenState = 'idle' | 'provisioning' | 'waiting_runtime' | 'ready' | 'failed'

export type ManagedRuntimeTokenErrorCode =
  | 'managed_runtime_session_failed'
  | 'managed_runtime_bridge_failed'
  | 'managed_capability_not_entitled'
  | 'managed_unsupported_client_version'
  | 'managed_authentication_required'
  | null

/** 可安全暴露给 Renderer 的 Runtime Token Broker 状态。 */
export interface ManagedRuntimeTokenStatus {
  state: ManagedRuntimeTokenState
  errorCode: ManagedRuntimeTokenErrorCode
}

/** Broker 获取 OAuth Access Token 所需的 Main 内部上下文。 */
export interface ManagedRuntimeAccessContext {
  deviceId: string
  getAccessToken: (forceRefresh?: boolean) => Promise<string | null>
}

interface BrokerDependencies {
  now?: () => number
  random?: () => number
  onStatusChange?: (status: ManagedRuntimeTokenStatus) => void
}

/** 获取、轮换并向本地 Runtime 注入短期 Runtime Token。 */
export class ManagedRuntimeTokenBroker {
  private context: ManagedRuntimeAccessContext | null = null
  private lease: ManagedRuntimeSessionLease | null = null
  private activeProvision: Promise<void> | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private generation = 0
  private disposed = false
  private retryAttempt = 0
  private status: ManagedRuntimeTokenStatus = { state: 'idle', errorCode: null }
  private readonly now: () => number
  private readonly random: () => number
  private statusListener: (status: ManagedRuntimeTokenStatus) => void
  private terminalErrorListener: (error: ManagedControlPlaneError) => void = () => undefined

  constructor(
    private readonly controlPlaneClient: ManagedControlPlaneClient,
    private readonly bridge: ManagedRuntimeSessionBridge,
    dependencies: BrokerDependencies = {}
  ) {
    this.now = dependencies.now || Date.now
    this.random = dependencies.random || Math.random
    this.statusListener = dependencies.onStatusChange || (() => undefined)
  }

  /** 注册脱敏状态监听器，供 ManagedAuthManager 合并 Renderer 快照。 */
  setStatusListener(listener: (status: ManagedRuntimeTokenStatus) => void): void {
    this.statusListener = listener
    listener(this.getStatus())
  }

  /** 注册设备撤销和认证终止的 Main 回调，其他错误只在 Broker 内收敛。 */
  setTerminalErrorListener(listener: (error: ManagedControlPlaneError) => void): void {
    this.terminalErrorListener = listener
  }

  /** 返回不包含 Token、Session ID、设备 ID和过期时间的状态。 */
  getStatus(): ManagedRuntimeTokenStatus {
    return { ...this.status }
  }

  /** 登录或恢复成功后创建 Runtime Session，并保留后续刷新所需的 Main 回调。 */
  async activate(context: ManagedRuntimeAccessContext): Promise<void> {
    this.context = context
    this.retryAttempt = 0
    this.generation += 1
    const generation = this.generation
    if (this.activeProvision) {
      await this.activeProvision.catch(() => undefined)
    }
    if (this.disposed || generation !== this.generation || this.context !== context) {
      return
    }
    await this.ensureSession(true)
  }

  /** Runtime 启动或重启后重新绑定传输，并注入当前有效 Lease。 */
  async attachRuntime(transport: ManagedRuntimeSessionTransport): Promise<void> {
    this.bridge.attach(transport)
    if (this.disposed) {
      return
    }
    if (this.lease && this.remainingLifetime(this.lease) > 0) {
      try {
        await this.bridge.update(this.lease)
        this.setStatus({ state: 'ready', errorCode: null })
        return
      } catch {
        this.setStatus({ state: 'failed', errorCode: 'managed_runtime_bridge_failed' })
        logError('managed Runtime Session 重新注入失败', { errorCode: 'managed_runtime_bridge_failed' })
        return
      }
    }
    if (this.context) {
      await this.ensureSession(true)
    }
  }

  /** Runtime 停止时仅解绑本地传输，Cloud Lease 继续由 Broker 内存持有。 */
  detachRuntime(transport?: ManagedRuntimeSessionTransport): void {
    this.bridge.detach(transport)
    if (this.lease && this.status.state === 'ready') {
      this.setStatus({ state: 'waiting_runtime', errorCode: null })
    }
  }

  /** 清除本地 Runtime 和 Main 内存状态；服务端撤销由既有账号/设备链路负责。 */
  async clear(): Promise<void> {
    this.generation += 1
    this.context = null
    this.cancelRefreshTimer()
    this.lease = null
    this.retryAttempt = 0
    await this.bridge.clear().catch(() => {
      logError('managed Runtime Session 本地清理失败', { errorCode: 'managed_runtime_bridge_failed' })
    })
    this.setStatus({ state: 'idle', errorCode: null })
  }

  /** 应用退出时只清理短期内存和定时器，不执行不可靠的网络撤销。 */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.context = null
    this.lease = null
    this.retryAttempt = 0
    this.cancelRefreshTimer()
    void this.bridge.clear().catch(() => undefined)
    this.bridge.detach()
    this.setStatus({ state: 'idle', errorCode: null })
  }

  /** 任务内认证事件要求立即换发新 Lease，成功后由调用方提交恢复结果。 */
  async refreshForTask(): Promise<void> {
    if (!this.context) {
      throw new ManagedControlPlaneError(401, 'authentication_required', false)
    }
    await this.ensureSession(true)
  }

  /** 保证存在剩余有效期超过三分钟的 Lease；并发调用复用同一个签发任务。 */
  private ensureSession(force: boolean): Promise<void> {
    if (this.disposed || !this.context) {
      return Promise.resolve()
    }
    if (!force && this.lease && this.remainingLifetime(this.lease) >= REFRESH_WINDOW_MS) {
      return Promise.resolve()
    }
    if (this.activeProvision) {
      return this.activeProvision
    }
    const generation = this.generation
    const context = this.context
    this.setStatus({ state: 'provisioning', errorCode: null })
    this.activeProvision = this.provision(context, generation)
      .catch((error: unknown) => {
        const errorCode = mapBrokerError(error)
        if (!this.disposed && generation === this.generation) {
          this.setStatus({ state: 'failed', errorCode })
          this.scheduleRetry(error, generation)
          logError('managed Runtime Session 创建失败', { errorCode })
        }
        throw error
      })
      .finally(() => {
        this.activeProvision = null
      })
    return this.activeProvision
  }

  /** 创建新 Lease、注入 Runtime，再最佳努力撤销被替换的旧 Session。 */
  private async provision(context: ManagedRuntimeAccessContext, generation: number): Promise<void> {
    let oauthAccessToken = await context.getAccessToken(false)
    if (!oauthAccessToken) {
      throw new ManagedControlPlaneError(401, 'authentication_required', false)
    }
    let next: ManagedRuntimeSessionLease
    try {
      next = await this.controlPlaneClient.createRuntimeSession(oauthAccessToken, context.deviceId)
    } catch (error) {
      if (!isAccessTokenRetryable(error)) {
        throw error
      }
      oauthAccessToken = await context.getAccessToken(true)
      if (!oauthAccessToken) {
        throw new ManagedControlPlaneError(401, 'authentication_required', false)
      }
      next = await this.controlPlaneClient.createRuntimeSession(oauthAccessToken, context.deviceId)
    }
    if (this.disposed || generation !== this.generation || this.context !== context) {
      await this.revokeBestEffort(oauthAccessToken, next.sessionId)
      return
    }

    const previous = this.lease
    try {
      const injected = await this.bridge.update(next)
      if (this.disposed || generation !== this.generation || this.context !== context) {
        await this.bridge.clear().catch(() => undefined)
        await this.revokeBestEffort(oauthAccessToken, next.sessionId)
        return
      }
      this.lease = next
      this.retryAttempt = 0
      this.scheduleRefresh(next)
      this.setStatus({ state: injected ? 'ready' : 'waiting_runtime', errorCode: null })
      if (previous && previous.sessionId !== next.sessionId) {
        await this.revokeBestEffort(oauthAccessToken, previous.sessionId)
      }
      logInfo('managed Runtime Session 已更新', {
        runtimeAttached: injected,
        capabilitySnapshotVersion: next.entitlementVersion
      })
    } catch (error) {
      await this.revokeBestEffort(oauthAccessToken, next.sessionId)
      throw new Error('本地 Runtime Session 注入失败。', { cause: error })
    }
  }

  /** 在剩余三分钟时触发下一次签发，失败后进入统一退避恢复。 */
  private scheduleRefresh(lease: ManagedRuntimeSessionLease): void {
    this.cancelRefreshTimer()
    const delay = Math.max(0, this.remainingLifetime(lease) - REFRESH_WINDOW_MS)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.ensureSession(true).catch(() => undefined)
    }, delay)
    this.refreshTimer.unref()
  }

  /** 临时网络错误使用指数退避和小幅抖动，Lease 到期后不再保留 Runtime 凭据。 */
  private scheduleRetry(error: unknown, generation: number): void {
    if (this.disposed || generation !== this.generation || !this.context) {
      if (isTerminalBrokerError(error)) {
        this.handleTerminalError(error)
      }
      return
    }
    if (isTerminalBrokerError(error)) {
      this.handleTerminalError(error)
      return
    }
    if (!isRetryableBrokerError(error)) {
      if (error instanceof ManagedControlPlaneError && (
        error.code === 'capability_not_entitled' ||
        error.code === 'unsupported_client_version'
      )) {
        void this.clearRuntimeLeaseOnly()
      }
      return
    }
    const remaining = this.lease ? this.remainingLifetime(this.lease) : Number.POSITIVE_INFINITY
    if (remaining <= 0) {
      void this.expireLease(generation)
      return
    }
    this.cancelRefreshTimer()
    const baseDelay = Math.min(MAX_RETRY_DELAY_MS, 1_000 * (2 ** Math.min(this.retryAttempt, 5)))
    const jitter = Math.floor(this.random() * RETRY_JITTER_MS)
    const retryAfter = error instanceof ManagedControlPlaneError && error.retryAfterSeconds !== null
      ? error.retryAfterSeconds * 1_000
      : baseDelay + jitter
    const delay = Math.max(0, Math.min(Math.max(250, retryAfter), Math.max(0, remaining - 100)))
    this.retryAttempt += 1
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (this.lease && this.remainingLifetime(this.lease) <= 0) {
        void this.expireLease(generation)
        return
      }
      void this.ensureSession(true).catch(() => undefined)
    }, delay)
    this.refreshTimer.unref()
  }

  /** Lease 已过期时清除 Runtime，不触碰桌面 Refresh Token。 */
  private async expireLease(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) {
      return
    }
    this.lease = null
    await this.bridge.clear().catch(() => undefined)
    this.setStatus({ state: 'failed', errorCode: 'managed_runtime_session_failed' })
    this.scheduleRetry(new ManagedControlPlaneError(503, 'internal_error', true), generation)
  }

  /** Entitlement 或版本错误只清理 Runtime Lease，保留桌面账号会话。 */
  private async clearRuntimeLeaseOnly(): Promise<void> {
    this.cancelRefreshTimer()
    this.lease = null
    await this.bridge.clear().catch(() => undefined)
  }

  /** 将设备撤销或认证终止通知给拥有完整会话的 AuthManager。 */
  private handleTerminalError(error: unknown): void {
    if (error instanceof ManagedControlPlaneError && isTerminalBrokerError(error)) {
      void this.clearRuntimeLeaseOnly()
      this.terminalErrorListener(error)
    }
  }

  /** 撤销失败不覆盖已经成功注入的新 Lease，也不记录 Token 或 Session ID。 */
  private async revokeBestEffort(accessToken: string, sessionId: string): Promise<void> {
    try {
      await this.controlPlaneClient.revokeRuntimeSession(accessToken, sessionId)
    } catch {
      logError('managed 旧 Runtime Session 撤销失败', { errorCode: 'managed_runtime_session_failed' })
    }
  }

  private remainingLifetime(lease: ManagedRuntimeSessionLease): number {
    return Date.parse(lease.expiresAt) - this.now()
  }

  private cancelRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  private setStatus(status: ManagedRuntimeTokenStatus): void {
    this.status = status
    this.statusListener(this.getStatus())
  }
}

/** 将控制面和本地 Bridge 异常映射为稳定、脱敏的 Renderer 状态。 */
function mapBrokerError(error: unknown): Exclude<ManagedRuntimeTokenErrorCode, null> {
  if (error instanceof ManagedControlPlaneError) {
    if (error.code === 'capability_not_entitled') return 'managed_capability_not_entitled'
    if (error.code === 'unsupported_client_version') return 'managed_unsupported_client_version'
    if (error.code === 'authentication_required' || error.code === 'token_expired' || error.code === 'device_revoked') {
      return 'managed_authentication_required'
    }
    return 'managed_runtime_session_failed'
  }
  return error instanceof Error && error.message === '本地 Runtime Session 注入失败。'
    ? 'managed_runtime_bridge_failed'
    : 'managed_runtime_session_failed'
}

/** 控制面明确表示 Access Token 已失效时允许一次强制 Refresh。 */
function isAccessTokenRetryable(error: unknown): boolean {
  return error instanceof ManagedControlPlaneError &&
    (error.code === 'authentication_required' || error.code === 'token_expired')
}

/** 网络、限流和服务端暂态错误允许离线退避恢复。 */
function isRetryableBrokerError(error: unknown): boolean {
  if (error instanceof ManagedControlPlaneError) {
    return error.code === 'network_error' || error.retryable || error.status === 429 || (error.status !== null && error.status >= 500)
  }
  return error instanceof ManagedOidcClientError && error.reason === 'network'
}

/** 设备撤销和无法恢复的认证错误必须通知 AuthManager 清理完整会话。 */
function isTerminalBrokerError(error: unknown): error is ManagedControlPlaneError {
  return error instanceof ManagedControlPlaneError &&
    (error.code === 'device_revoked' || error.code === 'authentication_required' || error.code === 'token_expired')
}
