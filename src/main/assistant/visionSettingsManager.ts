import { app, safeStorage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

import type { AssistantVisionSettingsInput } from '../../shared/assistant'

interface VisionProfile {
  mode: 'inherit' | 'custom'
  baseUrl: string
  model: string
  independentCredentials: boolean
}

/** 管理视觉模型的非敏感配置和 safeStorage 加密凭据。 */
export class VisionSettingsManager {
  /** 返回 Runtime 环境；未配置字段由 Runtime 继承主模型。 */
  runtimeEnvironment(): Record<string, string> {
    const profile = this.readProfile()
    if (profile.mode === 'inherit') {
      return {}
    }
    const apiKey = profile.independentCredentials ? this.readApiKey() : null
    return {
      ...(profile.baseUrl ? { PETDOCK_VISION_BASE_URL: profile.baseUrl } : {}),
      ...(profile.model ? { PETDOCK_VISION_MODEL: profile.model } : {}),
      ...(apiKey ? { PETDOCK_VISION_API_KEY: apiKey } : {})
    }
  }

  /** 保存继承、同凭据覆盖模型或独立端点配置，返回配置是否实际变化。 */
  async configure(input: AssistantVisionSettingsInput): Promise<boolean> {
    if (!input || typeof input !== 'object' || !['inherit', 'custom'].includes(input.mode)) {
      throw new TypeError('视觉配置无效。')
    }
    const model = input.model?.trim() || ''
    const baseUrl = input.baseUrl?.trim() || ''
    const apiKey = input.apiKey?.trim() || ''
    if (model.length > 200 || apiKey.length > 2_000) {
      throw new TypeError('视觉模型或密钥长度无效。')
    }
    if (baseUrl) {
      validateVisionBaseUrl(baseUrl)
    }
    if (input.mode === 'custom' && !model) {
      throw new TypeError('单独视觉配置必须指定模型。')
    }
    const previousProfile = this.readProfile()
    const previousKey = this.readApiKey()
    const profile: VisionProfile = input.mode === 'inherit'
      ? { mode: 'inherit', baseUrl: '', model: '', independentCredentials: false }
      : {
          mode: 'custom',
          baseUrl,
          model,
          independentCredentials: input.independentCredentials === true
        }
    const keyChanged = apiKey
      ? previousKey !== apiKey
      : Boolean(input.clearApiKey || !profile.independentCredentials) && previousKey !== null
    const profileChanged = JSON.stringify(previousProfile) !== JSON.stringify(profile)
    const changed = profileChanged || keyChanged
    if (apiKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储当前不可用，无法保存视觉模型密钥。')
      }
      await writeAtomic(this.apiKeyPath(), safeStorage.encryptString(apiKey))
    } else if (input.clearApiKey || !input.independentCredentials) {
      await rm(this.apiKeyPath(), { force: true })
    }
    await writeAtomic(this.profilePath(), Buffer.from(JSON.stringify(profile), 'utf8'))
    return changed
  }

  /** 返回不含密钥的配置模式，供设置界面恢复表单。 */
  snapshot(): Omit<VisionProfile, 'independentCredentials'> & { independentCredentials: boolean; configuredKey: boolean } {
    const profile = this.readProfile()
    return { ...profile, configuredKey: this.readApiKey() !== null }
  }

  /** 读取并校验非敏感配置，损坏时降级为继承模式。 */
  private readProfile(): VisionProfile {
    try {
      const value = JSON.parse(readFileSync(this.profilePath(), 'utf8')) as Partial<VisionProfile>
      if (value.mode === 'custom' && typeof value.model === 'string') {
        return {
          mode: 'custom',
          baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
          model: value.model,
          independentCredentials: value.independentCredentials === true
        }
      }
    } catch {
      // 首次启动、旧版本或损坏配置都安全回退为主模型继承。
    }
    return { mode: 'inherit', baseUrl: '', model: '', independentCredentials: false }
  }

  /** 解密独立视觉密钥，失败时不向 Runtime 注入任何凭据。 */
  private readApiKey(): string | null {
    try {
      if (!existsSync(this.apiKeyPath()) || !safeStorage.isEncryptionAvailable()) {
        return null
      }
      return safeStorage.decryptString(readFileSync(this.apiKeyPath())).trim() || null
    } catch {
      return null
    }
  }

  /** 返回非敏感配置文件路径。 */
  private profilePath(): string {
    return join(app.getPath('userData'), 'assistant', 'vision-profile.json')
  }

  /** 返回 safeStorage 密文文件路径。 */
  private apiKeyPath(): string {
    return join(app.getPath('userData'), 'assistant', 'vision-api-key.bin')
  }
}

/** 原子写入设置文件，避免异常退出留下半截 JSON 或密文。 */
async function writeAtomic(path: string, content: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  try {
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** 校验视觉地址不含凭据、查询参数或片段，并限制到 HTTPS/本机 HTTP。 */
function validateVisionBaseUrl(value: string): void {
  const url = new URL(value)
  const localhost = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) ||
      url.username || url.password || url.search || url.hash) {
    throw new TypeError('视觉服务地址必须是 HTTPS，或本机 HTTP，且不得包含凭据、查询参数或片段。')
  }
}
