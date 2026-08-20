import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/** 读取固定契约样例，避免测试依赖当前工作目录。 */
async function example<T>(name: string): Promise<T> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples')
  return JSON.parse(await readFile(join(root, name), 'utf8')) as T
}

/** 验证 TypeScript 消费端的字段、枚举、TTL 和稳定 JSON 往返。 */
test('Managed Service v1 固定样例兼容 TypeScript', async () => {
  const capabilities = await example<any>('capability-settings.json')
  assert.equal(capabilities.version, 1)
  assert.deepEqual(Object.keys(capabilities.capabilities).sort(), ['chat', 'embedding', 'rerank', 'vision', 'web_search'])
  assert.equal(capabilities.capabilities.chat.effectiveSource, 'managed')
  assert.equal(capabilities.capabilities.vision.reason, 'user_disabled')

  const claims = await example<any>('runtime-token-claims.json')
  assert.equal(claims.iss, 'https://account.petdock.site')
  assert.equal(claims.exp - claims.iat, 15 * 60)
  assert.deepEqual(claims.capabilities, ['chat', 'embedding'])

  const usage = await example<any>('usage-event.json')
  assert.equal(usage.status, 'settled')
  assert.equal(usage.inputUnits + usage.outputUnits, 600)
  assert.equal(usage.requestFingerprint.length, 64)
  assert.equal(usage.reason, null)

  const stream = await example<any>('chat-stream-event.json')
  assert.equal(stream.type, 'delta')
  assert.equal(stream.sequence, 1)
  assert.match(stream.traceId, /^[0-9a-f-]{36}$/)

  const streamExamples = await Promise.all([
    'chat-stream-event.json',
    'chat-stream-tool-call.json',
    'chat-stream-usage.json',
    'chat-stream-completed.json',
    'chat-stream-error.json'
  ].map((name) => example<any>(name)))
  assert.deepEqual(streamExamples.map((item) => item.type), ['delta', 'tool_call', 'usage', 'completed', 'error'])
  assert.deepEqual(streamExamples.slice(0, 4).map((item) => item.sequence), [1, 2, 3, 4])
  assert.equal(new Set(streamExamples.slice(0, 4).map((item) => item.traceId)).size, 1)
  assert.equal(new Set(streamExamples.slice(0, 4).map((item) => item.requestId)).size, 1)
  assert.equal(streamExamples.at(-1)?.retryAfterSeconds, 30)

  const featureFlags = await example<any>('feature-flags.json')
  assert.equal(featureFlags.managed_login_enabled, true)
  assert.equal(featureFlags.managed_chat_enabled, false)

  const chatRequest = await example<any>('chat-request.json')
  assert.equal(chatRequest.logicalModel, 'chat-standard')
  assert.equal(chatRequest.stream, true)
  assert.equal(chatRequest.tools[0].function.name, 'read_text_file')

  const reservation = await example<any>('usage-reservation-request.json')
  assert.equal(reservation.capability, 'chat')
  assert.equal(reservation.requestFingerprint.length, 64)
  const reservationResult = await example<any>('usage-reservation-response.json')
  assert.equal(reservationResult.status, 'reserved')
  assert.equal(reservationResult.replayed, false)

  const settlement = await example<any>('usage-settlement-request.json')
  const terminal = await example<any>('usage-terminal-response.json')
  assert.equal(settlement.inputUnits + settlement.outputUnits, 600)
  assert.equal(terminal.status, 'settled')

  const webUsage = await example<any>('web-usage-summary.json')
  assert.equal(webUsage.version, 1)
  assert.equal(webUsage.chat.unit, 'tokens')
  assert.equal(webUsage.chat.used + webUsage.chat.remaining, 100000)

  const anonymousWebSession = await example<any>('web-session-anonymous.json')
  assert.equal(anonymousWebSession.version, 1)
  assert.equal(anonymousWebSession.authenticated, false)
  assert.equal(anonymousWebSession.expiresAt, null)
  assert.equal(anonymousWebSession.user, null)

  const authenticatedWebSession = await example<any>('web-session-authenticated.json')
  assert.equal(authenticatedWebSession.authenticated, true)
  assert.equal(authenticatedWebSession.user.username, 'demo_user')
  assert.equal(authenticatedWebSession.user.passwordEnabled, true)

  const inactiveEntitlement = await example<any>('entitlement-inactive.json')
  assert.equal(inactiveEntitlement.status, 'inactive')
  assert.equal(inactiveEntitlement.billingMode, null)

  const subscriptionEntitlement = await example<any>('entitlement-subscription.json')
  assert.equal(subscriptionEntitlement.billingMode, 'subscription')
  assert.equal(subscriptionEntitlement.capabilities.chat.quotaMode, 'quota')
  assert.ok(subscriptionEntitlement.capabilities.chat.remaining >= 0)

  const meteredEntitlement = await example<any>('entitlement-pay-as-you-go.json')
  assert.equal(meteredEntitlement.billingMode, 'pay_as_you_go')
  assert.equal(meteredEntitlement.plan, null)
  assert.equal(meteredEntitlement.expiresAt, null)
  assert.equal(meteredEntitlement.capabilities.chat.quotaMode, 'metered')
  assert.equal(meteredEntitlement.capabilities.chat.remaining, null)

  for (const name of ['runtime-token-header.json', 'request-context.json', 'managed-auth-refresh-event.json', 'managed-auth-result.json', 'web-session-anonymous.json', 'web-session-authenticated.json', 'entitlement-inactive.json', 'entitlement-subscription.json', 'entitlement-pay-as-you-go.json', 'feature-flags.json', 'chat-request.json', 'chat-stream-tool-call.json', 'chat-stream-usage.json', 'chat-stream-completed.json', 'chat-stream-error.json', 'usage-reservation-request.json', 'usage-reservation-response.json', 'usage-settlement-request.json', 'usage-terminal-response.json', 'web-usage-summary.json']) {
    const value = await example<Record<string, unknown>>(name)
    assert.ok(Object.keys(value).length > 0)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  }
})
