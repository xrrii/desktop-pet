import { createHash, createPublicKey, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

export interface SignedUpdateEnvelope {
  schemaVersion: 1
  keyId: string
  manifest: string
  signature: string
}

export interface UpdateManifest {
  schemaVersion: 1
  appId: 'com.local.petdock'
  version: string
  channel: 'stable'
  platform: 'win32'
  arch: 'x64'
  artifact: { kind: 'nsis'; fileName: string; size: number; sha512: string }
  issuedAt: string
  expiresAt: string
}

export interface UpdateTrust {
  keys: Readonly<Record<string, string>>
  revokedKeyIds: readonly string[]
}

export interface VerifiedUpdateManifest {
  keyId: string
  manifest: UpdateManifest
  envelope: SignedUpdateEnvelope
}

/** 区分制品信任失败与可重试的停机失败，失效缓存必须重新检查和下载。 */
export class UpdateVerificationError extends Error {
  /** 使用固定中文提示，不携带下载地址、私钥或原始异常。 */
  constructor(message = '更新签名清单无效、过期或不属于受信任的正式制品。') {
    super(message)
    this.name = 'UpdateVerificationError'
  }
}

/** 正式公钥只随应用更新；当前未建立发布密钥，任何远程清单都不能添加信任根。 */
export const DESKTOP_UPDATE_TRUST: UpdateTrust = Object.freeze({
  keys: Object.freeze({}), revokedKeyIds: Object.freeze([] as string[])
})

/** 正式版本不允许预发布、前导零或超出安全整数范围。 */
export function isReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
    value.split('.').every((part) => Number.isSafeInteger(Number(part)))
}

/** 安装包名沿用 builder 的内部空格，拒绝路径、设备名和模糊的 Windows 文件名。 */
export function isUpdateArtifactName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}\.exe$/.test(value) &&
    !value.includes('..') && !/[ .]$/.test(value.slice(0, -4)) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value.split('.')[0].trim())
}

/** 验证上下文绑定的 Ed25519 清单，失败只返回固定错误，不泄露源或底层异常。 */
export function verifySignedUpdateManifest(
  value: unknown, trust: UpdateTrust, expectedVersion: string, now = Date.now()
): VerifiedUpdateManifest {
  try {
    const envelope = requireFields(value, ['schemaVersion', 'keyId', 'manifest', 'signature'])
    if (envelope.schemaVersion !== 1 || typeof envelope.keyId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(envelope.keyId) ||
        !Object.hasOwn(trust.keys, envelope.keyId) || trust.revokedKeyIds.includes(envelope.keyId)) throw new Error()
    const bytes = decodeBase64(envelope.manifest, 32_768)
    const signature = decodeBase64(envelope.signature, 64)
    const key = createPublicKey(trust.keys[envelope.keyId])
    if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 ||
        !verify(null, Buffer.concat([
          Buffer.from(`PetDock desktop update manifest v1\n${envelope.keyId}\n`, 'utf8'), bytes
        ]), key, signature)) throw new Error()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const data = requireFields(JSON.parse(text), [
      'schemaVersion', 'appId', 'version', 'channel', 'platform', 'arch', 'artifact', 'issuedAt', 'expiresAt'
    ])
    const artifact = requireFields(data.artifact, ['kind', 'fileName', 'size', 'sha512'])
    if (data.schemaVersion !== 1 || data.appId !== 'com.local.petdock' ||
        !isReleaseVersion(data.version) || data.version !== expectedVersion ||
        data.channel !== 'stable' || data.platform !== 'win32' || data.arch !== 'x64' ||
        artifact.kind !== 'nsis' || !isUpdateArtifactName(artifact.fileName) ||
        !Number.isSafeInteger(artifact.size) || (artifact.size as number) < 1 ||
        (artifact.size as number) > 2_147_483_648 || decodeBase64(artifact.sha512, 64).length !== 64) throw new Error()
    const issuedAt = requireTimestamp(data.issuedAt)
    const expiresAt = requireTimestamp(data.expiresAt)
    // 时钟最多容忍签发时间领先五分钟；过期清单和超过三十天的有效期一律拒绝。
    if (!Number.isFinite(now) || issuedAt > now + 300_000 || expiresAt <= now ||
        expiresAt <= issuedAt || expiresAt - issuedAt > 30 * 86_400_000) throw new Error()
    const manifest = Object.freeze({
      ...data, artifact: Object.freeze({ ...artifact })
    }) as unknown as UpdateManifest
    return Object.freeze({
      keyId: envelope.keyId, manifest,
      envelope: Object.freeze({ ...envelope }) as unknown as SignedUpdateEnvelope
    })
  } catch {
    throw new UpdateVerificationError()
  }
}

/** 流式核对缓存文件的大小与 SHA-512；下载完成和安装前都必须重新读取文件。 */
export async function verifyUpdateArtifact(file: string, manifest: UpdateManifest): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    if ((await lstat(file)).isSymbolicLink()) return false
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const before = await handle.stat()
    if (!before.isFile() || before.size !== manifest.artifact.size) return false
    const hash = createHash('sha512')
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length
      if (size > manifest.artifact.size) return false
      hash.update(chunk)
    }
    const after = await handle.stat()
    return size === manifest.artifact.size && before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs && after.size === size && hash.digest('base64') === manifest.artifact.sha512
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** 严格固定字段，避免协议偷偷携带远程公钥、任意 URL 或额外安装参数。 */
function requireFields(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw new Error()
  return value as Record<string, unknown>
}

/** 拒绝宽松 Base64 解码会忽略的字符及不同编码，约束签名和清单尺寸。 */
function decodeBase64(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maxBytes / 3) * 4) throw new Error()
  const decoded = Buffer.from(value, 'base64')
  if (!decoded.length || decoded.length > maxBytes || decoded.toString('base64') !== value) throw new Error()
  return decoded
}

/** 时间统一为 UTC 秒格式，拒绝自动归一化的无效日期。 */
function requireTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) throw new Error()
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().replace('.000Z', 'Z') !== value) throw new Error()
  return milliseconds
}
