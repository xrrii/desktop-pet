import type { ManagedOAuthClient, ManagedAuthorizationPreparation, ManagedTokenSet } from './managedOAuthTypes'

const CLIENT_ID = 'petdock-desktop'
const SCOPE = 'openid desktop.session'

/** OIDC 客户端阶段错误，避免将第三方库原始消息传播到 Renderer 或日志。 */
export class ManagedOidcClientError extends Error {
  constructor(readonly stage: 'discovery' | 'authorization_denied' | 'token_exchange') {
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
    const client = await import('openid-client')
    const options = this.issuer.protocol === 'http:'
      ? { execute: [client.allowInsecureRequests] }
      : undefined
    let configuration
    try {
      configuration = await client.discovery(
        this.issuer,
        CLIENT_ID,
        { token_endpoint_auth_method: 'none' },
        client.None(),
        options
      )
    } catch {
      throw new ManagedOidcClientError('discovery')
    }
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
          if (error instanceof Error && /access_denied|authorization request was denied/i.test(error.message)) {
            throw new ManagedOidcClientError('authorization_denied')
          }
          throw new ManagedOidcClientError('token_exchange')
        }
      }
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
}): ManagedTokenSet {
  if (!response.access_token || typeof response.access_token !== 'string') {
    throw new Error('OAuth Token Response 缺少 Access Token。')
  }
  if (response.expires_in !== undefined && (!Number.isInteger(response.expires_in) || response.expires_in <= 0)) {
    throw new Error('OAuth Token Response 的有效期无效。')
  }
  const tokenType = response.token_type || 'Bearer'
  if (tokenType.toLowerCase() !== 'bearer') {
    throw new Error('OAuth Token Response 的 Token 类型不受支持。')
  }
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token || null,
    tokenType: 'Bearer',
    expiresIn: response.expires_in ?? null,
    scope: response.scope || null,
    idToken: response.id_token || null
  }
}

/** 固定桌面 OAuth Public Client ID，避免从 Renderer 传入任意 Client。 */
export const managedOAuthClientId = CLIENT_ID
