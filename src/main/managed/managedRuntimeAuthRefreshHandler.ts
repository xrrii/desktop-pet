import { logError } from '../logger'
import { ManagedControlPlaneError } from './managedControlPlaneClient'
import type { ManagedRuntimeSessionTransport } from './managedRuntimeSessionBridge'
import type { ManagedRuntimeTokenBroker } from './managedRuntimeTokenBroker'

/** 冻结契约中的 Main-only 认证刷新控制事件，不属于 Renderer AssistantEvent。 */
export interface ManagedAuthRefreshRequiredEvent {
  eventVersion: 1
  type: 'managed_auth_refresh_required'
  sequence: number
  taskId: string
  traceId: string
  requestId: string
  reason: 'token_expired'
  outputStarted: false
}

/** Main-only 任务认证刷新处理器，同一 taskId/requestId 复用一个执行任务。 */
export class ManagedRuntimeAuthRefreshHandler {
  private readonly active = new Map<string, Promise<void>>()
  private readonly completed = new Set<string>()
  private readonly completedOrder: string[] = []

  constructor(private readonly broker: Pick<ManagedRuntimeTokenBroker, 'refreshForTask'>) {}

  /** 刷新并注入 Runtime Lease，再向原 Runtime 进程提交脱敏结果。 */
  handle(
    event: ManagedAuthRefreshRequiredEvent,
    transport: Pick<ManagedRuntimeSessionTransport, 'submitManagedAuthResult'>
  ): Promise<void> {
    const key = `${event.taskId}:${event.requestId}`
    if (this.completed.has(key)) {
      return Promise.resolve()
    }
    const current = this.active.get(key)
    if (current) {
      return current
    }
    const task = this.run(event, transport).then(() => {
      this.completed.add(key)
      this.completedOrder.push(key)
      if (this.completedOrder.length > 256) {
        const expiredKey = this.completedOrder.shift()
        if (expiredKey) {
          this.completed.delete(expiredKey)
        }
      }
    }).finally(() => {
      if (this.active.get(key) === task) {
        this.active.delete(key)
      }
    })
    this.active.set(key, task)
    return task
  }

  /** 失败结果只使用 Managed v1 稳定错误码，不传播底层消息。 */
  private async run(
    event: ManagedAuthRefreshRequiredEvent,
    transport: Pick<ManagedRuntimeSessionTransport, 'submitManagedAuthResult'>
  ): Promise<void> {
    let result: Parameters<ManagedRuntimeSessionTransport['submitManagedAuthResult']>[0]
    try {
      await this.broker.refreshForTask()
      result = {
        taskId: event.taskId,
        requestId: event.requestId,
        result: 'refreshed',
        errorCode: null
      }
    } catch (error) {
      const errorCode = mapRefreshFailure(error)
      logError('managed Runtime task authentication refresh failed', { errorCode })
      result = {
        taskId: event.taskId,
        requestId: event.requestId,
        result: 'failed',
        errorCode
      }
    }
    await transport.submitManagedAuthResult(result)
  }
}

/** 将 Broker 失败集中映射到公共 Managed v1 错误目录。 */
function mapRefreshFailure(error: unknown): string {
  if (error instanceof ManagedControlPlaneError) {
    switch (error.code) {
      case 'authentication_required':
      case 'token_expired':
        return 'authentication_required'
      case 'device_revoked':
        return 'device_revoked'
      case 'capability_not_entitled':
        return 'capability_not_entitled'
      case 'unsupported_client_version':
        return 'unsupported_client_version'
      default:
        return 'provider_unavailable'
    }
  }
  return 'provider_unavailable'
}
