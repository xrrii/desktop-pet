import { app, safeStorage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AssistantModelSettingsInput,
  AssistantModelSettingsSnapshot
} from '../../shared/assistant'

interface ModelProfile {
  baseUrl: string
  model: string
  keyMode: 'inherit' | 'override' | 'clear'
}

/** 管理主模型的非敏感配置和 safeStorage 加密密钥，并为 Runtime 提供受控环境覆盖。 */
export class ModelSettingsManager {
  /** 返回脱敏快照；没有本地配置时显示当前进程环境的默认值。 */
  snapshot(): AssistantModelSettingsSnapshot {
    const profile = this.readProfile()
    if (!profile) {
      return {
        baseUrl: process.env.PETDOCK_LLM_BASE_URL?.trim() || '',
        model: process.env.PETDOCK_LLM_MODEL?.trim() || 'gpt-4o-mini',
        configuredKey: Boolean(process.env.PETDOCK_LLM_API_KEY?.trim()),
        source: 'environment'
      }
    }
    return {
      ...profile,
      configuredKey: profile.keyMode === 'override'
        ? this.readApiKey() !== null
        : Boolean(process.env.PETDOCK_LLM_API_KEY?.trim()),
      source: 'saved'
    }
  }

  /** 返回 Runtime 环境覆盖；空字符串用于明确清除旧进程环境中的密钥。 */
  runtimeEnvironment(): Record<string, string> {
    const profile = this.readProfile()
    if (!profile) {
      return {}
    }
    const key = this.readApiKey()
    return {
      PETDOCK_LLM_BASE_URL: profile.baseUrl,
      PETDOCK_LLM_MODEL: profile.model,
      ...(profile.keyMode === 'override'
        ? { PETDOCK_LLM_API_KEY: key || '' }
        : profile.keyMode === 'clear'
          ? { PETDOCK_LLM_API_KEY: '' }
          : {})
    }
  }

  /** 校验并保存主模型配置，返回是否需要重启 Runtime。 */
  async configure(input: AssistantModelSettingsInput): Promise<boolean> {
    if (!input || typeof input !== 'object') {
      throw new TypeError('主模型配置无效。')
    }
    const model = input.model?.trim() || ''
    const baseUrl = input.baseUrl?.trim() || ''
    const apiKey = input.apiKey?.trim() || ''
    if (!model || model.length > 200 || baseUrl.length > 500 || apiKey.length > 2_000) {
      throw new TypeError('主模型名称、地址或 API Key 长度无效。')
    }
    if (baseUrl) {
      validateModelBaseUrl(baseUrl)
    }
    if (input.clearApiKey && apiKey) {
      throw new TypeError('不能同时更新和删除主模型 API Key。')
    }
    const previous = this.snapshot()
    const previousKey = previous.configuredKey ? (this.readApiKey() ?? process.env.PETDOCK_LLM_API_KEY?.trim() ?? null) : null
    const keyMode: ModelProfile['keyMode'] = apiKey
      ? 'override'
      : input.clearApiKey
        ? 'clear'
        : (this.readProfile()?.keyMode ?? 'inherit')
    const changed = previous.baseUrl !== baseUrl || previous.model !== model ||
      (apiKey ? previousKey !== apiKey || keyMode !== 'override' :
        input.clearApiKey ? previousKey !== null || keyMode !== 'clear' : false)
    if (apiKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('当前系统无法安全加密主模型 API Key。')
      }
      await this.saveApiKey(apiKey)
    } else if (input.clearApiKey) {
      await rm(this.apiKeyPath(), { force: true })
    }
    await this.saveProfile({ baseUrl, model, keyMode })
    return changed
  }

  private readProfile(): ModelProfile | null {
    try {
      const value = JSON.parse(readFileSync(this.profilePath(), 'utf8')) as Partial<ModelProfile>
      if (typeof value.model === 'string' && value.model.trim()) {
        return {
          baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
          model: value.model,
          keyMode: value.keyMode === 'override' || value.keyMode === 'clear' ? value.keyMode : 'inherit'
        }
      }
    } catch {
      // 首次运行或损坏配置回退到环境变量，避免阻断助手启动。
    }
    return null
  }

  private readApiKey(): string | null {
    try {
      if (!existsSync(this.apiKeyPath()) || !safeStorage.isEncryptionAvailable()) return null
      return safeStorage.decryptString(readFileSync(this.apiKeyPath())).trim() || null
    } catch {
      return null
    }
  }

  private async saveProfile(profile: ModelProfile): Promise<void> {
    const path = this.profilePath()
    const temporary = `${path}.${randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(temporary, JSON.stringify(profile), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private async saveApiKey(value: string): Promise<void> {
    const path = this.apiKeyPath()
    const temporary = `${path}.${randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(temporary, safeStorage.encryptString(value), { mode: 0o600 })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private profilePath(): string {
    return join(app.getPath('userData'), 'assistant', 'model-profile.json')
  }

  private apiKeyPath(): string {
    return join(app.getPath('userData'), 'assistant', 'model-api-key.bin')
  }
}

/** 校验模型地址，禁止凭据、查询参数和非 HTTPS 外部连接。 */
function validateModelBaseUrl(value: string): void {
  const url = new URL(value)
  const localhost = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) ||
      url.username || url.password || url.search || url.hash) {
    throw new TypeError('主模型地址必须使用 HTTPS（本机可用 HTTP），且不得包含凭据或查询参数。')
  }
}
