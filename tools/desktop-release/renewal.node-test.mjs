import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArguments } from './arguments.mjs'
import { callRemote, loadConfig, loadPolicy, runProcess } from './io.mjs'
import { createRenewal, resumeRenewal, startRenewal, verifySnapshot } from './renewal.mjs'
import { runScheduled, taskScript } from './renewal_task.mjs'

const id = '00000000-0000-4000-8000-000000000001'
const day = 86_400_000

/** 所有密钥和目录均为合成输入，只清理本轮创建的受控子目录。 */
async function scenario(callback, days = 1) {
  await mkdir('temp', { recursive: true })
  const directory = await mkdtemp(resolve('temp/renewal-test-'))
  try {
    const policy = { ...await loadPolicy(resolve('.')) }
    const pair = generateKeyPairSync('ed25519')
    policy.DESKTOP_UPDATE_TRUST = { keys: { test: pair.publicKey.export({ type: 'spki', format: 'pem' }) }, revokedKeyIds: [] }
    const privateKeyFile = join(directory, 'synthetic.pem')
    await writeFile(privateKeyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const now = Math.floor(Date.now() / 1000) * 1000
    const utc = (time) => new Date(time).toISOString().replace('.000Z', 'Z')
    const manifest = { schemaVersion: 1, appId: 'com.local.petdock', version: '0.2.5', channel: 'stable', platform: 'win32', arch: 'x64',
      artifact: { kind: 'nsis', fileName: 'PetDock Setup 0.2.5.exe', size: 42, sha512: createHash('sha512').update('synthetic').digest('base64') },
      issuedAt: utc(now - (days < 0 ? 2 : 1) * day), expiresAt: utc(now + days * day) }
    const bytes = Buffer.from(JSON.stringify(manifest))
    const envelope = { schemaVersion: 1, keyId: 'test', manifest: bytes.toString('base64'),
      signature: sign(null, Buffer.concat([Buffer.from('PetDock desktop update manifest v1\ntest\n'), bytes]), pair.privateKey).toString('base64') }
    const snapshot = { schemaVersion: 1, releaseId: id, status: 'snapshot', version: manifest.version,
      manifest: envelope, baseline: { catalogHash: 'a'.repeat(64), trustHash: 'b'.repeat(64), controlHash: 'c'.repeat(64) }, paused: false, versionCount: 1 }
    await callback({ directory, policy, config: { signing: { keyId: 'test', privateKeyFile } }, snapshot, manifest, now })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('新旧发布参数互斥，自动续签拒绝迁移和重复参数', () => {
  assert.equal(parseArguments(['--version', '0.2.6'], 'synthetic').mode, 'version')
  assert.equal(parseArguments(['--resume', id], 'synthetic').value, id)
  assert.equal(parseArguments(['--renew', '--if-due'], 'synthetic').ifDue, true)
  for (const args of [['--renew', '--version', '0.2.6'], ['--renew', '--if-due', '--migrate-current'],
    ['--resume', id, '--if-due'], ['--renew', '--renew'], ['--config'], ['--renew', '--yes']]) {
    assert.throws(() => parseArguments(args, 'synthetic'))
  }
})

for (const expired of [false, true]) {
  test(`续签${expired ? '已过期' : '临期'}清单只刷新时间，客户端仍拒绝旧过期清单`, async () => scenario(async (flow) => {
    const { snapshot, policy, config, manifest, now } = flow
    if (expired) assert.throws(() => policy.verifySignedUpdateManifest(snapshot.manifest, policy.DESKTOP_UPDATE_TRUST, manifest.version, now))
    const envelope = await createRenewal(snapshot, id, config, policy, now)
    const renewed = policy.verifySignedUpdateManifest(envelope, policy.DESKTOP_UPDATE_TRUST, manifest.version, now).manifest
    assert.deepEqual(renewed, { ...manifest, issuedAt: new Date(now).toISOString().replace('.000Z', 'Z'), expiresAt: new Date(now + 29 * day).toISOString().replace('.000Z', 'Z') })
    assert.throws(() => policy.verifySignedUpdateManifest(envelope, policy.DESKTOP_UPDATE_TRUST, manifest.version, now + 29 * day))
  }, expired ? -1 : 1))
}

test('原签名篡改、未知公钥、错误快照和未来签发时间均拒绝维护', async () => scenario(async ({ snapshot, policy, config, now }) => {
  for (const changed of [{ ...snapshot, releaseId: 'wrong' }, { ...snapshot, versionCount: 17 },
    { ...snapshot, paused: 'false' }, { ...snapshot, baseline: { ...snapshot.baseline, extra: 'x' } },
    { ...snapshot, manifest: { ...snapshot.manifest, signature: Buffer.alloc(64).toString('base64') } }]) {
    assert.throws(() => verifySnapshot(changed, id, policy, now))
  }
  await assert.rejects(createRenewal(snapshot, id, { signing: { ...config.signing, keyId: 'other' } }, policy, now), /签名身份/)
  const revoked = { ...policy, DESKTOP_UPDATE_TRUST: { ...policy.DESKTOP_UPDATE_TRUST, revokedKeyIds: ['test'] } }
  assert.throws(() => verifySnapshot(snapshot, id, revoked, now))
  assert.throws(() => verifySnapshot(snapshot, id, policy, now - 3 * day))
}))

test('有效期超过14天时任务只查询快照，不读取私钥或生成事务', async () => scenario(async ({ directory, policy, config, snapshot }) => {
  const calls = []
  await startRenewal({ ifDue: true, migration: false }, { signing: { ...config.signing, privateKeyFile: 'missing' } }, policy, directory, {
    remote: async (action, request) => { calls.push(action); return { ...snapshot, releaseId: request.releaseId } }, log: () => {}
  })
  assert.deepEqual(calls, ['snapshot'])
  assert.deepEqual((await readdir(directory)).sort(), ['synthetic.pem'])
}, 20))

for (const paused of [false, true]) {
  test(`当前版续签保留暂停=${paused}，不请求整包并可复用原请求恢复`, async () => scenario(async ({ directory, policy, config, snapshot }) => {
    const calls = []
    let state
    await startRenewal({ ifDue: true, migration: false }, config, policy, directory, {
      remote: async (action, request) => {
        calls.push(action)
        if (action === 'snapshot') return { ...snapshot, releaseId: request.releaseId, paused }
        state = request
        return { schemaVersion: 1, releaseId: request.releaseId, version: request.version, status: 'committed', operation: 'renew',
          artifact: request.artifact, paused, expiresAt: JSON.parse(Buffer.from(request.envelope.manifest, 'base64')).expiresAt }
      }, verifyHttps: async (_request, full) => { assert.equal(full, false); calls.push('https') }, log: () => {}
    })
    assert.deepEqual(calls, paused ? ['snapshot', 'renew'] : ['snapshot', 'renew', 'https'])
    assert.equal(state.migration, false)
    const saved = JSON.parse(await readFile(join(directory, state.releaseId, 'state.json'), 'utf8'))
    assert.equal(saved.phase, 'committed')
    const requestBytes = JSON.stringify(saved.envelope)
    await resumeRenewal(saved, policy, {
      remote: async (_action, request) => {
        assert.equal(JSON.stringify(request.envelope), requestBytes)
        return { schemaVersion: 1, releaseId: request.releaseId, version: request.version, status: 'committed', operation: 'renew',
          artifact: request.artifact, paused, expiresAt: JSON.parse(Buffer.from(request.envelope.manifest, 'base64')).expiresAt }
      }, save: async () => {}, verifyHttps: async () => {}, log: () => {}
    })
  }))
}

test('历史目录定时任务拒绝迁移；交互取消不生成候选或写服务器', async () => scenario(async ({ directory, policy, config, snapshot }) => {
  const remote = async (action, request) => { assert.equal(action, 'snapshot'); return { ...snapshot, releaseId: request.releaseId, versionCount: 2 } }
  await assert.rejects(startRenewal({ ifDue: true, migration: false }, config, policy, directory, { remote, log: () => {} }), /历史版本/)
  await startRenewal({ migration: true }, config, policy, directory, { remote, confirmMigration: async () => false, log: () => {} })
  assert.deepEqual((await readdir(directory)).sort(), ['synthetic.pem'])
}))

for (const failure of ['disconnect', 'wrong-paused', 'aborted', 'tampered-artifact']) {
  test(`续签失败边界 ${failure} 不记为本地提交，也不通过HTTPS验收`, async () => scenario(async ({ policy, config, snapshot }) => {
    const envelope = await createRenewal(snapshot, id, config, policy)
    const state = { operation: 'renew', releaseId: id, version: snapshot.version, phase: 'signed',
      migration: false, envelope, snapshot, baseline: snapshot.baseline }
    if (failure === 'tampered-artifact') state.version = '0.2.6'
    let saved = false
    let https = false
    await assert.rejects(resumeRenewal(state, policy, {
      remote: async (_action, request) => {
        if (failure === 'disconnect') throw new Error('synthetic disconnect')
        return { schemaVersion: 1, releaseId: id, version: request.version, operation: 'renew',
          status: failure === 'aborted' ? 'aborted' : 'committed', artifact: request.artifact,
          paused: failure === 'wrong-paused', expiresAt: JSON.parse(Buffer.from(envelope.manifest, 'base64')).expiresAt }
      }, save: async () => { saved = true }, verifyHttps: async () => { https = true }, log: () => {}
    }))
    assert.equal(saved, false)
    assert.equal(https, false)
  }))
}

test('续签配置不依赖COS SDK、上传凭据或Cloud检出目录', async () => scenario(async ({ directory }) => {
  const repo = join(directory, 'repo')
  await mkdir(repo)
  const identityFile = join(directory, 'synthetic-ssh.pem')
  const privateKeyFile = join(directory, 'synthetic.pem')
  await writeFile(identityFile, 'synthetic ssh identity')
  const configPath = join(directory, 'config.json')
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, ssh: { host: 'ubuntu@192.0.2.1', port: 22, identityFile }, signing: { keyId: 'test', privateKeyFile } }))
  const config = await loadConfig(configPath, repo, 'renew')
  assert.equal(config.signing.privateKeyFile, privateKeyFile)
  assert.equal(config.cosCredentialsFile, undefined)
}))

