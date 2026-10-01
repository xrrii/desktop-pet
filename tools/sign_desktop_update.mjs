import { createHash, createPrivateKey, sign } from 'node:crypto'
import { open, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

const MAX_ARTIFACT_BYTES = 2_147_483_648
const MAX_KEY_BYTES = 16_384
const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000
const OPTIONS = new Set(['--artifact', '--version', '--key-id', '--private-key', '--issued-at', '--expires-at', '--output'])

/** 仅携带固定中文提示，避免文件路径、私钥或底层错误进入终端日志。 */
class CliInputError extends Error {}

/** 严格读取成对参数，拒绝未知、缺失或重复选项。 */
function parseArguments(args) {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!OPTIONS.has(name) || values.has(name) || typeof value !== 'string' || !value || value.startsWith('--')) {
      throw new CliInputError('签名参数无效：请提供所有必需选项，且不要重复或添加未知选项。')
    }
    values.set(name, value)
  }
  if (values.size !== OPTIONS.size) {
    throw new CliInputError('签名参数不完整：需要 artifact、version、key-id、private-key、issued-at、expires-at 和 output。')
  }
  const version = values.get('--version')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
      version.split('.').some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new CliInputError('版本必须是无前导零的正式三段整数。')
  }
  const keyId = values.get('--key-id')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(keyId)) {
    throw new CliInputError('签名密钥标识必须是安全的 ASCII 字母、数字、下划线或连字符。')
  }
  const issuedAt = values.get('--issued-at')
  const expiresAt = values.get('--expires-at')
  const validity = parseUtcSeconds(expiresAt) - parseUtcSeconds(issuedAt)
  if (validity <= 0 || validity > MAX_VALIDITY_MS) {
    throw new CliInputError('签名清单有效期必须大于零且不超过 30 天。')
  }
  return {
    artifact: values.get('--artifact'), version, keyId, issuedAt, expiresAt,
    privateKey: values.get('--private-key'), output: values.get('--output')
  }
}

/** 使用日期往返比较拒绝不存在的日期、时区偏移和非秒精度时间。 */
function parseUtcSeconds(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new CliInputError('签名时间必须使用严格 UTC ISO 秒格式。')
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().replace('.000Z', 'Z') !== value) {
    throw new CliInputError('签名时间不是有效的 UTC 日期。')
  }
  return timestamp
}

/** 只接受可公开分发的 ASCII EXE 文件名，排除 Windows 设备路径语义。 */
function requireArtifactName(path) {
  const fileName = basename(path)
  const stem = fileName.slice(0, -4)
  const deviceStem = fileName.split('.')[0].trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}\.exe$/.test(fileName) ||
      /[ .]$/.test(stem) || fileName.includes('..') ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(deviceStem)) {
    throw new CliInputError('安装包文件名必须是安全的 ASCII EXE 文件名。')
  }
  return fileName
}

/** 在同一文件句柄上确认体积并流式计算摘要，拒绝读取期间发生体积变化。 */
async function describeArtifact(path) {
  const fileName = requireArtifactName(path)
  const file = await open(path, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_ARTIFACT_BYTES) {
      throw new CliInputError('安装包必须是大小为 1 字节至 2 GiB 的普通文件。')
    }
    const hash = createHash('sha512')
    let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length
      if (size > MAX_ARTIFACT_BYTES) {
        throw new CliInputError('读取期间安装包体积超过允许范围。')
      }
      hash.update(chunk)
    }
    if (size !== metadata.size) {
      throw new CliInputError('读取期间安装包体积发生变化，请使用稳定的安装包。')
    }
    return { kind: 'nsis', fileName, size, sha512: hash.digest('base64') }
  } finally {
    await file.close()
  }
}

/** 仅从指定的小型 PEM 文件导入 Ed25519 私钥，不支持参数或环境中的明文密钥。 */
async function readSigningKey(path) {
  const file = await open(path, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_KEY_BYTES) {
      throw new CliInputError('私钥文件无效，必须是受限大小的 PEM 普通文件。')
    }
    const pem = await file.readFile({ encoding: 'utf8' })
    if (Buffer.byteLength(pem, 'utf8') > MAX_KEY_BYTES) {
      throw new CliInputError('私钥文件超过允许大小。')
    }
    const key = createPrivateKey(pem)
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
      throw new CliInputError('只允许使用 Ed25519 私钥签名桌面更新清单。')
    }
    return key
  } finally {
    await file.close()
  }
}

/** 绑定固定应用、渠道、平台与架构，签名原始 UTF-8 清单字节而非重序列化内容。 */
async function runCli(args) {
  const input = parseArguments(args)
  const key = await readSigningKey(input.privateKey)
  const manifest = {
    schemaVersion: 1, appId: 'com.local.petdock', version: input.version,
    channel: 'stable', platform: 'win32', arch: 'x64',
    artifact: await describeArtifact(input.artifact),
    issuedAt: input.issuedAt, expiresAt: input.expiresAt
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  const signedBytes = Buffer.concat([
    Buffer.from(`PetDock desktop update manifest v1\n${input.keyId}\n`, 'utf8'), manifestBytes
  ])
  const envelope = {
    schemaVersion: 1, keyId: input.keyId,
    manifest: manifestBytes.toString('base64'), signature: sign(null, signedBytes, key).toString('base64')
  }
  await writeFile(input.output, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  console.log('桌面更新签名清单已生成。')
}

try {
  await runCli(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof CliInputError ? error.message : '桌面更新签名失败，请检查输入文件、权限与 Ed25519 私钥。')
  process.exitCode = 1
}
