import { build } from 'esbuild'
import { createHash, createPublicKey } from 'node:crypto'
import { open } from 'node:fs/promises'
import { get } from 'node:https'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const maximum = 65_536

/** 在内存编译实际客户端验证器与内置信任，不读取环境变量中的源或密钥。 */
async function loadVerifier() {
  const result = await build({
    stdin: {
      contents: 'export * from "./src/main/update/signedUpdateManifest"; export * from "./src/main/update/updatePolicy";',
      resolveDir: root
    }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)
}

/** 只读有限大小的本地签名信封；不接受私钥或任意配置文件。 */
async function readEnvelope(path) {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    if (size < 1 || size > maximum) throw new Error()
    const body = await file.readFile()
    if (body.length > maximum) throw new Error()
    return JSON.parse(body.toString('utf8'))
  } finally {
    await file.close()
  }
}

/** 元数据只向内置 HTTPS 源发送 GET，拒绝跳转，限制整个请求时间和响应体积。 */
function readMetadata(url) {
  return new Promise((resolveBody, reject) => {
    const request = get(url, { headers: { Accept: 'application/json, application/yaml' } }, (response) => {
      const chunks = []
      let size = 0
      if (response.statusCode !== 200) {
        response.destroy()
        reject(new Error())
        return
      }
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > maximum) response.destroy(new Error())
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error()) }
      })
      response.once('close', () => {
        clearTimeout(timer)
        if (!response.complete) reject(new Error())
      })
    })
    const timer = setTimeout(() => request.destroy(new Error()), 15_000)
    request.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

/** 校验本地签名或实际公网元数据，任何失败都只输出固定提示，不下载 EXE 或签发链接。 */
async function main(args) {
  if (args.length && (args.length !== 2 || args[0] !== '--envelope' || !args[1])) throw new Error()
  const verifier = await loadVerifier()
  const release = verifier.DESKTOP_UPDATE_RELEASE
  const trust = verifier.DESKTOP_UPDATE_TRUST
  if (!release.trustReady || !Object.keys(trust.keys).length) throw new Error()
  const base = verifier.requireOfficialUpdateUrl(release.feedUrl)
  const metadata = args.length ? null : await readMetadata(new URL('latest.yml', base))
  if (metadata && !verifier.isReleaseVersion(metadata.version)) throw new Error()
  const envelope = args.length ? await readEnvelope(args[1]) : await readMetadata(new URL(`manifests/${metadata.version}.json`, base))
  const version = metadata ? metadata.version : JSON.parse(Buffer.from(envelope.manifest, 'base64')).version
  const verified = verifier.verifySignedUpdateManifest(envelope, trust, version)
  const artifact = verified.manifest.artifact
  if (metadata) {
    const file = metadata.files?.[0]
    const url = new URL(`releases/${version}/${encodeURIComponent(artifact.fileName)}`, base)
    if (!Array.isArray(metadata.files) || metadata.files.length !== 1 || metadata.stagingPercentage !== undefined ||
        'packages' in metadata || !file || new URL(file.url, base).href !== url.href ||
        file.size !== artifact.size || file.sha512 !== artifact.sha512) throw new Error()
  }
  const key = createPublicKey(trust.keys[verified.keyId])
  console.log(JSON.stringify({
    status: 'DESKTOP_UPDATE_FEED_CHECK_OK', mode: metadata ? 'https-metadata-only' : 'offline-envelope',
    version, keyId: verified.keyId, artifactBytes: artifact.size, expiresAt: verified.manifest.expiresAt,
    publicKeySha256: createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
  }))
}

try {
  await main(process.argv.slice(2))
} catch {
  console.error('桌面更新接入检查失败：请核对入口状态、元数据、签名、公钥与清单时效。')
  process.exitCode = 1
}
