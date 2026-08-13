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

  const stream = await example<any>('chat-stream-event.json')
  assert.equal(stream.type, 'delta')
  assert.equal(stream.sequence, 1)
  assert.match(stream.traceId, /^[0-9a-f-]{36}$/)

  for (const name of ['runtime-token-header.json', 'request-context.json', 'managed-auth-refresh-event.json', 'managed-auth-result.json']) {
    const value = await example<Record<string, unknown>>(name)
    assert.ok(Object.keys(value).length > 0)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  }
})
