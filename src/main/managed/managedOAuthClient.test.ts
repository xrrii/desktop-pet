import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { exportJWK, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { ManagedOidcClient } from './managedOAuthClient'

describe('ManagedOidcClient', () => {
  it('通过本地 Mock OIDC 完成 Discovery、PKCE 授权 URL 和 Token Exchange', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const publicJwk = { ...(await exportJWK(publicKey)), kid: 'mock-key', use: 'sig', alg: 'RS256' }
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      if (request.url === '/.well-known/openid-configuration') {
        const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        writeJson(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          code_challenge_methods_supported: ['S256'],
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none']
        })
        return
      }
      if (request.url === '/.well-known/jwks.json') {
        writeJson(response, 200, { keys: [publicJwk] })
        return
      }
      if (request.url === '/oauth2/token' && request.method === 'POST') {
        let body = ''
        for await (const chunk of request) {
          body += chunk
        }
        const parameters = new URLSearchParams(body)
        expect(parameters.get('code_verifier')).toBeTruthy()
        expect(parameters.get('redirect_uri')).toBe('http://127.0.0.1:49152/oauth/callback')
        const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        const idToken = await new SignJWT({ sub: 'mock-user', nonce: undefined })
          .setProtectedHeader({ alg: 'RS256', kid: 'mock-key' })
          .setIssuer(issuer)
          .setAudience('petdock-desktop')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey)
        writeJson(response, 200, {
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          refresh_token: 'mock-refresh-token',
          scope: 'openid desktop.session',
          id_token: idToken
        })
        return
      }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const issuer = new URL(`http://127.0.0.1:${port}`)

    try {
      const prepared = await new ManagedOidcClient(issuer).prepare(
        'http://127.0.0.1:49152/oauth/callback'
      )
      expect(prepared.authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
      expect(prepared.authorizationUrl.searchParams.get('state')).toBe(prepared.state)
      expect(prepared.authorizationUrl.searchParams.get('scope')).toBe('openid desktop.session')

      await expect(prepared.exchange(new URL(
        'http://127.0.0.1:49152/oauth/callback?code=mock-code&state=' + prepared.state
      ))).resolves.toMatchObject({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        tokenType: 'Bearer'
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(value))
}
