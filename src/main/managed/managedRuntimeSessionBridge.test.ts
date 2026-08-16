import { describe, expect, it, vi } from 'vitest'
import type { ManagedRuntimeSessionLease } from './managedControlPlaneClient'
import {
  ManagedRuntimeSessionBridge,
  type ManagedRuntimeSessionTransport
} from './managedRuntimeSessionBridge'

describe('ManagedRuntimeSessionBridge', () => {
  it('把 entitlementVersion 映射为本地 capabilitySnapshotVersion', async () => {
    const transport = transportDouble()
    const bridge = new ManagedRuntimeSessionBridge()
    bridge.attach(transport.value)

    await expect(bridge.update(lease())).resolves.toBe(true)
    expect(transport.updateManagedSession).toHaveBeenCalledWith({
      accessToken: 'synthetic-runtime-access-token-value-0001',
      expiresAt: '2026-08-16T00:15:00Z',
      capabilitySnapshotVersion: 3
    })
  })

  it('Runtime 未启动时不持有 Token，返回等待重绑状态', async () => {
    const bridge = new ManagedRuntimeSessionBridge()

    await expect(bridge.update(lease())).resolves.toBe(false)
    await expect(bridge.status()).resolves.toEqual({
      configured: false,
      expiresAt: null,
      capabilitySnapshotVersion: null
    })
  })

  it('只解绑对应的旧 Runtime 客户端', async () => {
    const first = transportDouble()
    const second = transportDouble()
    const bridge = new ManagedRuntimeSessionBridge()
    bridge.attach(first.value)
    bridge.attach(second.value)

    bridge.detach(first.value)
    await bridge.clear()

    expect(first.clearManagedSession).not.toHaveBeenCalled()
    expect(second.clearManagedSession).toHaveBeenCalledOnce()
  })
})

function lease(): ManagedRuntimeSessionLease {
  return {
    sessionId: '039f8b64-dc93-4b7f-a94d-cf88400f2615',
    accessToken: 'synthetic-runtime-access-token-value-0001',
    tokenType: 'Bearer',
    issuedAt: '2026-08-16T00:00:00Z',
    expiresAt: '2026-08-16T00:15:00Z',
    entitlementVersion: 3
  }
}

function transportDouble() {
  const updateManagedSession = vi.fn().mockResolvedValue(undefined)
  const clearManagedSession = vi.fn().mockResolvedValue(undefined)
  const getManagedSessionStatus = vi.fn().mockResolvedValue({
    configured: true,
    expiresAt: '2026-08-16T00:15:00Z',
    capabilitySnapshotVersion: 3
  })
  const submitManagedAuthResult = vi.fn().mockResolvedValue(undefined)
  return {
    value: {
      updateManagedSession,
      clearManagedSession,
      getManagedSessionStatus,
      submitManagedAuthResult
    } satisfies ManagedRuntimeSessionTransport,
    updateManagedSession,
    clearManagedSession
  }
}
