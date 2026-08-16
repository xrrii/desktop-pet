import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ManagedControlPlaneError,
  type ManagedControlPlaneClient,
  type ManagedRuntimeSessionLease
} from './managedControlPlaneClient'
import { ManagedRuntimeSessionBridge, type ManagedRuntimeSessionTransport } from './managedRuntimeSessionBridge'
import { ManagedRuntimeTokenBroker } from './managedRuntimeTokenBroker'

describe('ManagedRuntimeTokenBroker', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('创建 Lease 后等待 Runtime，并在 Runtime 就绪时重新注入', async () => {
    const controlPlane = controlPlaneDouble([lease('039f8b64-dc93-4b7f-a94d-cf88400f2615')])
    const bridge = new ManagedRuntimeSessionBridge()
    const broker = new ManagedRuntimeTokenBroker(controlPlane.value, bridge, {
      now: () => Date.parse('2026-08-16T00:00:00Z')
    })

    await broker.activate({
      deviceId: 'a01715d2-42e3-4abe-a348-708dda38ab0d',
      getAccessToken: async () => 'synthetic-oauth-access-token'
    })
    expect(broker.getStatus()).toEqual({ state: 'waiting_runtime', errorCode: null })

    const transport = transportDouble()
    await broker.attachRuntime(transport.value)

    expect(transport.updateManagedSession).toHaveBeenCalledWith({
      accessToken: 'synthetic-runtime-access-token-value-0001',
      expiresAt: '2026-08-16T00:15:00Z',
      capabilitySnapshotVersion: 3
    })
    expect(broker.getStatus()).toEqual({ state: 'ready', errorCode: null })

    await broker.clear()
    expect(transport.clearManagedSession).toHaveBeenCalledOnce()
    expect(broker.getStatus()).toEqual({ state: 'idle', errorCode: null })
    broker.dispose()
  })

  it('剩余三分钟时 single-flight 签发新 Lease 并撤销旧 Session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00Z'))
    const controlPlane = controlPlaneDouble([
      lease('039f8b64-dc93-4b7f-a94d-cf88400f2615'),
      {
        ...lease('9e60cf9e-1283-4c95-a193-ef0218c5cf0f'),
        issuedAt: '2026-08-16T00:12:00Z',
        expiresAt: '2026-08-16T00:27:00Z'
      }
    ])
    const bridge = new ManagedRuntimeSessionBridge()
    const transport = transportDouble()
    bridge.attach(transport.value)
    const broker = new ManagedRuntimeTokenBroker(controlPlane.value, bridge)

    await broker.activate({
      deviceId: 'a01715d2-42e3-4abe-a348-708dda38ab0d',
      getAccessToken: async () => 'synthetic-oauth-access-token'
    })
    await vi.advanceTimersByTimeAsync(12 * 60 * 1_000)

    expect(controlPlane.createRuntimeSession).toHaveBeenCalledTimes(2)
    expect(controlPlane.revokeRuntimeSession).toHaveBeenCalledWith(
      'synthetic-oauth-access-token',
      '039f8b64-dc93-4b7f-a94d-cf88400f2615'
    )
    expect(transport.updateManagedSession).toHaveBeenCalledTimes(2)
    broker.dispose()
  })

  it('把无 Entitlement 映射为脱敏失败状态', async () => {
    const createRuntimeSession = vi.fn().mockRejectedValue(
      new ManagedControlPlaneError(403, 'capability_not_entitled', false)
    )
    const broker = new ManagedRuntimeTokenBroker({
      createRuntimeSession,
      revokeRuntimeSession: vi.fn()
    } as unknown as ManagedControlPlaneClient, new ManagedRuntimeSessionBridge())

    await expect(broker.activate({
      deviceId: 'a01715d2-42e3-4abe-a348-708dda38ab0d',
      getAccessToken: async () => 'synthetic-oauth-access-token'
    })).rejects.toBeInstanceOf(ManagedControlPlaneError)

    expect(broker.getStatus()).toEqual({
      state: 'failed',
      errorCode: 'managed_capability_not_entitled'
    })
    broker.dispose()
  })
})

function lease(sessionId: string): ManagedRuntimeSessionLease {
  return {
    sessionId,
    accessToken: 'synthetic-runtime-access-token-value-0001',
    tokenType: 'Bearer',
    issuedAt: '2026-08-16T00:00:00Z',
    expiresAt: '2026-08-16T00:15:00Z',
    entitlementVersion: 3
  }
}

function controlPlaneDouble(leases: ManagedRuntimeSessionLease[]) {
  const createRuntimeSession = vi.fn()
  leases.forEach((value) => createRuntimeSession.mockResolvedValueOnce(value))
  const revokeRuntimeSession = vi.fn().mockResolvedValue(undefined)
  return {
    value: { createRuntimeSession, revokeRuntimeSession } as unknown as ManagedControlPlaneClient,
    createRuntimeSession,
    revokeRuntimeSession
  }
}

function transportDouble() {
  const updateManagedSession = vi.fn().mockResolvedValue(undefined)
  const clearManagedSession = vi.fn().mockResolvedValue(undefined)
  return {
    value: {
      updateManagedSession,
      clearManagedSession,
      getManagedSessionStatus: vi.fn(),
      submitManagedAuthResult: vi.fn()
    } as unknown as ManagedRuntimeSessionTransport,
    updateManagedSession,
    clearManagedSession
  }
}
