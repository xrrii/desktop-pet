import { describe, expect, it, vi } from 'vitest'
import { ManagedAccountSessionManager, normalizeManagedUserInfo } from './managedAccountSessionManager'
import { ManagedControlPlaneError } from './managedControlPlaneClient'
import type { ManagedControlPlaneClient } from './managedControlPlaneClient'
import type { ManagedDeviceIdentityManager } from './managedDeviceIdentityManager'
import type { ManagedOAuthClient } from './managedOAuthTypes'

describe('ManagedAccountSessionManager', () => {
  it('UserInfo 未知字段不会进入 Renderer 账号快照', () => {
    const result = normalizeManagedUserInfo({
      sub: 'opaque-subject',
      email: 'alice@example.test',
      email_verified: true,
      preferred_username: 'alice',
      name: 'Alice',
      phone_number: 'not-allowed'
    } as never)

    expect(result).toEqual({
      email: 'alice@example.test',
      emailVerified: true,
      username: 'alice',
      displayName: 'Alice'
    })
    expect(result).not.toHaveProperty('sub')
    expect(result).not.toHaveProperty('phone_number')
  })

  it('已有当前设备时采用服务端状态并修复本地映射', async () => {
    const dependencies = createDependencies()
    dependencies.controlPlane.getCurrentDevice.mockResolvedValue(devicePayload())
    const manager = createManager(dependencies)

    const result = await manager.synchronize('synthetic-access-token')

    expect(result.account.username).toBe('alice')
    expect(result.device.status).toBe('active')
    expect(dependencies.identity.remember).toHaveBeenCalledWith(
      'opaque-subject',
      'a01715d2-42e3-4abe-a348-708dda38ab0d'
    )
    expect(dependencies.controlPlane.registerDevice).not.toHaveBeenCalled()
  })

  it('只有明确 device_not_found 才使用稳定 UUID 注册当前设备', async () => {
    const dependencies = createDependencies()
    dependencies.controlPlane.getCurrentDevice.mockRejectedValue(
      new ManagedControlPlaneError(404, 'device_not_found', false)
    )
    dependencies.controlPlane.registerDevice.mockResolvedValue(devicePayload())
    const manager = createManager(dependencies)

    await manager.synchronize('synthetic-access-token')

    expect(dependencies.controlPlane.registerDevice).toHaveBeenCalledWith(
      'synthetic-access-token',
      {
        deviceId: 'a01715d2-42e3-4abe-a348-708dda38ab0d',
        displayName: 'Windows Desktop',
        platform: 'windows'
      }
    )
  })

  it('注册阶段 device_revoked 时清除旧映射并使用新 UUID 重试一次', async () => {
    const dependencies = createDependencies()
    dependencies.controlPlane.getCurrentDevice.mockRejectedValue(
      new ManagedControlPlaneError(404, 'device_not_found', false)
    )
    dependencies.identity.getOrCreate
      .mockResolvedValueOnce('a01715d2-42e3-4abe-a348-708dda38ab0d')
      .mockResolvedValueOnce('b12726e3-53f4-4bff-b459-819eeb49bc1e')
    dependencies.controlPlane.registerDevice
      .mockRejectedValueOnce(new ManagedControlPlaneError(401, 'device_revoked', false))
      .mockResolvedValueOnce({ ...devicePayload(), id: 'b12726e3-53f4-4bff-b459-819eeb49bc1e' })
    const manager = createManager(dependencies)

    const result = await manager.synchronize('synthetic-access-token')

    expect(result.device.id).toBe('b12726e3-53f4-4bff-b459-819eeb49bc1e')
    expect(dependencies.identity.clear).toHaveBeenCalledWith('opaque-subject')
    expect(dependencies.controlPlane.registerDevice).toHaveBeenNthCalledWith(
      1,
      'synthetic-access-token',
      expect.objectContaining({ deviceId: 'a01715d2-42e3-4abe-a348-708dda38ab0d' })
    )
    expect(dependencies.controlPlane.registerDevice).toHaveBeenNthCalledWith(
      2,
      'synthetic-access-token',
      expect.objectContaining({ deviceId: 'b12726e3-53f4-4bff-b459-819eeb49bc1e' })
    )
    expect(dependencies.identity.clear).toHaveBeenCalledOnce()
  })

  it('换新 UUID 后仍返回 device_revoked 时停止重试并传播错误', async () => {
    const dependencies = createDependencies()
    dependencies.controlPlane.getCurrentDevice.mockRejectedValue(
      new ManagedControlPlaneError(404, 'device_not_found', false)
    )
    dependencies.identity.getOrCreate
      .mockResolvedValueOnce('a01715d2-42e3-4abe-a348-708dda38ab0d')
      .mockResolvedValueOnce('b12726e3-53f4-4bff-b459-819eeb49bc1e')
    dependencies.controlPlane.registerDevice.mockRejectedValue(
      new ManagedControlPlaneError(401, 'device_revoked', false)
    )
    const manager = createManager(dependencies)

    await expect(manager.synchronize('synthetic-access-token')).rejects.toMatchObject({
      code: 'device_revoked'
    })
    expect(dependencies.controlPlane.registerDevice).toHaveBeenCalledTimes(2)
    expect(dependencies.identity.clear).toHaveBeenCalledOnce()
  })

  it('注册阶段 device_conflict 不清除映射也不重试', async () => {
    const dependencies = createDependencies()
    dependencies.controlPlane.getCurrentDevice.mockRejectedValue(
      new ManagedControlPlaneError(404, 'device_not_found', false)
    )
    dependencies.controlPlane.registerDevice.mockRejectedValue(
      new ManagedControlPlaneError(409, 'device_conflict', false)
    )
    const manager = createManager(dependencies)

    await expect(manager.synchronize('synthetic-access-token')).rejects.toMatchObject({
      code: 'device_conflict'
    })
    expect(dependencies.controlPlane.registerDevice).toHaveBeenCalledOnce()
    expect(dependencies.identity.clear).not.toHaveBeenCalled()
  })

  it('device_conflict 不触发自动转移或二次注册', async () => {
    const dependencies = createDependencies()
    dependencies.controlPlane.getCurrentDevice.mockRejectedValue(
      new ManagedControlPlaneError(409, 'device_conflict', false)
    )
    const manager = createManager(dependencies)

    await expect(manager.synchronize('synthetic-access-token')).rejects.toMatchObject({
      code: 'device_conflict'
    })
    expect(dependencies.identity.getOrCreate).not.toHaveBeenCalled()
  })
})

