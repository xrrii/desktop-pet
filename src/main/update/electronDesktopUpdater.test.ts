import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer, request, type RequestOptions, type IncomingMessage } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmedNsisUpdater } from './confirmedNsisUpdater'
import { createReleaseDesktopUpdater, ElectronDesktopUpdater } from './electronDesktopUpdater'
import { GuardedUpdateHttpExecutor } from './guardedUpdateHttpExecutor'
import type { UpdateManifest } from './signedUpdateManifest'

const bucket = 'synthetic-1250000000.cos.ap-shanghai.myqcloud.com'

interface LocalRequest { host: string; path: string; method: string; range?: string }
interface FixtureOptions {
  corrupt?: boolean
  untrusted?: boolean
  version?: string
  redirect?: string
  firstForbidden?: boolean
  oversizedMetadata?: boolean
  metadataMismatch?: boolean
  redirectLoop?: boolean
}
interface Fixture {
  updater: ElectronDesktopUpdater
  engine: ConfirmedNsisUpdater
  transport: GuardedUpdateHttpExecutor
  requests: LocalRequest[]
  manifest: UpdateManifest
  payload: Buffer
  advanceClock: () => void
}

/** 使用真实引擎、签名算法和受限传输；仅网络出口映射到回环，不启动安装器。 */
async function withLocalFeed(run: (fixture: Fixture) => Promise<void>, options: FixtureOptions = {}): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'petdock-update-test-'))
  const configPath = join(directory, 'app-update.yml')
  // 与 publish=null 的真实解包一致：不创建 app-update.yml，下载缓存必须可独立初始化。
  const payload = Buffer.from('synthetic installer payload; never execute')
  const sha512 = createHash('sha512').update(payload).digest('base64')
  const pair = generateKeyPairSync('ed25519')
  const version = options.version || '0.2.2'
  let now = Math.floor(Date.now() / 1000) * 1000
  const manifest: UpdateManifest = {
    schemaVersion: 1, appId: 'com.local.petdock', version, channel: 'stable', platform: 'win32', arch: 'x64',
    artifact: { kind: 'nsis', fileName: 'PetDock Setup 0.2.2.exe', size: payload.length, sha512 },
    issuedAt: new Date(now - 1000).toISOString().replace('.000Z', 'Z'),
    expiresAt: new Date(now + 3600_000).toISOString().replace('.000Z', 'Z')
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const keyId = 'synthetic-key'
  const envelope = {
    schemaVersion: 1, keyId, manifest: manifestBytes.toString('base64'),
    signature: sign(null, Buffer.concat([Buffer.from(`PetDock desktop update manifest v1\n${keyId}\n`), manifestBytes]), pair.privateKey).toString('base64')
  }
  const artifactPath = `/releases/${version}/${encodeURIComponent(manifest.artifact.fileName)}`
  const metadata = {
    version, files: [{ url: artifactPath.slice(1), size: payload.length, sha512: options.metadataMismatch ? 'x'.repeat(88) : sha512 }],
    releaseDate: '2026-10-01T00:00:00Z', releaseNotes: options.oversizedMetadata ? 'x'.repeat(70_000) : undefined
  }
  const requests: LocalRequest[] = []
  let linkCount = 0
  let cosCount = 0
  const server = createServer((req, res) => {
    const host = String(req.headers['x-synthetic-host'])
    requests.push({ host, path: req.url || '', method: req.method || 'GET', range: req.headers.range })
    if (host === 'download.petdock.site') {
      if (req.url?.startsWith('/latest.yml')) return res.end(JSON.stringify(metadata))
      if (req.url?.startsWith('/manifests/')) return res.end(JSON.stringify(envelope))
      const start = Math.floor(now / 1000)
      const query = new URLSearchParams({
        'q-sign-algorithm': 'sha1', 'q-ak': `synthetic_${++linkCount}`, 'q-sign-time': `${start};${start + 1800}`,
        'q-key-time': `${start};${start + 1800}`, 'q-header-list': 'host', 'q-url-param-list': '', 'q-signature': 'a'.repeat(40)
      })
      res.writeHead(302, { Location: options.redirect || (options.redirectLoop
        ? `https://download.petdock.site${artifactPath}` : `https://${bucket}${artifactPath}?${query}`) })
      return res.end()
    }
    if (options.firstForbidden && ++cosCount === 1) {
      res.writeHead(403)
      return res.end()
    }
    const data = options.corrupt ? Buffer.alloc(payload.length, 120) : payload
    if (req.headers.range === 'bytes=0-3') {
      res.writeHead(206, { 'Content-Length': 4, 'Content-Range': `bytes 0-3/${data.length}` })
      return res.end(data.subarray(0, 4))
    }
    res.writeHead(200, { 'Content-Length': data.length })
    res.end(req.method === 'HEAD' ? undefined : data)
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('本地测试服务器未就绪。')
    const port = address.port
    class LocalTransport extends GuardedUpdateHttpExecutor {
      /** 地址守卫仍执行，仅把已通过校验的请求映射到独立回环服务。 */
      protected override createTransportRequest(options: RequestOptions, callback: (response: IncomingMessage) => void) {
        return request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port, agent: false,
          headers: { ...options.headers, 'X-Synthetic-Host': String(options.hostname) }
        }, callback) as unknown as Electron.ClientRequest
      }
    }
    const app = {
      version: '0.2.1', name: 'PetDockSyntheticUpdate', isPackaged: true, appUpdateConfigPath: configPath,
      userDataPath: directory, baseCachePath: directory,
      whenReady: async () => {}, relaunch: vi.fn(), quit: vi.fn(), onQuit: vi.fn()
    }
    const engine = new ConfirmedNsisUpdater(null, app)
    const transport = new LocalTransport('https://download.petdock.site/', bucket, () => now)
    const trustPair = options.untrusted ? generateKeyPairSync('ed25519') : pair
    const trust = { keys: { [keyId]: trustPair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, revokedKeyIds: [] }
    const updater = new ElectronDesktopUpdater('https://download.petdock.site/', trust, engine, transport, () => now)
    await run({ updater, engine, transport, requests, manifest, payload, advanceClock: () => { now += 3600_001 } })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

describe('真实引擎的独立签名与私有桶受限下载', () => {
  it('检查只读取元数据及签名，明确下载后跟随受限重定向，安装前重验', async () => {
    await withLocalFeed(async ({ updater, engine, requests, payload }) => {
      await expect(updater.check()).resolves.toBe('0.2.2')
      expect(requests).toHaveLength(2)
      expect(requests.every((req) => !req.path.includes('.exe'))).toBe(true)
      expect(engine.autoDownload).toBe(false)
      expect(engine.autoInstallOnAppQuit).toBe(false)
      expect(engine.allowDowngrade).toBe(false)
      expect(engine.disableWebInstaller).toBe(true)
      expect(engine.disableDifferentialDownload).toBe(true)
      await updater.download(vi.fn())
      expect(requests.filter((req) => req.host === bucket)).toHaveLength(1)
      const file = Reflect.get(engine, 'installerPath') as string
      expect(await readFile(file)).toEqual(payload)
      const install = vi.spyOn(engine, 'quitAndInstallConfirmed').mockResolvedValue()
      await updater.install()
      expect(install).toHaveBeenCalledOnce()
      await writeFile(file, Buffer.alloc(payload.length, 120))
      await expect(updater.install()).rejects.toThrow('验证未通过')
      expect(install).toHaveBeenCalledOnce()
    })
  })

  it('摘要正确但清单签名错误，在下载安装包之前拒绝', async () => {
    await withLocalFeed(async ({ updater, requests }) => {
      await expect(updater.check()).rejects.toThrow('签名清单')
      await expect(updater.download(vi.fn())).rejects.toThrow('先检查')
      expect(requests.some((req) => req.path.includes('.exe'))).toBe(false)
    }, { untrusted: true })
  })

  it('安装包字节损坏时引擎拒绝摘要，不允许安装', async () => {
    await withLocalFeed(async ({ updater, engine }) => {
      await updater.check()
      await expect(updater.download(vi.fn())).rejects.toThrow()
      const install = vi.spyOn(engine, 'quitAndInstallConfirmed')
      await expect(updater.install()).rejects.toThrow()
      expect(install).not.toHaveBeenCalled()
    }, { corrupt: true })
  })

  it('未经签名的元数据不能更改制品摘要', async () => {
    await withLocalFeed(async ({ updater }) => {
      await expect(updater.check()).rejects.toThrow('不一致')
    }, { metadataMismatch: true })
  })

  it('签名清单过期后不能开始下载，也不能安装已下载制品', async () => {
    await withLocalFeed(async ({ updater, advanceClock, engine }) => {
      await updater.check()
      await updater.download(vi.fn())
      advanceClock()
      await expect(updater.download(vi.fn())).rejects.toThrow('过期')
      const install = vi.spyOn(engine, 'quitAndInstallConfirmed')
      await expect(updater.install()).rejects.toThrow('过期')
      expect(install).not.toHaveBeenCalled()
    })
  })

  it('短期链接被存储端拒绝后，主动重试重新经过入口签发', async () => {
    await withLocalFeed(async ({ updater, requests }) => {
      await updater.check()
      await expect(updater.download(vi.fn())).rejects.toThrow()
      await expect(updater.download(vi.fn())).resolves.toBeUndefined()
      expect(requests.filter((req) => req.host === bucket)).toHaveLength(2)
      const queries = requests.filter((req) => req.host === bucket).map((req) => new URL(`https://${bucket}${req.path}`).searchParams.get('q-ak'))
      expect(new Set(queries).size).toBe(2)
    }, { firstForbidden: true })
  })

  it('HEAD 和 Range 经入口与存储端保持方法和范围', async () => {
    await withLocalFeed(async ({ updater, transport, manifest, requests, payload }) => {
      await updater.check()
      transport.beginDownload(manifest)
      const url = transport.artifactUrl(manifest)
      await transport.request({ protocol: url.protocol, hostname: url.hostname, path: url.pathname, method: 'HEAD' })
      const result = await transport.request({ protocol: url.protocol, hostname: url.hostname, path: url.pathname, headers: { Range: 'bytes=0-3' } })
      expect(result).toBe(payload.subarray(0, 4).toString())
      expect(requests.some((req) => req.host === bucket && req.method === 'HEAD')).toBe(true)
      expect(requests.some((req) => req.host === bucket && req.range === 'bytes=0-3')).toBe(true)
    })
  })

  it.each([
    'http://synthetic-1250000000.cos.ap-shanghai.myqcloud.com/releases/0.2.2/a.exe',
    'https://evil.example/releases/0.2.2/a.exe',
    'https://other-1250000000.cos.ap-shanghai.myqcloud.com/releases/0.2.2/a.exe',
    `https://${bucket}/releases/0.2.2/other.exe`,
    `https://${bucket}/releases/0.2.2/PetDock%20Setup%200.2.2.exe`
  ])('实际重定向越界时拒绝且不向目标发请求：%s', async (redirect) => {
    await withLocalFeed(async ({ updater, requests }) => {
      await updater.check()
      await expect(updater.download(vi.fn())).rejects.toThrow()
      expect(requests.every((req) => req.host === 'download.petdock.site')).toBe(true)
    }, { redirect })
  })

  it('循环重定向在受限请求次数内失败', async () => {
    await withLocalFeed(async ({ updater, requests }) => {
      await updater.check()
      await expect(updater.download(vi.fn())).rejects.toThrow()
      expect(requests.length).toBeLessThanOrEqual(14)
    }, { redirectLoop: true })
  })

  it('元数据超出大小边界时终止读取', async () => {
    await withLocalFeed(async ({ updater }) => {
      await expect(updater.check()).rejects.toThrow()
    }, { oversizedMetadata: true })
  })

  it('正式源拒绝预发布版本', async () => {
    await withLocalFeed(async ({ updater, requests }) => {
      await updater.check().catch(() => undefined)
      await expect(updater.download(vi.fn())).rejects.toThrow('先检查')
      expect(requests.some((req) => req.path.includes('.exe'))).toBe(false)
    }, { version: '0.2.2-beta.1' })
  })

  it('缺少生产入口、桶主机和信任根时，正式工厂仍关闭', () => {
    expect(createReleaseDesktopUpdater('nsis')).toBeNull()
    expect(createReleaseDesktopUpdater('portable')).toBeNull()
  })
})