test('续签SSH仍只使用固定入口，传输原始基线和迁移批准', async () => {
  const release = { releaseId: id, version: '0.2.5', envelope: { synthetic: true }, baseline: { synthetic: true }, migration: false }
  await callRemote({ ssh: { host: 'ubuntu@192.0.2.1', port: 22, identityFile: 'C:/synthetic/key.pem' } }, 'renew', release, async (_exe, args, options) => {
    assert.equal(args.at(-1), 'sudo -n /usr/local/sbin/petdock-desktop-release')
    assert.deepEqual(JSON.parse(options.input), { schemaVersion: 1, action: 'renew', releaseId: id, version: '0.2.5', manifest: release.envelope, baseline: release.baseline, migration: false })
    return JSON.stringify({ status: 'committed' })
  })
})

test('计划任务定义采用现有账号、有限权限和每日及登录触发，路径不会变成表达式', () => {
  const script = taskScript('install', "C:\\synthetic user's\\config.json", 'C:\\node path\\node.exe', 'E:\\synthetic repo')
  assert.match(script, /-LogonType Interactive -RunLevel Limited/)
  assert.match(script, /-StartWhenAvailable -MultipleInstances IgnoreNew/)
  assert.match(script, /-Daily -At '10:00'/)
  assert.match(script, /-AtLogOn/)
  assert.match(script, /user''s/)
  assert.doesNotMatch(script, /Password|ExecutionPolicy|Highest/)
  assert.throws(() => taskScript('install', 'C:\\bad"\\config.json'))
})

