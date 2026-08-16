import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const STORE_VERSION = 1
const MAX_STORE_BYTES = 1_000_000

interface ManagedRefreshTokenDocument {
  version: 1
  encryptedRefreshToken: string
  updatedAt: string
}

/** Refresh Token 持久化读取结果，不把密文或底层异常暴露给上层。 */
export type ManagedTokenLoadResult =
  | { status: 'missing' }
  | { status: 'available'; refreshToken: string }
  | { status: 'unavailable' }
  | { status: 'corrupt' }

/** Refresh Token 持久化失败分类，供认证状态机映射稳定错误码。 */
export class ManagedTokenStoreError extends Error {
  constructor(readonly reason: 'unavailable' | 'write_failed') {
    super('Managed Refresh Token 存储操作失败。')
    this.name = 'ManagedTokenStoreError'
  }
}

/** Main 内部使用的最小 Token Store 接口，便于认证流程和测试替换实现。 */
export interface ManagedTokenStore {
  isAvailable(): boolean
  load(): Promise<ManagedTokenLoadResult>
  save(refreshToken: string): Promise<void>
  clear(): Promise<void>
}

/** 使用 Electron safeStorage 加密并原子持久化桌面 Refresh Token。 */
export class ElectronManagedTokenStore implements ManagedTokenStore {
  /** 返回当前系统会话是否可以使用 Electron 安全加密能力。 */
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /** 读取并解密 Refresh Token；损坏文件会隔离，安全存储暂时不可用时保留原文件。 */
  async load(): Promise<ManagedTokenLoadResult> {
    const path = this.storePath()
    if (!existsSync(path)) {
      return { status: 'missing' }
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { status: 'unavailable' }
    }

    let serialized: string
    try {
      serialized = await readFile(path, 'utf8')
    } catch {
      // 临时权限、占用或文件系统错误不代表密文损坏，必须保留原文件供后续重试。
      return { status: 'unavailable' }
    }

    try {
      if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
        throw new TypeError('Managed Refresh Token 文件过大。')
      }
      const document = parseDocument(serialized)
      const encrypted = decodeBase64(document.encryptedRefreshToken)
      const refreshToken = safeStorage.decryptString(encrypted)
      if (!refreshToken) {
        throw new TypeError('Managed Refresh Token 解密结果为空。')
      }
      return { status: 'available', refreshToken }
    } catch {
      await this.quarantine(path)
      return { status: 'corrupt' }
    }
  }

  /** 加密并原子保存新 Refresh Token，旧文件只在替换成功后失效。 */
  async save(refreshToken: string): Promise<void> {
    if (!refreshToken) {
      throw new ManagedTokenStoreError('write_failed')
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new ManagedTokenStoreError('unavailable')
    }

    let encrypted: Buffer
    try {
      encrypted = safeStorage.encryptString(refreshToken)
    } catch {
      throw new ManagedTokenStoreError('unavailable')
    }

    const document: ManagedRefreshTokenDocument = {
      version: STORE_VERSION,
      encryptedRefreshToken: encrypted.toString('base64'),
      updatedAt: new Date().toISOString()
    }
    const path = this.storePath()
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temporary, JSON.stringify(document, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      })
      await rename(temporary, path)
    } catch {
      throw new ManagedTokenStoreError('write_failed')
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  /** 清除本地 Refresh Token；服务端撤销由后续退出与设备流程负责。 */
  async clear(): Promise<void> {
    try {
      await rm(this.storePath(), { force: true })
    } catch {
      throw new ManagedTokenStoreError('write_failed')
    }
  }

  /** 返回当前系统用户专属的版本化密文文件路径。 */
  private storePath(): string {
    return join(app.getPath('userData'), 'managed', 'refresh-token.v1.json')
  }

  /** 将不可解析或不可解密的文件移出活动路径，避免每次启动重复处理。 */
  private async quarantine(path: string): Promise<void> {
    const quarantined = `${path}.corrupt.${randomUUID()}`
    await rename(path, quarantined).catch(() => undefined)
  }
}

/** 严格校验版本化 JSON 文档，未知版本不进行猜测性迁移。 */
function parseDocument(serialized: string): ManagedRefreshTokenDocument {
  const value = JSON.parse(serialized) as Record<string, unknown>
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== STORE_VERSION ||
    typeof value.encryptedRefreshToken !== 'string' ||
    !value.encryptedRefreshToken ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new TypeError('Managed Refresh Token 文件结构无效。')
  }
  return value as unknown as ManagedRefreshTokenDocument
}

/** 使用规范 Base64 解码密文，拒绝 Node.js 宽松解码可能接受的损坏内容。 */
function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new TypeError('Managed Refresh Token 密文编码无效。')
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new TypeError('Managed Refresh Token 密文编码无效。')
  }
  return decoded
}
