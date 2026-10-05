import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createPackage } from '@electron/asar'
import { acquireLock, archiveBuild, callRemote, checkUpload, forkAbortedRelease, httpsRead, loadPolicy, readJson, snapshotSource, updateVersion, verifyHttps, verifySigningKey } from './io.mjs'

/** 使用独立目录，结束只删除本次合成输出。 */
async function temporary(callback) {
  await mkdir('temp', { recursive: true })
  const directory = await mkdtemp(resolve('temp/release-test-'))
  try { await callback(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('升版本仅同步三个根版本，保留用户设置和依赖', async () => temporary(async (root) => {
  const pkg = { version: '0.2.4', custom: '用户配置', scripts: { dist: 'synthetic' } }
  const lock = { version: '0.2.4', packages: { '': { version: '0.2.4' }, dependency: { version: '1.2.3' } }, lockfileVersion: 3 }
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg))
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock))
  await updateVersion(root, '0.2.5')
  assert.deepEqual(await readJson(join(root, 'package.json')), { ...pkg, version: '0.2.5' })
  assert.equal((await readJson(join(root, 'package-lock.json'))).packages.dependency.version, '1.2.3')
  await assert.rejects(updateVersion(root, '0.2.4'), /不能低于/)
}))

test('不一致的锁版本不触发写入', async () => temporary(async (root) => {
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.2.4' }))
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '0.2.3', packages: { '': { version: '0.2.3' } } }))
  await assert.rejects(updateVersion(root, '0.2.5'), /不一致/)
  assert.equal((await readJson(join(root, 'package.json'))).version, '0.2.4')
}))

test('并发命令不能抢占已有锁，释放后可以重新获取', async () => temporary(async (root) => {
  const unlock = await acquireLock(root)
  await assert.rejects(acquireLock(root), /发布锁已存在/)
  await unlock()
  await (await acquireLock(root))()
}))

test('取消后恢复复用原签名和制品来源，不重新打包或覆盖原事务', async () => temporary(async (root) => {
  const state = { schemaVersion: 1, releaseId: 'ce7f963a-c616-419d-a60b-d1656ba38d0b', version: '0.2.5', phase: 'aborted' }
  const envelope = { manifest: 'synthetic', signature: 'same-signature' }
  await mkdir(join(root, state.releaseId))
  await writeFile(join(root, state.releaseId, 'manifest.json'), JSON.stringify(envelope))
  const next = await forkAbortedRelease(root, state)
  assert.notEqual(next.releaseId, state.releaseId)
  assert.equal(next.phase, 'signed')
  assert.equal(next.artifactReleaseId, state.releaseId)
  assert.deepEqual(await readJson(join(root, next.releaseId, 'manifest.json')), envelope)
  assert.equal(state.phase, 'aborted')
}))

test('签名预检仅接受匹配内置公钥的Ed25519私钥', async () => temporary(async (root) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const other = generateKeyPairSync('ed25519')
  const path = join(root, 'synthetic.pem')
  await writeFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const config = { signing: { privateKeyFile: path, keyId: 'test' } }
  const policy = { DESKTOP_UPDATE_TRUST: { keys: { test: publicKey.export({ type: 'spki', format: 'pem' }) }, revokedKeyIds: [] } }
  await verifySigningKey(config, policy)
  policy.DESKTOP_UPDATE_TRUST.keys.test = other.publicKey.export({ type: 'spki', format: 'pem' })
  await assert.rejects(verifySigningKey(config, policy), /不匹配/)
}))

test('归档校验真实ASAR版本及Runtime，错版不会成为成功构建', async () => temporary(async (root) => {
  const version = '0.2.5'
  const source = join(root, 'release')
  const resources = join(source, 'win-unpacked', 'resources')
  const app = join(root, 'synthetic-app')
  await mkdir(join(resources, 'python-runtime'), { recursive: true })
  await mkdir(app)
  await writeFile(join(app, 'package.json'), JSON.stringify({ version }))
  await createPackage(app, join(resources, 'app.asar'))
  for (const name of [`PetDock Setup ${version}.exe`, `PetDock Portable ${version}.exe`, 'win-unpacked/PetDock.exe', 'win-unpacked/resources/python-runtime/petdock-assistant.exe']) {
    await writeFile(join(source, name), Buffer.from('不可执行合成文件'))
  }
  const output = join(root, 'run-one')
  await mkdir(output)
  assert.equal(Object.keys(await archiveBuild(root, output, version)).length, 5)
  await writeFile(join(app, 'package.json'), JSON.stringify({ version: '0.2.4' }))
  await createPackage(app, join(resources, 'app.asar'))
  const wrong = join(root, 'run-two')
  await mkdir(wrong)
  await assert.rejects(archiveBuild(root, wrong, version), /版本不一致/)
}))

test('SSH只执行固定入口和stdin协议，严格主机信任，无真实连接', async () => {
  const release = { releaseId: 'synthetic-id', version: '0.2.5', envelope: { synthetic: true } }
  const config = { ssh: { host: 'ubuntu@192.0.2.1', port: 22, identityFile: 'C:/synthetic/key.pem' } }
  const response = await callRemote(config, 'prepare', release, async (executable, args, options) => {
    assert.equal(executable, 'ssh.exe')
    assert.ok(args.includes('StrictHostKeyChecking=yes'))
    assert.ok(args.includes('BatchMode=yes'))
    assert.equal(args.at(-1), 'sudo -n /usr/local/sbin/petdock-desktop-release')
    assert.deepEqual(JSON.parse(options.input), { schemaVersion: 1, action: 'prepare', releaseId: release.releaseId, version: release.version, manifest: release.envelope })
    return JSON.stringify({ status: 'prepared' })
  })
  assert.equal(response.status, 'prepared')
})

