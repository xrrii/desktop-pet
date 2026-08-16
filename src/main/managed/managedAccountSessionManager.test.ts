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
