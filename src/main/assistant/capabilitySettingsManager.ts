import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AssistantCapabilityName,
  AssistantCapabilitySettingsSnapshot,
  AssistantChatSelectedSource,
  AssistantEmbeddingSelectedSource,
  AssistantModelSettingsSnapshot,
  AssistantVisionSelectedSource,
  AssistantVisionSettingsSnapshot,
  AssistantWebSearchSelectedSource,
  AssistantWebSettingsSnapshot
} from '../../shared/assistant'
import { logError, logInfo } from '../logger'
import type { ManagedRuntimeSessionErrorCode } from '../../shared/managed'

/** 现有 Provider 管理器向能力来源计算提供的脱敏状态。 */
export interface CapabilityConfigurationState {
  chat: AssistantModelSettingsSnapshot
  chatBackend: 'auto' | 'mock' | 'langchain'
  managedChat: {
    enabled: boolean
    authenticated: boolean
    runtimeReady: boolean
    errorCode: ManagedRuntimeSessionErrorCode | string | null
  }
  embedding: {
    provider: 'hash' | 'local' | 'online'
    configured: boolean
  }
  vision: AssistantVisionSettingsSnapshot
  webSearch: AssistantWebSettingsSnapshot
}

interface SelectedCapabilitySettings {
  version: 1
  capabilities: {
    chat: AssistantChatSelectedSource
    embedding: AssistantEmbeddingSelectedSource
    vision: AssistantVisionSelectedSource
    rerank: AssistantRerankSelectedSource
    web_search: AssistantWebSearchSelectedSource
  }
}

export type CapabilitySettingsBackup = SelectedCapabilitySettings

type AssistantRerankSelectedSource = 'managed' | 'disabled'

/** Main 统一持久化能力来源，并基于现有配置计算有效来源。 */
export class CapabilitySettingsManager {
  constructor(private readonly getState: () => CapabilityConfigurationState) {}

  /** 返回不含密钥的能力快照；状态和有效来源不会单独持久化。 */
  snapshot(): AssistantCapabilitySettingsSnapshot {
    const state = this.getState()
    const selected = this.loadOrMigrate(state)
    return resolveSnapshot(selected, state)
  }

  /** 将当前能力快照交给 Runtime；JSON 中不包含任何凭据。 */
  runtimeEnvironment(): Record<string, string> {
    return {
      PETDOCK_RUNTIME_CAPABILITIES_JSON: JSON.stringify(this.snapshot())
    }
  }

  /** 更新单项来源选择；只接受契约允许的来源组合。 */
  setSelectedSource(capability: AssistantCapabilityName, source: string): void {
    const selected = this.loadOrMigrate(this.getState())
    if (!isAllowedSource(capability, source)) {
      throw new TypeError(`能力 ${capability} 的来源无效。`)
    }
    selected.capabilities[capability] = source as never
    this.save(selected)
  }

  /** 捕获来源选择，供 Provider 切换失败时恢复。 */
  captureConfiguration(): CapabilitySettingsBackup {
    return cloneSelection(this.loadOrMigrate(this.getState()))
  }

  /** 恢复来源选择，不接触任何 Provider 密钥。 */
  restoreConfiguration(backup: CapabilitySettingsBackup): void {
    this.save(cloneSelection(backup))
  }

  private loadOrMigrate(state: CapabilityConfigurationState): SelectedCapabilitySettings {
    const existing = this.read()
    if (existing) {
      return existing
    }
    const migrated: SelectedCapabilitySettings = {
      version: 1,
      capabilities: {
        // 历史版本未配置 Key 时仍使用 Mock 兼容运行，因此选择保留为 BYOK。
        chat: 'byok',
        embedding: state.embedding.provider === 'online' ? 'byok' : 'local',
        vision: isVisionConfigured(state) ? 'byok' : 'disabled',
        rerank: 'disabled',
        web_search: state.webSearch.enabled && state.webSearch.configured ? 'byok' : 'disabled'
      }
    }
    this.save(migrated)
    logInfo('assistant capability settings migrated', {
      chatConfigured: state.chat.configuredKey,
      embeddingProvider: state.embedding.provider,
      visionConfigured: isVisionConfigured(state),
      webSearchEnabled: state.webSearch.enabled
    })
    return migrated
  }

