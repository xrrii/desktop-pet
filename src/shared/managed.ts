/** Managed Service 登录状态，禁止包含任何 Token 或原始 OAuth 响应。 */
export type ManagedAuthState =
  | 'disabled'
  | 'idle'
  | 'preparing'
  | 'waiting_callback'
  | 'exchanging_code'
  | 'restoring_session'
  | 'authenticated'
  | 'reauth_required'
  | 'cancelled'
  | 'timed_out'
  | 'failed'
  | 'offline'
  | 'unsupported_client'

/** Main 内账号和设备同步的脱敏状态。 */
export type ManagedSessionSyncState =
  | 'idle'
  | 'syncing'
  | 'ready'
  | 'logging_out'
  | 'device_revoked'
  | 'reauth_required'
  | 'failed'

/** Renderer 只可见 Runtime Token Broker 的脱敏生命周期状态。 */
export type ManagedRuntimeSessionState =
  | 'idle'
  | 'provisioning'
  | 'waiting_runtime'
  | 'ready'
  | 'failed'

/** Runtime Session 失败的稳定分类，不包含请求正文或 Token。 */
export type ManagedRuntimeSessionErrorCode =
  | 'managed_runtime_session_failed'
  | 'managed_runtime_bridge_failed'
  | 'managed_capability_not_entitled'
  | 'managed_unsupported_client_version'
  | 'managed_authentication_required'
  | null

/** 单项官方能力的额度摘要，禁止包含 Provider 信息。 */
export interface ManagedUsageCapability {
  quotaMode: 'quota' | 'metered'
  used: number
  remaining: number | null
  unit: 'tokens' | 'requests'
}

/** Main 内部和 Renderer 可见的官方多能力额度摘要。 */
export interface ManagedUsageSummary {
  billingMode: 'subscription' | 'pay_as_you_go'
  periodStart: string
  periodEnd: string
  capabilities: {
    chat: ManagedUsageCapability
    embedding?: ManagedUsageCapability
    vision?: ManagedUsageCapability
    web_search?: ManagedUsageCapability
    rerank?: ManagedUsageCapability
  }
}

/** 额度读取在登出竞态中可能没有结果；null 表示当前没有可用登录会话。 */
export type ManagedUsageSummaryResult = ManagedUsageSummary | null

/** 服务端统一管理的官方能力名称。 */
export type ManagedCapabilityName = 'chat' | 'embedding' | 'vision' | 'web_search' | 'rerank'

/** 五项官方能力的布尔状态映射。 */
export type ManagedCapabilityStateMap = Record<ManagedCapabilityName, boolean>

/** 当前账号的官方能力偏好、套餐授权与最终有效状态。 */
export interface ManagedCapabilityPreferencesSnapshot {
  version: 1
  subscriptionActive: boolean
  plan: string | null
  preferences: ManagedCapabilityStateMap
  entitled: ManagedCapabilityStateMap
  effective: ManagedCapabilityStateMap
}

/** Renderer 可见的稳定登录错误分类。 */
export type ManagedAuthErrorCode =
  | 'managed_login_disabled'
  | 'feature_unavailable'
  | 'unsupported_client'
  | 'oauth_discovery_failed'
  | 'oauth_authorization_denied'
  | 'oauth_callback_invalid'
  | 'oauth_timeout'
  | 'oauth_cancelled'
  | 'oauth_token_exchange_failed'
  | 'managed_token_storage_unavailable'
  | 'managed_token_storage_corrupt'
  | 'managed_token_persist_failed'
  | 'managed_refresh_invalid_grant'
  | 'managed_refresh_failed'
  | 'managed_refresh_response_invalid'
  | 'managed_userinfo_failed'
  | 'managed_session_sync_failed'
  | 'managed_logout_failed'
  | 'managed_device_revoked'
  | 'managed_device_conflict'
  | 'managed_device_access_denied'
  | 'managed_device_not_found'
  | 'managed_unsupported_client_version'

/** Renderer 只能请求受控官网业务页，不允许提交任意 URL。 */
export type ManagedPortalTarget = 'overview' | 'plans' | 'devices' | 'usage' | 'billing'

/** 只包含 UserInfo 契约允许展示的账号字段。 */
export interface ManagedAccountSnapshot {
  email: string
  emailVerified: boolean
  username: string
  displayName: string
}

/** Main 内部使用的完整设备快照；deviceId 不通过 IPC 暴露。 */
export interface ManagedDeviceSnapshot {
  id: string
  displayName: string
  current: boolean
  status: 'active' | 'revoked'
  createdAt: string
  lastSeenAt: string
}

/** Renderer 可见的设备脱敏状态。 */
export interface ManagedDeviceStatus {
  displayName: string
  current: boolean
  status: 'active' | 'revoked'
  createdAt: string
  lastSeenAt: string
}

/** Main 向 Renderer 返回的脱敏认证快照。 */
export interface ManagedAuthStatus {
  state: ManagedAuthState
  managedLoginEnabled: boolean
  managedChatEnabled: boolean
  managedEmbeddingEnabled?: boolean
  managedVisionEnabled?: boolean
  managedWebSearchEnabled?: boolean
  managedRerankEnabled?: boolean
  /** 当前账号是否选择官方服务模式；与套餐是否可用相互独立。 */
  managedServiceSelected?: boolean
  /** 当前账号是否有活动套餐；null 表示尚未完成账号能力同步。 */
  managedSubscriptionActive?: boolean | null
  minimumClientVersion: string | null
  errorCode: ManagedAuthErrorCode | null
  sessionSyncState: ManagedSessionSyncState
  runtimeSessionState: ManagedRuntimeSessionState
  runtimeSessionErrorCode: ManagedRuntimeSessionErrorCode
  account: ManagedAccountSnapshot | null
  device: ManagedDeviceStatus | null
}
