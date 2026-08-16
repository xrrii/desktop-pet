import type { ManagedAccountSnapshot, ManagedDeviceSnapshot } from '../../shared/managed'
import type {
  ManagedControlPlaneClient,
  ManagedControlPlaneDevice
} from './managedControlPlaneClient'
import { ManagedDeviceIdentityManager, normalizeManagedDeviceDisplayName } from './managedDeviceIdentityManager'
import type { ManagedOAuthClient, ManagedUserInfo } from './managedOAuthTypes'

/** Main 内账号会话同步结果，包含完整设备 ID 但不会直接传给 Renderer。 */
export interface ManagedAccountSessionSnapshot {
  account: ManagedAccountSnapshot
  device: ManagedDeviceSnapshot
  subject: string
}

/** 编排 UserInfo、当前设备查询和首次设备注册。 */
export class ManagedAccountSessionManager {
  constructor(
    private readonly oauthClient: ManagedOAuthClient,
    private readonly controlPlaneClient: ManagedControlPlaneClient,
    private readonly deviceIdentityManager: ManagedDeviceIdentityManager
  ) {}

  /** 获取账号资料并确保当前 OAuth 授权已经绑定 active 设备。 */
  async synchronize(accessToken: string, expectedSubject?: string | null): Promise<ManagedAccountSessionSnapshot> {
    if (!this.oauthClient.fetchUserInfo) {
      throw new Error('OIDC UserInfo 客户端未配置。')
    }
    const userInfo = await this.oauthClient.fetchUserInfo(accessToken, expectedSubject)
    const account = normalizeManagedUserInfo(userInfo)
    let device: ManagedControlPlaneDevice
    try {
      device = await this.controlPlaneClient.getCurrentDevice(accessToken)
      await this.deviceIdentityManager.remember(userInfo.sub, device.id)
    } catch (error) {
      if (!isDeviceNotFound(error)) {
        throw error
      }
      const deviceId = await this.deviceIdentityManager.getOrCreate(userInfo.sub)
      device = await this.controlPlaneClient.registerDevice(accessToken, {
        deviceId,
        displayName: normalizeManagedDeviceDisplayName(this.deviceIdentityManager.getDefaultDisplayName()),
        platform: 'windows'
      })
      await this.deviceIdentityManager.remember(userInfo.sub, device.id)
    }
    if (device.status !== 'active' || !device.current) {
      throw new Error('当前设备状态无效。')
    }
    return {
      account,
      device: toManagedDeviceSnapshot(device),
      subject: userInfo.sub
    }
  }

  /** 通过 OAuth Client 执行 RFC 7009 Refresh Token 撤销。 */
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    if (!this.oauthClient.revokeRefreshToken) {
      throw new Error('OAuth 撤销客户端未配置。')
    }
    await this.oauthClient.revokeRefreshToken(refreshToken)
  }

  /** 撤销 Main 当前已知设备，Renderer 不参与设备 ID 选择。 */
  revokeCurrentDevice(accessToken: string, deviceId: string): Promise<void> {
    return this.controlPlaneClient.revokeDevice(accessToken, deviceId)
  }
}

/** 严格提取 UserInfo 最小字段，未知字段不进入应用状态。 */
export function normalizeManagedUserInfo(value: ManagedUserInfo): ManagedAccountSnapshot {
  if (!value || typeof value.sub !== 'string' || value.sub.trim() === '') {
    throw new Error('UserInfo subject 无效。')
  }
  if (value.email !== undefined && typeof value.email !== 'string') {
    throw new Error('UserInfo email 无效。')
  }
  if (value.email_verified !== undefined && typeof value.email_verified !== 'boolean') {
    throw new Error('UserInfo email_verified 无效。')
  }
  if (value.preferred_username !== undefined && typeof value.preferred_username !== 'string') {
    throw new Error('UserInfo preferred_username 无效。')
  }
  if (value.name !== undefined && typeof value.name !== 'string') {
    throw new Error('UserInfo name 无效。')
  }
  const username = value.preferred_username?.trim() || ''
  const displayName = value.name?.trim() || username
  return {
    email: value.email?.trim() || '',
    emailVerified: value.email_verified === true,
    username,
    displayName
  }
}

/** 将控制面设备响应转换为 Main 内部设备快照。 */
function toManagedDeviceSnapshot(device: ManagedControlPlaneDevice): ManagedDeviceSnapshot {
  return {
    id: device.id,
    displayName: device.displayName,
    current: device.current,
    status: device.status,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt
  }
}

/** 只有明确的 device_not_found 才允许触发首次注册。 */
function isDeviceNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'device_not_found')
}
