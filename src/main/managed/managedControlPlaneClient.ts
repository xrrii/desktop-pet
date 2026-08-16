import { randomUUID } from 'node:crypto'
import type { ManagedEndpointPolicy } from './managedOAuthTypes'

/** 控制面业务错误的稳定分类，禁止携带响应正文。 */
export type ManagedControlPlaneErrorCode =
  | 'authentication_required'
  | 'token_expired'
  | 'device_revoked'
  | 'device_access_denied'
  | 'device_not_found'
  | 'device_conflict'
  | 'unsupported_client_version'
  | 'invalid_request'
  | 'internal_error'
  | 'network_error'
  | null

/** 控制面请求失败异常，日志和 Renderer 只能使用这些结构化字段。 */
export class ManagedControlPlaneError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: ManagedControlPlaneErrorCode,
    readonly retryable: boolean,
    readonly requestId: string | null = null
  ) {
    super('Managed 控制面请求失败。')
    this.name = 'ManagedControlPlaneError'
  }
}

/** 控制面设备响应的内部表示。 */
export interface ManagedControlPlaneDevice {
  id: string
  displayName: string
  current: boolean
  status: 'active' | 'revoked'
  createdAt: string
  lastSeenAt: string
}

/** 设备注册请求的内部表示。 */
export interface ManagedDeviceRegistrationInput {
  deviceId: string
  displayName: string
  platform: 'windows'
}

/** 调用设备控制面 API，统一请求头、超时和 ErrorEnvelope 解析。 */
export class ManagedControlPlaneClient {
  constructor(
    private readonly policy: ManagedEndpointPolicy,
    private readonly clientVersion: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  /** 查询 Access Token 当前绑定的设备。 */
  async getCurrentDevice(accessToken: string): Promise<ManagedControlPlaneDevice> {
    const payload = await this.request<unknown>('/api/v1/devices/current', {
      method: 'GET',
      accessToken
    })
    return requireDevice(payload)
  }

  /** 注册或幂等更新当前桌面设备。 */
  async registerDevice(
    accessToken: string,
    input: ManagedDeviceRegistrationInput
  ): Promise<ManagedControlPlaneDevice> {
    const payload = await this.request<unknown>('/api/v1/devices', {
      method: 'POST',
      accessToken,
      body: input
    })
    return requireDevice(payload)
  }

  /** 撤销当前桌面设备及其服务端授权关联。 */
  async revokeDevice(accessToken: string, deviceId: string): Promise<void> {
    await this.request<null>(`/api/v1/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      accessToken,
      expectBody: false
    })
  }

  /** 发送一个不记录凭据的控制面请求。 */
  private async request<T>(
    resourcePath: string,
    options: {
      method: 'GET' | 'POST' | 'DELETE'
      accessToken: string
      body?: unknown
      expectBody?: boolean
    }
  ): Promise<T> {
    const requestId = randomUUID()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.accessToken}`,
      Accept: 'application/json',
      'X-PetDock-Client-Version': this.clientVersion,
      'X-PetDock-Request-Id': requestId
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    let response: Response
    try {
      response = await this.fetcher(new URL(resourcePath, this.policy.controlPlaneBaseUrl), {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(10_000)
      })
    } catch {
      throw new ManagedControlPlaneError(null, 'network_error', true, requestId)
    }

    if (response.ok) {
      if (options.expectBody === false || response.status === 204) {
        return null as T
      }
      try {
        return await response.json() as T
      } catch {
        throw new ManagedControlPlaneError(response.status, 'internal_error', false, requestId)
      }
    }

    const envelope = await readErrorEnvelope(response)
    throw new ManagedControlPlaneError(
      response.status,
      envelope.code ?? mapHttpStatus(response.status),
      envelope.retryable ?? (response.status === 429 || response.status >= 500),
      envelope.requestId ?? requestId
    )
  }
}

/** 只解析契约 ErrorEnvelope 的稳定字段，不保留原始响应。 */
async function readErrorEnvelope(response: Response): Promise<{
  code: ManagedControlPlaneErrorCode
  retryable: boolean | null
  requestId: string | null
}> {
  try {
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object') {
      return { code: null, retryable: null, requestId: null }
    }
    const detail = (payload as { error?: unknown }).error
    if (!detail || typeof detail !== 'object') {
      return { code: null, retryable: null, requestId: null }
    }
    const value = detail as Record<string, unknown>
    return {
      code: isErrorCode(value.code) ? value.code : null,
      retryable: typeof value.retryable === 'boolean' ? value.retryable : null,
      requestId: typeof value.requestId === 'string' ? value.requestId : null
    }
  } catch {
    return { code: null, retryable: null, requestId: null }
  }
}

/** 将 HTTP 状态映射到最小稳定错误分类。 */
function mapHttpStatus(status: number): ManagedControlPlaneErrorCode {
  if (status === 401) return 'authentication_required'
  if (status === 403) return 'device_access_denied'
  if (status === 404) return 'device_not_found'
  if (status === 409) return 'device_conflict'
  if (status === 426) return 'unsupported_client_version'
  if (status === 400) return 'invalid_request'
  return status >= 500 ? 'internal_error' : null
}

/** 校验服务端错误码是否属于当前契约目录。 */
function isErrorCode(value: unknown): value is Exclude<ManagedControlPlaneErrorCode, null> {
  return [
    'authentication_required',
    'token_expired',
    'device_revoked',
    'device_access_denied',
    'device_not_found',
    'device_conflict',
    'unsupported_client_version',
    'invalid_request',
    'internal_error',
    'network_error'
  ].includes(value as string)
}

/** 严格校验服务端设备快照，防止不可信响应进入 Main 会话状态。 */
function requireDevice(value: unknown): ManagedControlPlaneDevice {
  if (!value || typeof value !== 'object') {
    throw new ManagedControlPlaneError(null, 'internal_error', false)
  }
  const device = value as Record<string, unknown>
  if (
    typeof device.id !== 'string' || !isUuid(device.id) ||
    typeof device.displayName !== 'string' || [...device.displayName].length < 1 || [...device.displayName].length > 100 ||
    typeof device.current !== 'boolean' ||
    (device.status !== 'active' && device.status !== 'revoked') ||
    typeof device.createdAt !== 'string' || !isTimestamp(device.createdAt) ||
    typeof device.lastSeenAt !== 'string' || !isTimestamp(device.lastSeenAt)
  ) {
    throw new ManagedControlPlaneError(null, 'internal_error', false)
  }
  return {
    id: device.id,
    displayName: device.displayName,
    current: device.current,
    status: device.status,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt
  }
}

/** 校验服务端 UUID 字段。 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** 校验 UTC RFC3339 时间字符串。 */
function isTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value))
}
