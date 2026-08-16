import { describe, expect, it, vi } from 'vitest'
import type { ManagedRuntimeSessionTransport } from './managedRuntimeSessionBridge'
import { ManagedControlPlaneError } from './managedControlPlaneClient'
import { ManagedRuntimeAuthRefreshHandler } from './managedRuntimeAuthRefreshHandler'

const EVENT = {
  eventVersion: 1,
  type: 'managed_auth_refresh_required',
  sequence: 4,
  taskId: '7a70c803-f62f-4418-81c6-905f848322f1',
  traceId: 'dcecb768-9ff5-4ca4-a10b-6a725695ab5b',
  requestId: '54ca903e-23da-42bb-a69b-125f3669962b',
  reason: 'token_expired',
  outputStarted: false
} as const

describe('ManagedRuntimeAuthRefreshHandler', () => {
  it('刷新成功后只向原 Runtime 提交脱敏成功结果', async () => {
    const refreshForTask = vi.fn().mockResolvedValue(undefined)
    const submitManagedAuthResult = vi.fn().mockResolvedValue(undefined)
    const handler = new ManagedRuntimeAuthRefreshHandler({ refreshForTask })

    await handler.handle(EVENT, { submitManagedAuthResult })

    expect(refreshForTask).toHaveBeenCalledOnce()
    expect(submitManagedAuthResult).toHaveBeenCalledWith({
      taskId: EVENT.taskId,
      requestId: EVENT.requestId,
      result: 'refreshed',
      errorCode: null
    })
  })

  it('并发重复事件复用一次刷新和一次结果提交', async () => {
    let release!: () => void
    const refreshForTask = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const submitManagedAuthResult = vi.fn().mockResolvedValue(undefined)
    const handler = new ManagedRuntimeAuthRefreshHandler({ refreshForTask })

    const first = handler.handle(EVENT, { submitManagedAuthResult })
    const second = handler.handle(EVENT, { submitManagedAuthResult })
    release()
    await Promise.all([first, second])

    expect(refreshForTask).toHaveBeenCalledOnce()
    expect(submitManagedAuthResult).toHaveBeenCalledOnce()

    await handler.handle(EVENT, { submitManagedAuthResult })
    expect(refreshForTask).toHaveBeenCalledOnce()
    expect(submitManagedAuthResult).toHaveBeenCalledOnce()
  })

  it('设备撤销时提交稳定失败分类', async () => {
    const refreshForTask = vi.fn().mockRejectedValue(
      new ManagedControlPlaneError(403, 'device_revoked', false)
    )
    const submitManagedAuthResult = vi.fn().mockResolvedValue(undefined)
    const handler = new ManagedRuntimeAuthRefreshHandler({ refreshForTask })

    await handler.handle(EVENT, {
      submitManagedAuthResult
    } as Pick<ManagedRuntimeSessionTransport, 'submitManagedAuthResult'>)

    expect(submitManagedAuthResult).toHaveBeenCalledWith(expect.objectContaining({
      result: 'failed',
      errorCode: 'device_revoked'
    }))
  })

  it('Runtime 已停止时不重复提交第二个结果', async () => {
    const refreshForTask = vi.fn().mockResolvedValue(undefined)
    const submitManagedAuthResult = vi.fn().mockRejectedValue(new Error('runtime stopped'))
    const handler = new ManagedRuntimeAuthRefreshHandler({ refreshForTask })

    await expect(handler.handle(EVENT, { submitManagedAuthResult })).rejects.toThrow('runtime stopped')
    expect(submitManagedAuthResult).toHaveBeenCalledOnce()
  })
})
