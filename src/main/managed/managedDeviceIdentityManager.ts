import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const STORE_VERSION = 1
const DEFAULT_DISPLAY_NAME = 'Windows Desktop'
const MAX_STORE_BYTES = 1_000_000

interface DeviceIdentityStore {
  version: 1
  identities: Record<string, string>
}

/** 管理不含密钥的本地设备身份映射，避免账号切换时复用错误设备。 */
export class ManagedDeviceIdentityManager {
  constructor(
    private readonly issuer: URL,
    private readonly configuredStorePath?: string
  ) {}

  /** 返回账号对应的稳定 UUID；首次使用时使用原子写入持久化。 */
  async getOrCreate(subject: string): Promise<string> {
    const store = await this.readStore()
    const key = this.subjectKey(subject)
    const existing = store.identities[key]
    if (existing && isUuid(existing)) {
      return existing
    }
    const deviceId = randomUUID()
    store.identities[key] = deviceId
    await this.writeStore(store)
    return deviceId
  }

  /** 记录服务端已确认的设备 ID，修复本地映射并保持后续注册幂等。 */
  async remember(subject: string, deviceId: string): Promise<void> {
    if (!isUuid(deviceId)) {
      throw new Error('服务端设备 ID 无效。')
    }
    const store = await this.readStore()
    const key = this.subjectKey(subject)
    if (store.identities[key] === deviceId) {
      return
    }
    store.identities[key] = deviceId
    await this.writeStore(store)
  }

  /** 删除指定账号的设备映射，设备撤销后禁止继续复用原设备 UUID。 */
  async clear(subject: string): Promise<void> {
    const store = await this.readStore()
    const key = this.subjectKey(subject)
    if (!(key in store.identities)) {
      return
    }
    delete store.identities[key]
    await this.writeStore(store)
  }

  /** 返回固定的桌面显示名，避免读取硬件、用户名或路径等隐私信息。 */
  getDefaultDisplayName(): string {
    return DEFAULT_DISPLAY_NAME
  }

  /** 对 subject 做不可逆映射，原文不落盘、不进入日志或 Renderer。 */
  subjectKey(subject: string): string {
    return createHash('sha256')
      .update(`${this.issuer.href.replace(/\/$/, '')}\0${subject}`, 'utf8')
      .digest('hex')
  }

  /** 读取版本化本地映射；损坏或不存在时视为可重建空缓存。 */
  private async readStore(): Promise<DeviceIdentityStore> {
    try {
      const serialized = await readFile(this.storePath(), 'utf8')
      if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
        return { version: STORE_VERSION, identities: {} }
      }
      const value: unknown = JSON.parse(serialized)
      if (!isDeviceIdentityStore(value)) {
        return { version: STORE_VERSION, identities: {} }
      }
      return { version: STORE_VERSION, identities: { ...value.identities } }
    } catch (error) {
      if (isFileMissing(error) || isJsonError(error)) {
        return { version: STORE_VERSION, identities: {} }
      }
      throw error
    }
  }

  /** 通过临时文件和 rename 防止进程中断时写出半份 JSON。 */
  private async writeStore(store: DeviceIdentityStore): Promise<void> {
    const storePath = this.storePath()
    await mkdir(dirname(storePath), { recursive: true })
    const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, storePath)
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }

  /** 延迟解析 Electron userData 路径，避免模块初始化阶段依赖 app ready。 */
  private storePath(): string {
    return this.configuredStorePath || join(app.getPath('userData'), 'managed', 'device-identities.v1.json')
  }
}

/** 校验规范化设备 UUID。 */
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** 校验本地身份文件结构，只接受当前版本和 UUID 值。 */
function isDeviceIdentityStore(value: unknown): value is DeviceIdentityStore {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.version !== STORE_VERSION || !record.identities || typeof record.identities !== 'object') {
    return false
  }
  return Object.values(record.identities as Record<string, unknown>).every(isUuid)
}

/** 区分不存在文件和其他文件系统错误。 */
function isFileMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')
}

/** JSON 解析失败时允许重建非敏感设备映射。 */
function isJsonError(error: unknown): boolean {
  return error instanceof SyntaxError
}

/** 按冻结规则规范化设备显示名，供注册前校验和测试复用。 */
export function normalizeManagedDeviceDisplayName(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return DEFAULT_DISPLAY_NAME
  }
  let normalized = ''
  let pendingSpace = false
  for (const character of value) {
    if (/\p{Cc}/u.test(character)) {
      return DEFAULT_DISPLAY_NAME
    }
    if (/\p{White_Space}/u.test(character)) {
      pendingSpace = normalized.length > 0
      continue
    }
    if (pendingSpace) {
      normalized += ' '
      pendingSpace = false
    }
    normalized += character
  }
  const length = [...normalized].length
  return length >= 1 && length <= 100 ? normalized : DEFAULT_DISPLAY_NAME
}
