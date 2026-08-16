import type { ManagedRuntimeSessionLease } from './managedControlPlaneClient'

/** 本地 Runtime 接收的 Managed Session 更新，字段与冻结契约保持一致。 */
export interface ManagedRuntimeSessionUpdate {
  accessToken: string
  expiresAt: string
  capabilitySnapshotVersion: number
}

/** 本地 Runtime 返回的脱敏 Managed Session 状态。 */
export interface ManagedRuntimeSessionStatus {
  configured: boolean
  expiresAt: string | null
  capabilitySnapshotVersion: number | null
}

/** Main 提交给等待任务的刷新结果，不包含任何 Token。 */
export interface ManagedAuthResult {
  taskId: string
  requestId: string
  result: 'refreshed' | 'failed'
  errorCode: string | null
}

/** AssistantRuntimeClient 需要实现的最小本地会话传输接口。 */
export interface ManagedRuntimeSessionTransport {
  updateManagedSession(update: ManagedRuntimeSessionUpdate): Promise<void>
  clearManagedSession(): Promise<void>
  getManagedSessionStatus(): Promise<ManagedRuntimeSessionStatus>
  submitManagedAuthResult(result: ManagedAuthResult): Promise<void>
}

/** 管理 Runtime 进程重启时会变化的本地传输引用，不持有官方 Runtime Token。 */
export class ManagedRuntimeSessionBridge {
  private transport: ManagedRuntimeSessionTransport | null = null

  /** 绑定刚启动完成的 Runtime 客户端。 */
  attach(transport: ManagedRuntimeSessionTransport): void {
    this.transport = transport
  }

  /** 仅解绑对应的旧 Runtime 客户端，避免旧进程退出影响新进程。 */
  detach(transport?: ManagedRuntimeSessionTransport): void {
    if (!transport || this.transport === transport) {
      this.transport = null
    }
  }

  /** 将 Main 内存中的 Lease 注入当前 Runtime；未启动时返回 false 等待重绑。 */
  async update(lease: ManagedRuntimeSessionLease): Promise<boolean> {
    const transport = this.transport
    if (!transport) {
      return false
    }
    await transport.updateManagedSession({
      accessToken: lease.accessToken,
      expiresAt: lease.expiresAt,
      // Cloud 的 entitlementVersion 就是本地能力授权快照的版本来源。
      capabilitySnapshotVersion: lease.entitlementVersion
    })
    return true
  }

  /** 清除当前 Runtime 内存中的官方 Session；Runtime 未启动时视为已经清除。 */
  async clear(): Promise<void> {
    await this.transport?.clearManagedSession()
  }

  /** 获取不含 Token、Session ID 和设备 ID 的本地状态。 */
  async status(): Promise<ManagedRuntimeSessionStatus> {
    if (!this.transport) {
      return { configured: false, expiresAt: null, capabilitySnapshotVersion: null }
    }
    return this.transport.getManagedSessionStatus()
  }

  /** 把 Main 的刷新结果提交给 Runtime 内等待中的任务。 */
  async submitAuthResult(result: ManagedAuthResult): Promise<void> {
    const transport = this.transport
    if (!transport) {
      throw new Error('本地 Runtime 尚未启动。')
    }
    await transport.submitManagedAuthResult(result)
  }
}
