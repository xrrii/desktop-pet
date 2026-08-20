import { randomUUID } from 'node:crypto'
import type { ManagedAuthErrorCode } from '../../shared/managed'
import type { ManagedEndpointPolicy } from './managedOAuthTypes'

export interface ManagedFeatureSnapshot {
  readonly managedLoginEnabled: boolean
  readonly managedChatEnabled: boolean
  readonly minimumClientVersion: string | null
  readonly errorCode: ManagedAuthErrorCode | null
}

/**
 * 读取登录前 Feature Flag；失败和版本不兼容都按关闭处理，不能阻断 BYOK 启动。
 */
export class ManagedFeatureFlags {
  private snapshot: ManagedFeatureSnapshot = {
    managedLoginEnabled: false,
    managedChatEnabled: false,
    minimumClientVersion: null,
    errorCode: null
  }

  constructor(
    private readonly policy: ManagedEndpointPolicy,
    private readonly clientVersion: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  /** 返回最近一次脱敏 Feature Flag 快照。 */
  getSnapshot(): ManagedFeatureSnapshot {
    return { ...this.snapshot }
  }

  /** 匿名读取服务端 Feature Flag，绝不发送 Access Token。 */
  async refresh(): Promise<ManagedFeatureSnapshot> {
    try {
      const endpoint = new URL('/api/v1/features', this.policy.controlPlaneBaseUrl)
      const response = await this.fetcher(endpoint, {
        method: 'GET',
        headers: {
          'X-PetDock-Client-Version': this.clientVersion,
          'X-PetDock-Request-Id': randomUUID(),
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) {
        return this.update({
          managedLoginEnabled: false,
          managedChatEnabled: false,
          minimumClientVersion: null,
          errorCode: response.status === 426 ? 'unsupported_client' : 'feature_unavailable'
        })
      }
      const payload: unknown = await response.json()
      if (!isFeaturePayload(payload)) {
        return this.update({
          managedLoginEnabled: false,
          managedChatEnabled: false,
          minimumClientVersion: null,
          errorCode: 'feature_unavailable'
        })
      }
      if (!isVersionAtLeast(this.clientVersion, payload.minimum_client_version)) {
        return this.update({
          managedLoginEnabled: false,
          managedChatEnabled: false,
          minimumClientVersion: payload.minimum_client_version,
          errorCode: 'unsupported_client'
        })
      }
      return this.update({
        managedLoginEnabled: payload.managed_login_enabled,
        managedChatEnabled: payload.managed_chat_enabled === true,
        minimumClientVersion: payload.minimum_client_version,
        errorCode: payload.managed_login_enabled ? null : 'managed_login_disabled'
      })
    } catch {
      return this.update({
        managedLoginEnabled: false,
        managedChatEnabled: false,
        minimumClientVersion: null,
        errorCode: 'feature_unavailable'
      })
    }
  }

  /** 写入不可变快照，避免把响应对象引用传出。 */
  private update(next: ManagedFeatureSnapshot): ManagedFeatureSnapshot {
    this.snapshot = { ...next }
    return this.getSnapshot()
  }
}

/** 校验 Feature Flag 契约中固定的字段和 semver 格式。 */
function isFeaturePayload(value: unknown): value is {
  version: 1
  managed_login_enabled: boolean
  managed_chat_enabled?: unknown
  minimum_client_version: string
} {
  if (!value || typeof value !== 'object') {
    return false
  }
  const payload = value as Record<string, unknown>
  return (
    payload.version === 1 &&
    typeof payload.managed_login_enabled === 'boolean' &&
    typeof payload.minimum_client_version === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(payload.minimum_client_version)
  )
}

/** 比较契约允许的基础 semver，预发布版本低于同号正式版本。 */
export function isVersionAtLeast(current: string, minimum: string): boolean {
  const left = parseVersion(current)
  const right = parseVersion(minimum)
  if (!left || !right) {
    return false
  }
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) {
      return left.numbers[index] > right.numbers[index]
    }
  }
  if (!left.prerelease && !right.prerelease) {
    return true
  }
  if (!left.prerelease) {
    return true
  }
  if (!right.prerelease) {
    return false
  }
  return left.prerelease.localeCompare(right.prerelease) >= 0
}

function parseVersion(value: string): { numbers: [number, number, number]; prerelease: string | null } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
  if (!match) {
    return null
  }
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || null
  }
}
