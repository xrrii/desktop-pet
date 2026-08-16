import { describe, expect, it, vi } from 'vitest'
import { ManagedRefreshCoordinator } from './managedRefreshCoordinator'

describe('ManagedRefreshCoordinator', () => {
  it('同一旧 Refresh Token 只提交一次底层操作', async () => {
    let resolve!: (value: string) => void
    const operation = vi.fn(() => new Promise<string>((done) => { resolve = done }))
    const coordinator = new ManagedRefreshCoordinator<string>()

    const first = coordinator.run('old-refresh-token', operation)
    const second = coordinator.run('old-refresh-token', operation)
    resolve('rotated-token-set')

    await expect(Promise.all([first, second])).resolves.toEqual([
      'rotated-token-set',
      'rotated-token-set'
    ])
    expect(operation).toHaveBeenCalledOnce()
    expect(coordinator.isActive()).toBe(false)
  })

  it('不同 Token 等待上一轮结束后再执行', async () => {
    const order: string[] = []
    const coordinator = new ManagedRefreshCoordinator<string>()
    const first = coordinator.run('old-token', async () => {
      order.push('old-start')
      await Promise.resolve()
      order.push('old-end')
      return 'old-result'
    })
    const second = coordinator.run('new-token', async () => {
      order.push('new-start')
      return 'new-result'
    })

    await expect(Promise.all([first, second])).resolves.toEqual(['old-result', 'new-result'])
    expect(order).toEqual(['old-start', 'old-end', 'new-start'])
  })
})