test('上传器退出成功但摘要不匹配不能继续发布', () => {
  const release = { releaseId: 'synthetic-id', version: '0.2.5', artifact: { size: 123, sha512: 'synthetic' } }
  assert.throws(() => checkUpload({ status: 'uploaded', version: '0.2.5', size: 123, sha512: 'wrong' }, release))
})

/** 使用真实验签器和合成密钥；传输函数只返回内存响应。 */
async function httpsScenario(change = {}) {
  const policy = { ...await loadPolicy(resolve('.')) }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  policy.DESKTOP_UPDATE_TRUST = { keys: { test: publicKey.export({ type: 'spki', format: 'pem' }) }, revokedKeyIds: [] }
  const version = '0.2.5'
  const bytes = Buffer.from('不可执行的合成制品')
  const artifact = { kind: 'nsis', fileName: `PetDock Setup ${version}.exe`, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }
  const now = Math.floor(Date.now() / 1000) * 1000
  const utc = (time) => new Date(time).toISOString().replace('.000Z', 'Z')
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, appId: 'com.local.petdock', version, channel: 'stable', platform: 'win32', arch: 'x64', artifact, issuedAt: utc(now), expiresAt: utc(now + 86400000) }))
  const envelope = { schemaVersion: 1, keyId: 'test', manifest: manifest.toString('base64'), signature: sign(null, Buffer.concat([Buffer.from('PetDock desktop update manifest v1\ntest\n'), manifest]), privateKey).toString('base64') }
  const path = `releases/${version}/${encodeURIComponent(artifact.fileName)}`
  const metadata = { version, files: [{ url: path, size: artifact.size, sha512: artifact.sha512 }], path, sha512: artifact.sha512, ...change.metadata }
  const calls = []
  const read = async (url, options) => {
    calls.push({ url, options })
    if (url.pathname === '/latest.yml') return Buffer.from(JSON.stringify(metadata))
    if (url.pathname.startsWith('/manifests/')) return Buffer.from(JSON.stringify(envelope))
    if (options.expectedStatus === 302) return change.location ?? `https://${policy.DESKTOP_UPDATE_RELEASE.bucketHost}/${path}?synthetic=redacted`
    return { size: artifact.size, sha512: change.sha512 ?? artifact.sha512 }
  }
  return { policy, release: { releaseId: 'synthetic-id', version, artifact, envelope }, read, calls }
}

test('完整HTTPS校验真实签名、正式路径、HEAD和GET后摘要', async () => {
  const flow = await httpsScenario()
  await verifyHttps(flow.policy, flow.release, true, flow.read)
  assert.equal(flow.calls.length, 5)
  assert.equal(flow.calls.at(-1).options.maximum, flow.release.artifact.size)
})

test('元数据版本不一致时不申请下载链接', async () => {
  const flow = await httpsScenario({ metadata: { version: '0.2.6' } })
  await assert.rejects(verifyHttps(flow.policy, flow.release, true, flow.read), /不一致/)
  assert.equal(flow.calls.length, 2)
})

for (const location of ['https://evil.invalid/pkg.exe', 'http://petdock-1467993618.cos.ap-guangzhou.myqcloud.com/pkg.exe', 'https://petdock-1467993618.cos.ap-guangzhou.myqcloud.com/wrong.exe']) {
  test('COS跳转越界不能请求整包', async () => {
    const flow = await httpsScenario({ location })
    await assert.rejects(verifyHttps(flow.policy, flow.release, true, flow.read), /允许范围/)
    assert.equal(flow.calls.length, 3)
  })
}

test('整包摘要不匹配时失败', async () => {
  const flow = await httpsScenario({ sha512: 'wrong' })
  await assert.rejects(verifyHttps(flow.policy, flow.release, true, flow.read), /SHA-512/)
})

/** 用真实 Node 流模拟响应结束/截断，不建立网络连接。 */
function fakeHttps(body, complete = true, status = 200) {
  return (_url, _options, callback) => {
    const request = new EventEmitter()
    request.destroy = (error) => { request.emit('error', error); request.emit('close') }
    setImmediate(() => {
      const response = Readable.from([body])
      response.statusCode = status
      response.complete = complete
      response.headers = {}
      response.once('close', () => request.emit('close'))
      callback(response)
    })
    return request
  }
}

test('HTTPS流读取拒绝超限和未完整响应，不能仅凭结束事件通过', async () => {
  const url = new URL('https://synthetic.invalid/metadata')
  await assert.rejects(httpsRead(url, { maximum: 3 }, fakeHttps(Buffer.from('four'))), /超出/)
  await assert.rejects(httpsRead(url, { maximum: 4 }, fakeHttps(Buffer.from('four'), false)), /未完成/)
  await assert.rejects(httpsRead(url, { maximum: 4 }, fakeHttps(Buffer.from('four'), true, 503)), /状态/)
})

test('构建输入中的未追踪源码阻断发布，tracked变更会改变快照', async () => {
  const execute = async (_exe, args) => args[0] === 'ls-files' ? 'src/new.ts\0' : 'synthetic'
  await assert.rejects(snapshotSource('synthetic-root', execute), /未追踪源码/)
  const clean = async (_exe, args) => args[0] === 'ls-files' ? '' : args[0] === 'rev-parse' ? 'a'.repeat(40) : 'first diff'
  const changed = async (_exe, args) => args[0] === 'diff' ? 'second diff' : clean(_exe, args)
  assert.notEqual((await snapshotSource('synthetic-root', clean)).sourceDiffSha256, (await snapshotSource('synthetic-root', changed)).sourceDiffSha256)
})
