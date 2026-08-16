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

/** Main 向 Renderer 返回的脱敏认证快照。 */
export interface ManagedAuthStatus {
  state: ManagedAuthState
  managedLoginEnabled: boolean
  minimumClientVersion: string | null
  errorCode: ManagedAuthErrorCode | null
}