test('Windows PowerShell 5.1 解析全部任务定义，无注册、运行或删除任务', { skip: process.platform !== 'win32' }, async () => {
  const scripts = ['install', 'status', 'remove'].map((action) => taskScript(action, "C:\\synthetic user's\\config.json"))
  const input = Buffer.from(JSON.stringify(scripts)).toString('base64')
  const script = `$sources = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')) | ConvertFrom-Json
foreach ($source in $sources) {
  $tokens = $null; $issues = $null
  [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$issues) | Out-Null
  if ($issues.Count -ne 0) { exit 1 }
}
Write-Output '3'
`
  const output = await runProcess(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
  assert.equal(output.trim(), '3')
})

test('定时入口只执行临期续签，失败日志不回显底层输出', async () => scenario(async ({ directory }) => {
  const config = join(directory, 'config.json')
  await runScheduled(config, async (_exe, args) => {
    assert.deepEqual(args.slice(1), ['--renew', '--if-due', '--config', config])
    return '当前版本尚未到续签窗口。'
  }, directory)
  await assert.rejects(runScheduled(config, async () => {
    throw Object.assign(new Error('synthetic-private-marker'), { output: `续签事务：${id}；synthetic-private-marker` })
  }, directory), /自动续签失败/)
  const logs = join(directory, 'release-runs', 'maintenance-logs')
  const content = await readFile(join(logs, (await readdir(logs))[0]), 'utf8')
  assert.match(content, /尚未到续签窗口/)
  assert.match(content, /自动续签失败/)
  assert.match(content, new RegExp(id))
  assert.doesNotMatch(content, /synthetic-private-marker/)
}))