  private read(): SelectedCapabilitySettings | null {
    const path = this.settingsPath()
    if (!existsSync(path)) {
      return null
    }
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (isSelectedSettings(value)) {
        return value
      }
      throw new TypeError('能力来源配置结构无效。')
    } catch (error) {
      logError('assistant capability settings invalid, migrating', error)
      return null
    }
  }

  private save(value: SelectedCapabilitySettings): void {
    const path = this.settingsPath()
    const temporary = `${path}.${randomUUID()}.tmp`
    mkdirSync(dirname(path), { recursive: true })
    try {
      writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  private settingsPath(): string {
    return join(app.getPath('userData'), 'assistant', 'capability-settings.json')
  }
}

function resolveSnapshot(
  selected: SelectedCapabilitySettings,
  state: CapabilityConfigurationState
): AssistantCapabilitySettingsSnapshot {
  const chat = selected.capabilities.chat === 'byok'
    ? state.chatBackend === 'mock'
      ? available('byok', 'mock', 'available', 'mock_backend_requested')
      : state.chatBackend === 'langchain'
        ? state.chat.configuredKey
          ? available('byok', 'byok')
          : available('byok', 'byok', 'not_configured', 'byok_not_configured')
        : state.chat.configuredKey
          ? available('byok', 'byok')
          : available('byok', 'mock', 'not_configured', 'byok_not_configured')
    : selected.capabilities.chat === 'managed'
      ? resolveManagedChat(state.managedChat)
      : available('disabled', 'mock', 'disabled', 'user_disabled')

  const embedding = selected.capabilities.embedding === 'byok'
    ? state.embedding.provider === 'online' && state.embedding.configured
      ? available('byok', 'byok')
      : available('byok', 'local', 'not_configured', 'byok_not_configured')
    : selected.capabilities.embedding === 'managed'
      ? available('managed', 'local', 'unsupported_client', 'managed_not_supported')
      : available('local', 'local')

  const vision = selected.capabilities.vision === 'byok'
    ? isVisionConfigured(state)
      ? available('byok', 'byok')
      : available('byok', 'disabled', 'not_configured', 'byok_not_configured')
    : selected.capabilities.vision === 'managed'
      ? available('managed', 'disabled', 'unsupported_client', 'managed_not_supported')
      : available('disabled', 'disabled', 'disabled', 'user_disabled')

  const webSearch = selected.capabilities.web_search === 'byok'
    ? state.webSearch.enabled && state.webSearch.configured
      ? available('byok', 'byok')
      : available('byok', 'disabled', 'not_configured', 'byok_not_configured')
    : selected.capabilities.web_search === 'managed'
      ? available('managed', 'disabled', 'unsupported_client', 'managed_not_supported')
      : available('disabled', 'disabled', 'disabled', 'user_disabled')

  return {
    version: 1,
    capabilities: {
      chat,
      embedding,
      vision,
      rerank: selected.capabilities.rerank === 'managed'
        ? available('managed', 'disabled', 'unsupported_client', 'managed_not_supported')
        : available('disabled', 'disabled', 'disabled', 'user_disabled'),
      web_search: webSearch
    }
  }
}

/** 根据服务端开关、账号会话和 Runtime Lease 计算官方 Chat，不进行隐式 BYOK 回退。 */
function resolveManagedChat(state: CapabilityConfigurationState['managedChat']) {
  if (!state.enabled) {
    return available('managed', 'managed', 'provider_unavailable', 'managed_chat_disabled')
  }
  if (state.errorCode === 'managed_capability_not_entitled') {
    return available('managed', 'managed', 'not_entitled', 'managed_capability_not_entitled')
  }
  if (state.errorCode === 'managed_unsupported_client_version') {
    return available('managed', 'managed', 'unsupported_client', 'managed_unsupported_client_version')
  }
  if (!state.authenticated) {
    return available('managed', 'managed', 'not_authenticated', 'managed_authentication_required')
  }
  if (!state.runtimeReady) {
    return available('managed', 'managed', 'provider_unavailable', 'managed_runtime_not_ready')
  }
  if (state.errorCode) {
    return available('managed', 'managed', 'provider_unavailable', 'managed_provider_unavailable')
  }
  return available('managed', 'managed')
}

function available<Selected extends string, Effective extends string>(
  selectedSource: Selected,
  effectiveSource: Effective,
  status: AssistantCapabilitySettingsSnapshot['capabilities']['chat']['status'] = 'available',
  reason: string | null = null
): { selectedSource: Selected; effectiveSource: Effective; status: typeof status; reason: string | null } {
  /** 构造统一的脱敏能力解析项，避免各能力重复字段装配。 */
  return { selectedSource, effectiveSource, status, reason }
}

function isVisionConfigured(state: CapabilityConfigurationState): boolean {
  /** 判断视觉配置是否能使用主模型或独立凭据。 */
  if (state.vision.mode === 'custom' && state.vision.independentCredentials) {
    return state.vision.configuredKey
  }
  return state.chat.configuredKey
}

function isAllowedSource(capability: AssistantCapabilityName, source: string): boolean {
  /** 校验来源是否属于契约为该能力声明的白名单。 */
  const values: Record<AssistantCapabilityName, readonly string[]> = {
    chat: ['byok', 'managed', 'disabled'],
    embedding: ['byok', 'managed', 'local'],
    vision: ['byok', 'managed', 'disabled'],
    rerank: ['managed', 'disabled'],
    web_search: ['byok', 'managed', 'disabled']
  }
  return values[capability].includes(source)
}

function isSelectedSettings(value: unknown): value is SelectedCapabilitySettings {
  /** 严格验证磁盘中的来源配置，损坏时触发安全迁移。 */
  if (!value || typeof value !== 'object') return false
  const root = value as Record<string, unknown>
  const capabilities = root.capabilities
  if (root.version !== 1 || !capabilities || typeof capabilities !== 'object') return false
  const current = capabilities as Record<string, unknown>
  return Object.entries({
    chat: ['byok', 'managed', 'disabled'],
    embedding: ['byok', 'managed', 'local'],
    vision: ['byok', 'managed', 'disabled'],
    rerank: ['managed', 'disabled'],
    web_search: ['byok', 'managed', 'disabled']
  }).every(([name, allowed]) => typeof current[name] === 'string' && allowed.includes(current[name] as string))
}

function cloneSelection(value: SelectedCapabilitySettings): SelectedCapabilitySettings {
  /** 复制小型配置对象，避免回滚快照被后续修改污染。 */
  return JSON.parse(JSON.stringify(value)) as SelectedCapabilitySettings
}
