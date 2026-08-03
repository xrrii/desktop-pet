import { app, safeStorage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AssistantWebProvider,
  AssistantWebSettingsInput,
  AssistantWebSettingsSnapshot
} from '../../shared/assistant'

interface WebSearchProfile {
  version: 2
  enabled: boolean
  provider: AssistantWebProvider
}

const DEFAULT_PROFILE: WebSearchProfile = {
  version: 2,
  enabled: false,
  provider: 'volcengine'
}

const WEB_PROVIDERS: AssistantWebProvider[] = ['volcengine', 'brave']

/** 管理联网搜索开关和加密 API Key，任何密钥内容都不进入 Renderer。 */
export class WebSettingsManager {
  snapshot(): AssistantWebSettingsSnapshot {
    const profile = this.loadProfile()
    const configuredProviders = WEB_PROVIDERS.filter((provider) => this.readApiKey(provider) !== null)
    const configured = configuredProviders.includes(profile.provider)
    return {
      enabled: profile.enabled && configured,
      provider: profile.provider,
      configured,
      configuredProviders
    }
  }

  /** 保存联网配置；空白 key 表示保留现有密钥，clearApiKey 才会删除。 */
  async configure(input: AssistantWebSettingsInput): Promise<AssistantWebSettingsSnapshot> {
    if (!input || !isWebProvider(input.provider) || typeof input.enabled !== 'boolean') {
      throw new TypeError('联网搜索配置无效。')
    }
    if (input.apiKey !== undefined && typeof input.apiKey !== 'string') {
      throw new TypeError('搜索 API Key 无效。')
    }
    if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') {
      throw new TypeError('搜索 API Key 删除选项无效。')
    }
    const apiKey = input.apiKey?.trim() || ''
    if (apiKey.length > 1_000) {
      throw new TypeError('搜索 API Key 过长。')
    }
    if (input.clearApiKey && apiKey) {
      throw new TypeError('不能同时更新和删除搜索 API Key。')
    }
    if (apiKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('当前系统无法安全加密搜索 API Key。')
      }
      await this.saveApiKey(input.provider, apiKey)
    } else if (input.clearApiKey) {
      await this.clearApiKey(input.provider)
    }
    if (input.enabled && !this.readApiKey(input.provider)) {
      throw new Error('启用联网搜索前需要配置 API Key。')
    }
    await this.saveProfile({ version: 2, enabled: input.enabled, provider: input.provider })
    return this.snapshot()
  }

  /** 仅供 Main 的 Provider 调用，读取失败统一按未配置处理。 */
  apiKey(provider: AssistantWebProvider): string | null {
    return this.readApiKey(provider)
  }

  private loadProfile(): WebSearchProfile {
    try {
      const value = JSON.parse(readFileSync(this.profilePath(), 'utf8')) as {
        version?: unknown
        enabled?: unknown
        provider?: unknown
      }
      if (value.version === 2 && isWebProvider(value.provider) && typeof value.enabled === 'boolean') {
        return { version: 2, enabled: value.enabled, provider: value.provider }
      }
      // C3 早期版本只支持 Brave；保留其启用状态，并继续从旧密钥文件读取。
      if (value.version === 1 && value.provider === 'brave' && typeof value.enabled === 'boolean') {
        return { version: 2, enabled: value.enabled, provider: 'brave' }
      }
    } catch {
      // 首次运行或损坏配置统一回退为关闭状态。
    }
    return DEFAULT_PROFILE
  }

  private async saveProfile(profile: WebSearchProfile): Promise<void> {
    const path = this.profilePath()
    const temporary = `${path}.${randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(temporary, JSON.stringify(profile, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  /** 先写同目录临时文件再替换，避免崩溃时截断原有加密密钥。 */
  private async saveApiKey(provider: AssistantWebProvider, apiKey: string): Promise<void> {
    const path = this.apiKeyPath(provider)
    const temporary = `${path}.${randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(temporary, safeStorage.encryptString(apiKey), { mode: 0o600 })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private readApiKey(provider: AssistantWebProvider): string | null {
    const paths = provider === 'brave'
      ? [this.apiKeyPath(provider), this.legacyApiKeyPath()]
      : [this.apiKeyPath(provider)]
    for (const path of paths) {
      const value = this.readEncryptedApiKey(path)
      if (value) return value
    }
    return null
  }

  private readEncryptedApiKey(path: string): string | null {
    try {
      if (!existsSync(path) || !safeStorage.isEncryptionAvailable()) {
        return null
      }
      const value = safeStorage.decryptString(readFileSync(path)).trim()
      return value || null
    } catch {
      return null
    }
  }

  /** 删除当前 Provider 的密钥；Brave 同时清理 C3 早期版本的兼容文件。 */
  private async clearApiKey(provider: AssistantWebProvider): Promise<void> {
    await rm(this.apiKeyPath(provider), { force: true })
    if (provider === 'brave') {
      await rm(this.legacyApiKeyPath(), { force: true })
    }
  }

  private profilePath(): string {
    return join(app.getPath('userData'), 'assistant', 'web-search.json')
  }

  private apiKeyPath(provider: AssistantWebProvider): string {
    return join(app.getPath('userData'), 'assistant', `web-search-api-key-${provider}.bin`)
  }

  private legacyApiKeyPath(): string {
    return join(app.getPath('userData'), 'assistant', 'web-search-api-key.bin')
  }
}

function isWebProvider(value: unknown): value is AssistantWebProvider {
  return value === 'volcengine' || value === 'brave'
}
