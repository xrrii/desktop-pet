import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bucket = 'synthetic-1250000000.cos.ap-guangzhou.myqcloud.com'

/** 仅可选本地 Cloud 环境；凭据和桶始终是本脚本生成的合成值。 */
function cloudPythonOption() {
  const index = process.argv.indexOf('--cloud-python')
  return index < 0 ? null : process.argv[index + 1]
}

/** 通过本机 HTTP 检查服务状态，不读取或显示响应中的下载链接。 */
function localStatus(port) {
  return new Promise((resolveStatus, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: '/healthz', headers: { Host: 'download.petdock.site' } }, (response) => {
      response.resume()
      response.on('end', () => resolveStatus(response.statusCode))
    })
    request.setTimeout(1000, () => request.destroy(new Error('本地服务等待超时')))
    request.on('error', reject)
    request.end()
  })
}

/** 联调真实 FastAPI 与官方 SDK 短链接，合成 COS 正文经 Electron 原生网络读取。 */
async function runCloudIntegration(directory, python, modules, manifest, envelope, publicKey, payload) {
  const fixture = join(directory, 'cloud-fixture')
  await mkdir(fixture)
  const controlFile = join(fixture, 'control.json')
  const credentialsFile = join(fixture, 'credentials.json')
  await writeFile(join(fixture, 'catalog.json'), JSON.stringify({ schemaVersion: 1, currentVersion: manifest.version,
    releases: { [manifest.version]: { manifest: envelope } } }), 'utf8')
  await writeFile(join(fixture, 'trust.json'), JSON.stringify({ keys: { [envelope.keyId]: publicKey }, revokedKeyIds: [] }), 'utf8')
  await writeFile(controlFile, JSON.stringify({ schemaVersion: 1, paused: false }), 'utf8')
  const credentials = { secretId: 'syntheticId1234567890', secretKey: 'syntheticKey1234567890' }
  await writeFile(credentialsFile, JSON.stringify(credentials), 'utf8')
  const reservation = createServer()
  await new Promise((resolveListen) => reservation.listen(0, '127.0.0.1', resolveListen))
  const servicePort = reservation.address().port
  await new Promise((resolveClose) => reservation.close(resolveClose))
  const environment = { ...process.env, PETDOCK_DOWNLOAD_BUCKET: 'synthetic-1250000000',
    PETDOCK_DOWNLOAD_CATALOG_FILE: join(fixture, 'catalog.json'), PETDOCK_DOWNLOAD_TRUST_FILE: join(fixture, 'trust.json'),
    PETDOCK_DOWNLOAD_CONTROL_FILE: controlFile, PETDOCK_DOWNLOAD_CREDENTIALS_FILE: credentialsFile,
    PETDOCK_DOWNLOAD_DATABASE_FILE: join(fixture, 'quota.sqlite3'), PETDOCK_DOWNLOAD_MONTHLY_LINK_BYTES: String(payload.length * 3),
    PETDOCK_DOWNLOAD_TRUSTED_PROXY_NETWORKS: '', PETDOCK_DOWNLOAD_ALLOW_LOCAL_HOSTS: 'true' }
  const child = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(servicePort),
    '--no-proxy-headers', '--no-access-log'], { cwd: resolve(projectRoot, '../petdock-office/petdock-cloud/services/desktop-download'),
    env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let spawnError
  child.once('error', (error) => { spawnError = error })
  const closed = new Promise((resolveClose) => child.once('close', resolveClose))
  child.stdout.resume()
  child.stderr.resume()
  const seen = []
  const cos = createServer((request, response) => {
    const url = new URL(request.url, `https://${bucket}`)
    seen.push({ method: request.method, token: url.searchParams.has('x-cos-security-token'), range: request.headers.range })
    assert.equal(url.searchParams.get('q-sign-algorithm'), 'sha1')
    assert.match(url.searchParams.get('q-signature'), /^[a-f0-9]{40}$/)
    assert.equal(decodeURIComponent(url.pathname), `/releases/${manifest.version}/${manifest.artifact.fileName}`)
    if (request.headers.range === 'bytes=0-1') {
      response.writeHead(206, { 'Content-Length': 2, 'Content-Range': `bytes 0-1/${payload.length}` })
      return response.end(payload.subarray(0, 2))
    }
    response.writeHead(200, { 'Content-Length': payload.length })
    response.end(request.method === 'HEAD' ? undefined : payload)
  })
  let stage = '启动服务'
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (spawnError || child.exitCode !== null) throw new Error('本地下载服务启动失败')
      if (await localStatus(servicePort).catch(() => 0) === 200) break
      if (attempt === 99) throw new Error('本地下载服务未就绪')
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    await new Promise((resolveListen) => cos.listen(0, '127.0.0.1', resolveListen))
    const cosPort = cos.address().port
    class CloudLoopbackTransport extends modules.GuardedUpdateHttpExecutor {
      /** 安全校验先于回环映射，仍走真实 Electron 重定向和匿名网络会话。 */
      createTransportRequest(options, callback) {
        return super.createTransportRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1',
          port: options.hostname === bucket ? cosPort : servicePort,
          headers: { ...options.headers, 'X-Synthetic-Host': String(options.hostname) } }, (response) => {
            console.log(`UPDATE_CLOUD_RESPONSE status=${response.statusCode}`)
            callback(response)
          })
      }
    }
    for (const temporary of [false, true]) {
      stage = temporary ? '临时凭据检查' : '普通凭据检查'
      console.log(`UPDATE_CLOUD_STAGE ${stage}`)
      if (temporary) await writeFile(credentialsFile, JSON.stringify({ ...credentials, securityToken: 'synthetic+token/value=',
        expiresAt: Math.floor(Date.now() / 1000) + 1200 }), 'utf8')
      const data = join(fixture, temporary ? 'sts' : 'regular')
      await mkdir(data)
      const transport = new CloudLoopbackTransport('https://download.petdock.site/', bucket)
      const engine = new modules.ConfirmedNsisUpdater(null, { version: '0.2.1', name: 'PetDockSyntheticCloudUpdate', isPackaged: true,
        appUpdateConfigPath: join(data, 'missing-app-update.yml'), userDataPath: data, baseCachePath: data,
        whenReady: async () => {}, relaunch: () => {}, quit: () => {}, onQuit: () => {} })
      const updater = new modules.ElectronDesktopUpdater('https://download.petdock.site/', {
        keys: { [envelope.keyId]: publicKey }, revokedKeyIds: [] }, engine, transport)
      assert.equal(await updater.check(), manifest.version)
      const before = seen.length
      stage = temporary ? '临时凭据下载' : '普通凭据下载'
      console.log(`UPDATE_CLOUD_STAGE ${stage}`)
      await updater.download(() => {})
      assert.equal(seen.length, before + 1)
      assert.equal(seen.at(-1).token, temporary)
      assert.deepEqual(await readFile(engine.installerPath), payload)
      if (!temporary) {
        stage = 'HEAD与Range'
        console.log(`UPDATE_CLOUD_STAGE ${stage}`)
        transport.beginDownload(manifest)
        const artifact = transport.artifactUrl(manifest)
        const options = { protocol: artifact.protocol, hostname: artifact.hostname, path: artifact.pathname }
        await transport.request({ ...options, method: 'HEAD' })
        assert.equal(seen.at(-1).method, 'HEAD')
        assert.equal(await transport.request({ ...options, headers: { Range: 'bytes=0-1' } }), payload.subarray(0, 2).toString())
        assert.equal(seen.at(-1).range, 'bytes=0-1')
      } else {
        stage = '预算与暂停'
        console.log(`UPDATE_CLOUD_STAGE ${stage}`)
        transport.beginDownload(manifest)
        const artifact = transport.artifactUrl(manifest)
        await assert.rejects(transport.request({ protocol: artifact.protocol, hostname: artifact.hostname, path: artifact.pathname }))
        await writeFile(controlFile, JSON.stringify({ schemaVersion: 1, paused: true }), 'utf8')
        await assert.rejects(updater.check())
      }
    }
    assert.equal(seen.length, 4)
    console.log('UPDATE_CLOUD_SDK_SMOKE_OK')
  } catch (error) {
    const code = ['ERR_ASSERTION', 'ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? error.code : 'OTHER'
    console.log(`UPDATE_CLOUD_FAILED stage=${stage} code=${code}`)
    const network = String(error?.message || '').match(/net::(ERR_[A-Z_]+)/)?.[1] || 'NONE'
    console.log(`UPDATE_CLOUD_FAILED_NETWORK code=${network}`)
    throw error
  } finally {
    cos.closeAllConnections()
    await new Promise((resolveClose) => cos.close(resolveClose))
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  }
}

