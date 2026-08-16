import type { Configuration } from 'openid-client'

/** 端点环境分类；生产/预发布不允许被运行时覆盖。 */
export type ManagedEnvironment = 'local-mock' | 'shared-dev' | 'staging' | 'production'

/** Main 内部使用的端点策略，不通过 IPC 暴露。 */
export interface ManagedEndpointPolicy {
  readonly environment: ManagedEnvironment
  readonly issuer: URL
  readonly controlPlaneBaseUrl: URL
}

/** 一次授权准备结果，Verifier 只在 Main 内存中存活。 */
export interface ManagedAuthorizationPreparation {
  readonly authorizationUrl: URL
  readonly state: string
  readonly exchange: (callbackUrl: URL) => Promise<ManagedTokenSet>
}

/** OAuth Token Response 的 Main 内存表示。 */
export interface ManagedTokenSet {
  readonly accessToken: string
  readonly refreshToken: string | null
  readonly tokenType: string
  readonly expiresIn: number | null
  readonly scope: string | null
  readonly idToken: string | null
  readonly idTokenSubject?: string | null
}

/** OIDC 客户端依赖的最小可替换接口，供本地 Mock OAuth 测试使用。 */
export interface ManagedOAuthClient {
  prepare(redirectUri: string): Promise<ManagedAuthorizationPreparation>
  refresh(refreshToken: string): Promise<ManagedTokenSet>
  fetchUserInfo?(accessToken: string, expectedSubject?: string | null): Promise<ManagedUserInfo>
  revokeRefreshToken?(refreshToken: string): Promise<void>
}

/** OIDC UserInfo 的最小原始字段，未知字段不进入应用模型。 */
export interface ManagedUserInfo {
  sub: string
  email?: string
  email_verified?: boolean
  preferred_username?: string
  name?: string
}

/** openid-client Configuration 仅由实现模块持有，避免泄露给 Renderer。 */
export type ManagedOidcConfiguration = Configuration
