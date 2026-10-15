import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadPolicy, runProcess, verifyHttps } from './io.mjs'
import { startRenewal } from './renewal.mjs'

const cloud = resolve('../petdock-office/petdock-cloud')
const python = process.env.PETDOCK_TEST_PYTHON ?? join(cloud, '.venv', 'Scripts', 'python.exe')
const driver = `
import importlib.util, json, sys, time
from pathlib import Path
root, cloud = map(Path, sys.argv[1:3])
spec = importlib.util.spec_from_file_location('release_tool', cloud / 'deploy/desktop-download/release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
settings = module.DownloadSettings(catalog_file=root/'catalog.json', trust_file=root/'trust.json', control_file=root/'control.json')
def verify(settings, version):
    # Windows 集成使用真实目录校验替代 Linux 降身份，不能据此声称 flock/UID 已验证。
    assert module.load_catalog(settings, time.time()).current_version == version
manager = module.ReleaseManager(settings, root/'transactions', verify)
request = json.load(sys.stdin)
if request.get('action') == 'metadata':
    from app.catalog import latest_metadata
    catalog = module.load_catalog(settings, time.time())
    value = json.loads(latest_metadata(catalog)) if request['path']=='/latest.yml' else catalog.releases[catalog.current_version]['manifest']
else:
    value = manager.dispatch(request)
print(json.dumps(value))
`

for (const paused of [false, true]) {
  test(`Node 续签真实 Python 目录事务，过期多版迁移与元数据复验，暂停=${paused}`, async () => {
    await mkdir('temp', { recursive: true })
    const directory = await mkdtemp(resolve('temp/renewal-integration-'))
    try {
      const pair = generateKeyPairSync('ed25519')
      const policy = { ...await loadPolicy(resolve('.')), DESKTOP_UPDATE_TRUST: {
        keys: { test: pair.publicKey.export({ type: 'spki', format: 'pem' }) }, revokedKeyIds: [] } }
      const privateKeyFile = join(directory, 'synthetic.pem')
      await writeFile(privateKeyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
      const now = Math.floor(Date.now() / 1000) * 1000
      const utc = (time) => new Date(time).toISOString().replace('.000Z', 'Z')
      const envelope = (version) => {
        const manifest = { schemaVersion: 1, appId: 'com.local.petdock', version, channel: 'stable', platform: 'win32', arch: 'x64',
          artifact: { kind: 'nsis', fileName: `PetDock Setup ${version}.exe`, size: 42, sha512: createHash('sha512').update('synthetic').digest('base64') },
          issuedAt: utc(now - 2 * 86400000), expiresAt: utc(now - 86400000) }
        const bytes = Buffer.from(JSON.stringify(manifest))
        return { schemaVersion: 1, keyId: 'test', manifest: bytes.toString('base64'),
          signature: sign(null, Buffer.concat([Buffer.from('PetDock desktop update manifest v1\ntest\n'), bytes]), pair.privateKey).toString('base64') }
      }
      const catalog = { schemaVersion: 1, currentVersion: '0.2.5', releases: { '0.2.4': { manifest: envelope('0.2.4') }, '0.2.5': { manifest: envelope('0.2.5') } } }
      const before = Buffer.from(JSON.stringify(catalog))
      await writeFile(join(directory, 'catalog.json'), before)
      await writeFile(join(directory, 'trust.json'), JSON.stringify(policy.DESKTOP_UPDATE_TRUST))
      const control = JSON.stringify({ schemaVersion: 1, paused })
      await writeFile(join(directory, 'control.json'), control)
      await mkdir(join(directory, 'transactions'))
      const driverFile = join(directory, 'driver.py')
      await writeFile(driverFile, driver)
      const dispatch = async (request) => JSON.parse(await runProcess(python, [driverFile, directory, cloud], { input: JSON.stringify(request) }))
      const remote = async (action, release) => dispatch({ schemaVersion: 1, action, releaseId: release.releaseId, version: release.version,
        ...(action === 'renew' ? { manifest: release.envelope, baseline: release.baseline, migration: release.migration } : {}) })
      let httpsCalls = 0
      const state = await startRenewal({ migration: true, ifDue: false }, { signing: { keyId: 'test', privateKeyFile } }, policy, directory, {
        remote, confirmMigration: async () => true, log: () => {}, verifyHttps: async (release, full) => {
          assert.equal(full, false)
          await verifyHttps(policy, release, full, async (url) => {
            httpsCalls++
            return Buffer.from(JSON.stringify(await dispatch({ action: 'metadata', path: url.pathname })))
          })
        }
      })
      assert.equal(httpsCalls, paused ? 0 : 2)
      const after = JSON.parse(await readFile(join(directory, 'catalog.json'), 'utf8'))
      assert.deepEqual(Object.keys(after.releases), ['0.2.5'])
      assert.equal(await readFile(join(directory, 'control.json'), 'utf8'), control)
      const transaction = JSON.parse(await readFile(join(directory, 'transactions', `${state.releaseId}.json`), 'utf8'))
      assert.equal(transaction.status, 'committed')
      assert.ok(Buffer.from(transaction.baseCatalog, 'base64').equals(before))
      assert.equal((await remote('status', state)).operation, 'renew')
      assert.equal((await remote('renew', state)).status, 'committed')
      assert.equal((await readdir(join(directory, 'transactions'))).length, 1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}