/** 编译待测更新模块到临时目录，启动真实 Electron 网络层；不操作用户应用和正式配置。 */
async function runHost() {
  await mkdir(join(projectRoot, 'temp'), { recursive: true })
  const directory = await mkdtemp(join(projectRoot, 'temp', 'update-net-smoke-'))
  let child
  let timeout
  let closed
  let stage = '编译'
  try {
    const { transformFile } = await import('@swc/core')
    for (const name of ['confirmedNsisUpdater', 'guardedUpdateHttpExecutor', 'signedUpdateManifest', 'electronDesktopUpdater', 'updatePolicy']) {
      const compiled = await transformFile(join(projectRoot, 'src/main/update', `${name}.ts`), {
        jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'commonjs' }
      })
      await writeFile(join(directory, `${name}.js`), compiled.code, 'utf8')
    }
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name: 'petdock-update-net-smoke', version: '0.0.0', main: fileURLToPath(import.meta.url)
    }), 'utf8')
    stage = '启动'
    const executable = join(projectRoot, 'node_modules/electron/dist/electron.exe')
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const cloudPython = cloudPythonOption()
    child = spawn(executable, [directory, '--electron-child', directory, ...(cloudPython ? ['--cloud-python', cloudPython] : [])], {
      cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment
    })
    let spawnError = null
    child.once('error', (error) => { spawnError = error })
    // close 在启动失败时也会发出；不能只等待可能永远不来的 exit。
    closed = new Promise((resolveExit) => child.once('close', resolveExit))
    let output = ''
    let pendingLines = ''
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      output += text
      pendingLines += text
      const lines = pendingLines.split(/\r?\n/)
      pendingLines = lines.pop()
      for (const line of lines.filter((line) => /^(UPDATE_NET_|UPDATE_CLOUD_)/.test(line))) console.log(line)
    })
    // Chromium 日志可能带底层网络细节，只回传固定的验收标记和阶段名。
    let diagnostic = ''
    child.stderr.on('data', (chunk) => { diagnostic += chunk.toString('utf8') })
    timeout = setTimeout(() => child.kill(), cloudPython ? 100_000 : 70_000)
    const code = await closed
    if (spawnError) throw spawnError
    stage = '子进程验收'
    if (code !== 0) {
      await mkdir(join(projectRoot, 'outputs'), { recursive: true })
      await writeFile(join(projectRoot, 'outputs', 'update-net-smoke-diagnostic.log'), diagnostic, 'utf8')
    }
    assert.equal(code, 0, 'Electron 更新传输冒烟失败。')
    assert.ok(output.includes('UPDATE_NET_SMOKE_OK'), '缺少 Electron 更新传输成功标记。')
  } catch (error) {
    const code = ['EPERM', 'EACCES', 'ENOENT', 'ERR_ASSERTION'].includes(error?.code) ? error.code : 'OTHER'
    console.log(`UPDATE_NET_HOST_FAILED stage=${stage} code=${code}`)
    throw error
  } finally {
    clearTimeout(timeout)
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill()
      await closed
    }
    await rm(directory, { recursive: true, force: true })
  }
}

