import type {
  ManagedOAuthClient,
  ManagedAuthorizationPreparation,
  ManagedTokenSet,
  ManagedUserInfo
} from './managedOAuthTypes'

const CLIENT_ID = 'petdock-desktop'
const SCOPE = 'openid profile email desktop.session'

/** OIDC 客户端阶段错误，避免将第三方库原始消息传播到 Renderer 或日志。 */
export class ManagedOidcClientError extends Error {
  constructor(
    readonly stage: 'discovery' | 'authorization_denied' | 'token_exchange' | 'refresh' | 'userinfo' | 'revocation',
    readonly reason: 'invalid_grant' | 'response_invalid' | 'network' | null = null
  ) {
    super('Managed OAuth 操作失败。')
    this.name = 'ManagedOidcClientError'
  }
}

/** 使用 openid-client 执行 OIDC Discovery、PKCE S256 和授权码换 Token。 */
export class ManagedOidcClient implements ManagedOAuthClient {
  constructor(private readonly issuer: URL) {}

  /**
   * 发现服务端元数据并生成一次授权 URL；Verifier 和 state 只封装在 exchange 闭包内。
   */
  async prepare(redirectUri: string): Promise<ManagedAuthorizationPreparation> {
    const { client, configuration } = await this.discover()
    const metadata = configuration.serverMetadata()
    if (!metadata.supportsPKCE('S256')) {
      throw new Error('OAuth 服务端未声明 PKCE S256。')
    }
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new Error('OAuth 服务端缺少授权或 Token 端点。')
    }

    const codeVerifier = client.randomPKCECodeVerifier()
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
    const state = client.randomState()
    const authorizationUrl = client.buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state
    })

    return {
      authorizationUrl,
      state,
      exchange: async (callbackUrl: URL): Promise<ManagedTokenSet> => {
        try {
          const response = await client.authorizationCodeGrant(configuration, callbackUrl, {
            pkceCodeVerifier: codeVerifier,
            expectedState: state
          })
          return normalizeTokenResponse(response)
        } catch (error) {
          if (error instanceof ManagedOidcClientError) {
            throw error
          }
          if (error instanceof Error && /access_denied|authorization request was denied/i.test(error.message)) {
            throw new ManagedOidcClientError('authorization_denied')
          }
          throw new ManagedOidcClientError('token_exchange')
        }
      }
    }
  }

  /** 执行无客户端密钥的 Refresh Token Grant，并要求服务端返回轮换后的新 Refresh Token。 */
  async refresh(refreshToken: string): Promise<ManagedTokenSet> {
    if (!refreshToken) {
      throw new ManagedOidcClientError('refresh', 'response_invalid')
    }
    const { client, configuration } = await this.discover()
    const metadata = configuration.serverMetadata()
    if (!metadata.token_endpoint || !metadata.grant_types_supported?.includes('refresh_token')) {
      throw new ManagedOidcClientError('refresh', 'response_invalid')
    }

    let response
    try {
      response = await client.refreshTokenGrant(configuration, refreshToken)
    } catch (error) {
      if (isInvalidGrantError(error)) {
        throw new ManagedOidcClientError('refresh', 'invalid_grant')
      }
      const responseStatus = getResponseStatus(error)
      if (responseStatus === 429 || (responseStatus !== null && responseStatus >= 500)) {
        throw new ManagedOidcClientError('refresh', 'network')
      }
      if (responseStatus !== null) {
        throw new ManagedOidcClientError('refresh', 'response_invalid')
      }
      throw new ManagedOidcClientError('refresh', 'network')
    }
    try {
      return normalizeTokenResponse(response, true)
    } catch {
      throw new ManagedOidcClientError('refresh', 'response_invalid')
    }
  }

  /** 使用短期 Access Token 获取 OIDC UserInfo，启动恢复时跳过无法持久化的 ID Token subject 对比。 */
  async fetchUserInfo(accessToken: string, expectedSubject?: string | null): Promise<ManagedUserInfo> {
    if (!accessToken) {
      throw new ManagedOidcClientError('userinfo', 'response_invalid')
    }
    const { client, configuration } = await this.discover()
    const metadata = configuration.serverMetadata()
    if (!metadata.userinfo_endpoint) {
      throw new ManagedOidcClientError('userinfo', 'response_invalid')
    }
    try {
      const response = await client.fetchUserInfo(
        configuration,
        accessToken,
        expectedSubject || client.skipSubjectCheck
      )
      return response as ManagedUserInfo
    } catch (error) {
      const responseStatus = getResponseStatus(error)
      if (responseStatus === 401 || responseStatus === 403) {
        throw new ManagedOidcClientError('userinfo', 'invalid_grant')
      }
      if (responseStatus === 429 || (responseStatus !== null && responseStatus >= 500)) {
        throw new ManagedOidcClientError('userinfo', 'network')
      }
      throw new ManagedOidcClientError('userinfo', responseStatus === null ? 'network' : 'response_invalid')
    }
  }

  /** 通过 RFC 7009 撤销 Refresh Token，显式提交 Public Client ID 和 Token 类型提示。 */
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    if (!refreshToken) {
      throw new ManagedOidcClientError('revocation', 'response_invalid')
    }
    const { client, configuration } = await this.discover()
    const metadata = configuration.serverMetadata()
    if (!metadata.revocation_endpoint) {
      throw new ManagedOidcClientError('revocation', 'response_invalid')
    }
    try {
      await client.tokenRevocation(configuration, refreshToken, {
        client_id: CLIENT_ID,
        token_type_hint: 'refresh_token'
      })
    } catch {
      throw new ManagedOidcClientError('revocation', 'network')
    }
  }

  /** 统一完成 Discovery，并允许 local-mock 使用 HTTP，其余环境仍由端点策略约束。 */
  private async discover(): Promise<{
    client: typeof import('openid-client')
    configuration: Awaited<ReturnType<(typeof import('openid-client'))['discovery']>>
  }> {
    const client = await import('openid-client')
    const options = this.issuer.protocol === 'http:'
      ? { execute: [client.allowInsecureRequests] }
      : undefined
    try {
      const configuration = await client.discovery(
        this.issuer,
        CLIENT_ID,
        { token_endpoint_auth_method: 'none' },
        client.None(),
        options
      )
      return { client, configuration }
    } catch {
      throw new ManagedOidcClientError('discovery')
    }
  }
}