/** 创建账号会话编排所需的合成依赖。 */
function createDependencies() {
  const oauth: ManagedOAuthClient = {
    prepare: vi.fn(),
    refresh: vi.fn(),
    fetchUserInfo: vi.fn().mockResolvedValue({
      sub: 'opaque-subject',
      email: 'alice@example.test',
      email_verified: true,
      preferred_username: 'alice',
      name: 'Alice'
    }),
    revokeRefreshToken: vi.fn()
  }
  const controlPlane = {
    getCurrentDevice: vi.fn(),
    registerDevice: vi.fn(),
    revokeDevice: vi.fn()
  }
  const identity = {
    getOrCreate: vi.fn().mockResolvedValue('a01715d2-42e3-4abe-a348-708dda38ab0d'),
    remember: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    getDefaultDisplayName: vi.fn().mockReturnValue('Windows Desktop')
  }
  return { oauth, controlPlane, identity }
}

/** 用合成依赖创建待测编排器。 */
function createManager(dependencies: ReturnType<typeof createDependencies>): ManagedAccountSessionManager {
  return new ManagedAccountSessionManager(
    dependencies.oauth,
    dependencies.controlPlane as unknown as ManagedControlPlaneClient,
    dependencies.identity as unknown as ManagedDeviceIdentityManager
  )
}

/** 返回契约格式的合成设备响应。 */
function devicePayload() {
  return {
    id: 'a01715d2-42e3-4abe-a348-708dda38ab0d',
    displayName: 'Windows Desktop',
    current: true,
    status: 'active' as const,
    createdAt: '2026-08-16T00:00:00Z',
    lastSeenAt: '2026-08-16T00:00:00Z'
  }
}
