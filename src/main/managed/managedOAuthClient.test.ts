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
      expect(prepared.authorizationUrl.searchParams.get('scope')).toBe('openid profile email desktop.session')

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

  it('使用 Refresh Token Grant，并要求返回轮换后的 Refresh Token', async () => {
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
      if (request.url === '/oauth2/token' && request.method === 'POST') {
        let body = ''
        for await (const chunk of request) {
          body += chunk
        }
        const parameters = new URLSearchParams(body)
        expect(parameters.get('grant_type')).toBe('refresh_token')
        expect(parameters.get('refresh_token')).toBe('old-refresh-token')
        expect(parameters.getAll('client_id')).toEqual(['petdock-desktop'])
        expect(parameters.get('client_secret')).toBeNull()
        writeJson(response, 200, {
          access_token: 'rotated-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          refresh_token: 'rotated-refresh-token',
          scope: 'openid desktop.session'
        })
        return
      }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      await expect(new ManagedOidcClient(new URL(`http://127.0.0.1:${port}`)).refresh('old-refresh-token'))
        .resolves.toMatchObject({
          accessToken: 'rotated-access-token',
          refreshToken: 'rotated-refresh-token',
          idToken: null
        })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('将 OAuth invalid_grant 转为稳定刷新错误', async () => {
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      if (request.url === '/.well-known/openid-configuration') {
        const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        writeJson(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          grant_types_supported: ['refresh_token'],
          token_endpoint_auth_methods_supported: ['none']
        })
        return
      }
      if (request.url === '/oauth2/token') {
        writeJson(response, 400, { error: 'invalid_grant' })
        return
      }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      await expect(new ManagedOidcClient(new URL(`http://127.0.0.1:${port}`)).refresh('reused-refresh-token'))
        .rejects.toMatchObject({ stage: 'refresh', reason: 'invalid_grant' })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('获取 UserInfo 并按 RFC 7009 撤销 Refresh Token', async () => {
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      if (request.url === '/.well-known/openid-configuration') {
        writeJson(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          revocation_endpoint: `${issuer}/oauth2/revoke`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none']
        })
        return
      }
      if (request.url === '/userinfo' && request.method === 'GET') {
        expect(request.headers.authorization).toBe('Bearer synthetic-access-token')
        writeJson(response, 200, {
          sub: 'opaque-subject',
          email: 'alice@example.test',
          email_verified: true,
          preferred_username: 'alice',
          name: 'Alice'
        })
        return
      }
      if (request.url === '/oauth2/revoke' && request.method === 'POST') {
        let body = ''
        for await (const chunk of request) body += chunk
        const parameters = new URLSearchParams(body)
        expect(parameters.get('client_id')).toBe('petdock-desktop')
        expect(parameters.get('token')).toBe('synthetic-refresh-token')
        expect(parameters.get('token_type_hint')).toBe('refresh_token')
        response.statusCode = 200
        response.end()
        return
      }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const client = new ManagedOidcClient(new URL(`http://127.0.0.1:${port}`))

    try {
      await expect(client.fetchUserInfo('synthetic-access-token', 'opaque-subject')).resolves.toMatchObject({
        sub: 'opaque-subject',
        preferred_username: 'alice'
      })
      await expect(client.revokeRefreshToken('synthetic-refresh-token')).resolves.toBeUndefined()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('拒绝没有轮换 Refresh Token 的刷新响应', async () => {
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      if (request.url === '/.well-known/openid-configuration') {
        const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        writeJson(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          grant_types_supported: ['refresh_token'],
          token_endpoint_auth_methods_supported: ['none']
        })
        return
      }
      if (request.url === '/oauth2/token') {
        writeJson(response, 200, {
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 300
        })
        return
      }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      await expect(new ManagedOidcClient(new URL(`http://127.0.0.1:${port}`)).refresh('old-refresh-token'))
        .rejects.toMatchObject({ stage: 'refresh', reason: 'response_invalid' })
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