/** 使用真实 net.request 与合成发布数据核对重定向、下载缓存、响应上限和超时。 */
async function runElectron(directory) {
  const require = createRequire(import.meta.url)
  const { app } = require('electron')
  app.setPath('userData', directory)
  app.setPath('sessionData', directory)
  app.disableHardwareAcceleration()
  let stage = '初始化'
  let server
  try {
    await app.whenReady()
    const { ConfirmedNsisUpdater } = require(join(directory, 'confirmedNsisUpdater.js'))
    const { ElectronDesktopUpdater } = require(join(directory, 'electronDesktopUpdater.js'))
    const { GuardedUpdateHttpExecutor } = require(join(directory, 'guardedUpdateHttpExecutor.js'))
    const payload = Buffer.from('synthetic installer payload; never execute')
    const pair = generateKeyPairSync('ed25519')
    const now = Math.floor(Date.now() / 1000) * 1000
    const keyId = 'synthetic-key'
    const manifest = {
      schemaVersion: 1, appId: 'com.local.petdock', version: '0.2.2', channel: 'stable', platform: 'win32', arch: 'x64',
      artifact: { kind: 'nsis', fileName: 'PetDock Setup 0.2.2.exe', size: payload.length, sha512: createHash('sha512').update(payload).digest('base64') },
      issuedAt: new Date(now - 1000).toISOString().replace('.000Z', 'Z'),
      expiresAt: new Date(now + 3600_000).toISOString().replace('.000Z', 'Z')
    }
    const bytes = Buffer.from(JSON.stringify(manifest))
    const envelope = { schemaVersion: 1, keyId, manifest: bytes.toString('base64'),
      signature: sign(null, Buffer.concat([Buffer.from(`PetDock desktop update manifest v1\n${keyId}\n`), bytes]), pair.privateKey).toString('base64') }
    const artifactPath = `/releases/0.2.2/${encodeURIComponent(manifest.artifact.fileName)}`
    let mode = 'normal'
    const requests = []
    server = createServer((req, res) => {
      const host = req.headers['x-synthetic-host']
      requests.push({ host, path: req.url })
      if (host === 'download.petdock.site') {
        if (req.url.startsWith('/latest.yml')) {
          if (mode === 'timeout') return
          if (mode === 'oversize') return res.end('x'.repeat(70_000))
          return res.end(JSON.stringify({ version: '0.2.2', files: [{ url: artifactPath.slice(1), ...manifest.artifact }], releaseDate: manifest.issuedAt }))
        }
        if (req.url.startsWith('/manifests/')) return res.end(JSON.stringify(envelope))
        const start = Math.floor(Date.now() / 1000)
        const query = new URLSearchParams({ 'q-sign-algorithm': 'sha1', 'q-ak': 'synthetic',
          'q-sign-time': `${start};${start + 1800}`, 'q-key-time': `${start};${start + 1800}`,
          'q-header-list': 'host', 'q-url-param-list': '', 'q-signature': 'a'.repeat(40) })
        res.writeHead(302, { Location: mode === 'evil' ? 'https://evil.example/setup.exe' : `https://${bucket}${artifactPath}?${query}` })
        return res.end()
      }
      res.writeHead(200, { 'Content-Length': payload.length })
      res.end(payload)
    })
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const port = server.address().port
    class NativeLoopbackTransport extends GuardedUpdateHttpExecutor {
      /** 仅映射已通过域名/路径校验的网络出口，保留 Electron 原生重定向和响应。 */
      createTransportRequest(options, callback) {
        return super.createTransportRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port,
          headers: { ...options.headers, 'X-Synthetic-Host': String(options.hostname) }
        }, (response) => {
          assert.equal(typeof response.pipe, 'function', 'Electron 响应必须支持引擎管道。')
          console.log(`UPDATE_NET_RESPONSE_API destroy=${typeof response.destroy} pipe=${typeof response.pipe}`)
          callback(response)
        })
      }
    }
    const transport = new NativeLoopbackTransport('https://download.petdock.site/', bucket)
    const engine = new ConfirmedNsisUpdater(null, {
      version: '0.2.1', name: 'PetDockSyntheticUpdate', isPackaged: true, appUpdateConfigPath: join(directory, 'missing-app-update.yml'),
      userDataPath: directory, baseCachePath: directory, whenReady: async () => {}, relaunch: () => {}, quit: () => {}, onQuit: () => {}
    })
    const updater = new ElectronDesktopUpdater('https://download.petdock.site/', {
      keys: { [keyId]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, revokedKeyIds: []
    }, engine, transport)
    stage = '签名检查'
    console.log(`UPDATE_NET_STAGE ${stage}`)
    assert.equal(await updater.check(), '0.2.2')
    assert.equal(requests.length, 2)
    stage = '原生重定向与完整下载'
    console.log(`UPDATE_NET_STAGE ${stage}`)
    await updater.download(() => {})
    assert.equal(requests.filter((entry) => entry.host === bucket).length, 1)
    const file = engine.installerPath
    assert.deepEqual(await readFile(file), payload)
    stage = '安装前重验'
    console.log(`UPDATE_NET_STAGE ${stage}`)
    let installs = 0
    engine.quitAndInstallConfirmed = async () => { installs += 1 }
    await updater.install()
    assert.equal(installs, 1)
    await writeFile(file, Buffer.alloc(payload.length, 120))
    await assert.rejects(updater.install())
    assert.equal(installs, 1)
    stage = '越界原生重定向'
    console.log(`UPDATE_NET_STAGE ${stage}`)
    mode = 'evil'
    await updater.check()
    await assert.rejects(updater.download(() => {}))
    assert.ok(requests.every((entry) => entry.host === bucket || entry.host === 'download.petdock.site'))
    stage = '原生响应大小限制'
    console.log(`UPDATE_NET_STAGE ${stage}`)
    mode = 'oversize'
    await assert.rejects(updater.check())
    stage = '原生请求超时'
    console.log(`UPDATE_NET_STAGE ${stage}`)
    mode = 'timeout'
    transport.beginCheck()
    await assert.rejects(transport.request({ protocol: 'https:', hostname: 'download.petdock.site', path: '/latest.yml' }), /更新请求超时/)
    const cloudPython = cloudPythonOption()
    if (cloudPython) {
      stage = 'Cloud 官方 SDK 跨仓联调'
      await runCloudIntegration(directory, cloudPython, { ConfirmedNsisUpdater, ElectronDesktopUpdater, GuardedUpdateHttpExecutor },
        manifest, envelope, pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), payload)
    }
    console.log('UPDATE_NET_SMOKE_OK')
    app.exit(0)
  } catch {
    console.log(`UPDATE_NET_SMOKE_FAILED stage=${stage}`)
    app.exit(1)
  } finally {
    server?.closeAllConnections()
    server?.close()
  }
}

if (process.argv.includes('--electron-child')) {
  // Electron 在主模块求值结束后才触发 ready，顶层不能等待 whenReady，否则会互相等待。
  void runElectron(process.argv[process.argv.indexOf('--electron-child') + 1])
} else {
  try {
    await runHost()
  } catch {
    console.error('Electron 更新传输冒烟失败，请核查固定阶段输出与运行权限。')
    process.exitCode = 1
  }
}