/** 只提取冻结 Token Response 字段，拒绝空 Access Token 和非正 TTL。 */
function normalizeTokenResponse(response: {
  access_token: string
  token_type?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  id_token?: string
  claims?: () => { sub?: unknown } | undefined
}, requireRefreshToken = false): ManagedTokenSet {
  if (!response || !response.access_token || typeof response.access_token !== 'string') {
    throw new Error('OAuth Token Response 缺少 Access Token。')
  }
  if (response.expires_in !== undefined && (!Number.isInteger(response.expires_in) || response.expires_in <= 0)) {
    throw new Error('OAuth Token Response 的有效期无效。')
  }
  if (response.refresh_token !== undefined && typeof response.refresh_token !== 'string') {
    throw new Error('OAuth Token Response 的 Refresh Token 无效。')
  }
  if (requireRefreshToken && !response.refresh_token) {
    throw new Error('OAuth Refresh Response 缺少轮换后的 Refresh Token。')
  }
  const tokenType = response.token_type || 'Bearer'
  if (typeof tokenType !== 'string') {
    throw new Error('OAuth Token Response 的 Token 类型无效。')
  }
  if (tokenType.toLowerCase() !== 'bearer') {
    throw new Error('OAuth Token Response 的 Token 类型不受支持。')
  }
  const idTokenClaims = response.claims?.()
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token || null,
    tokenType: 'Bearer',
    expiresIn: response.expires_in ?? null,
    scope: response.scope || null,
    idToken: response.id_token || null,
    idTokenSubject: typeof idTokenClaims?.sub === 'string' ? idTokenClaims.sub : null
  }
}

/** 只根据 OAuth 标准错误字段识别 invalid_grant，不读取或记录 Token 内容。 */
function isInvalidGrantError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'error' in error &&
      (error as { error?: unknown }).error === 'invalid_grant'
  )
}

/** 区分 Token Endpoint 返回的结构化错误和网络/连接异常。 */
function getResponseStatus(error: unknown): number | null {
  if (
    error &&
      typeof error === 'object' &&
      'status' in error &&
      typeof (error as { status?: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status
  }
  return null
}

/** 固定桌面 OAuth Public Client ID，避免从 Renderer 传入任意 Client。 */
export const managedOAuthClientId = CLIENT_ID
