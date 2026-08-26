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
  AssistantServiceMode,
  AssistantVisionSelectedSource,
  AssistantVisionSettingsSnapshot,
  AssistantWebSearchSelectedSource,
  AssistantWebSettingsSnapshot
} from '../../shared/assistant'
import { logError, logInfo } from '../logger'
import type {
  ManagedCapabilityPreferencesSnapshot,
  ManagedRuntimeSessionErrorCode
} from '../../shared/managed'

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
  managedWebSearch?: {
    enabled: boolean
    authenticated: boolean
    runtimeReady: boolean
    errorCode: ManagedRuntimeSessionErrorCode | string | null
  }
  managedVision?: {
    enabled: boolean
    authenticated: boolean
    runtimeReady: boolean
    errorCode: ManagedRuntimeSessionErrorCode | string | null
  }
  managedEmbedding?: {
    enabled: boolean
    authenticated: boolean
    runtimeReady: boolean
    errorCode: ManagedRuntimeSessionErrorCode | string | null
  }
  managedRerank?: {
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
  serviceMode: AssistantServiceMode
  capabilities: {
    chat: AssistantChatSelectedSource
    embedding: AssistantEmbeddingSelectedSource
    vision: AssistantVisionSelectedSource
    rerank: AssistantRerankSelectedSource
    web_search: AssistantWebSearchSelectedSource
  }
}

export type CapabilitySettingsBackup = SelectedCapabilitySettings

/** 应用服务端能力状态后的变更摘要，供 Runtime 决定是否重启和重建索引。 */
export interface ManagedCapabilityApplyResult {
  changed: boolean
  embeddingChanged: boolean
}

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

  /** 原子更新 Chat 与 Web Search；离开官方模式时也停止 Managed Vision。 */
  setServiceMode(mode: AssistantServiceMode): void {
    const selected = this.loadOrMigrate(this.getState())
    selected.serviceMode = mode
    selected.capabilities.chat = mode
    selected.capabilities.web_search = mode
    if (mode === 'byok' && selected.capabilities.vision === 'managed') {
      selected.capabilities.vision = 'byok'
    }
    this.save(selected)
  }

  /** 返回独立持久化的设置页服务标签，不以当前有效能力来源反推。 */
  getServiceMode(): AssistantServiceMode {
    return this.loadOrMigrate(this.getState()).serviceMode
  }

  /** 只更新设置页服务标签；能力来源由服务器有效状态或完整模式切换另行处理。 */
  setServiceModeSelection(mode: AssistantServiceMode): void {
    const selected = this.loadOrMigrate(this.getState())
    selected.serviceMode = mode
    this.save(selected)
  }

  /**
   * 应用服务端计算后的官方能力状态。
   * 有效能力切到 Managed；失效能力仅在当前来源为 Managed 时回退，保留全部 BYOK 配置。
   */
  applyManagedCapabilities(snapshot: ManagedCapabilityPreferencesSnapshot): ManagedCapabilityApplyResult {
    const state = this.getState()
    const selected = this.loadOrMigrate(state)
    const previous = cloneSelection(selected)

    // 有活动套餐时服务器偏好可以跨设备同步主模式；无套餐的全关状态
    // 只影响能力开关，不得把用户当前查看的官方服务标签切回 BYOK。
    if (snapshot.subscriptionActive) {
      selected.serviceMode = snapshot.preferences.chat ? 'managed' : 'byok'
    }

    for (const capability of ['chat', 'embedding', 'vision', 'web_search', 'rerank'] as const) {
      if (snapshot.effective[capability]) {
        selected.capabilities[capability] = 'managed' as never
      } else if (selected.capabilities[capability] === 'managed') {
        selected.capabilities[capability] = fallbackSource(capability, state) as never
      }
    }

    const changed = JSON.stringify(previous) !== JSON.stringify(selected)
    if (changed) {
      this.save(selected)
      logInfo('服务器官方能力状态已应用到桌面端', {
        subscriptionActive: snapshot.subscriptionActive,
        enabledCount: Object.values(snapshot.effective).filter(Boolean).length
      })
    }
    return {
      changed,
      embeddingChanged: previous.capabilities.embedding !== selected.capabilities.embedding
    }
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
      serviceMode: 'byok',
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
        const selected = value as Omit<SelectedCapabilitySettings, 'serviceMode'> & {
          serviceMode?: AssistantServiceMode
        }
        if (selected.serviceMode) {
          return selected as SelectedCapabilitySettings
        }
        const migrated: SelectedCapabilitySettings = {
          ...selected,
          serviceMode: selected.capabilities.chat === 'managed' ? 'managed' : 'byok'
        }
        this.save(migrated)
        logInfo('assistant service mode selection migrated', { serviceMode: migrated.serviceMode })
        return migrated
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
      ? resolveManagedEmbedding(state.managedEmbedding)
      : available('local', 'local')

  const vision = selected.capabilities.vision === 'byok'
    ? isVisionConfigured(state)
      ? available('byok', 'byok')
      : available('byok', 'disabled', 'not_configured', 'byok_not_configured')
    : selected.capabilities.vision === 'managed'
      ? resolveManagedCapability('vision', state.managedVision)
      : available('disabled', 'disabled', 'disabled', 'user_disabled')

  const webSearch = selected.capabilities.web_search === 'byok'
    ? state.webSearch.enabled && state.webSearch.configured
      ? available('byok', 'byok')
      : available('byok', 'disabled', 'not_configured', 'byok_not_configured')
    : selected.capabilities.web_search === 'managed'
      ? resolveManagedCapability('web_search', state.managedWebSearch)
      : available('disabled', 'disabled', 'disabled', 'user_disabled')

  return {
    version: 1,
    capabilities: {
      chat,
      embedding,
      vision,
      rerank: selected.capabilities.rerank === 'managed'
        ? resolveManagedCapability('rerank', state.managedRerank)
        : available('disabled', 'disabled', 'disabled', 'user_disabled'),
      web_search: webSearch
    }
  }
}

/** 计算独立 Managed Web Search 的脱敏状态，不自动切换 BYOK。 */
function resolveManagedCapability(
  capability: 'vision' | 'web_search' | 'rerank',
  state: CapabilityConfigurationState['managedWebSearch'] | CapabilityConfigurationState['managedVision'] | CapabilityConfigurationState['managedRerank']
) {
  // 用户明确选择 Managed 时始终保留 managed effectiveSource；启动竞态或服务端暂不可用
  // 只能影响状态，不能降级成 disabled，否则 Runtime 不会装配对应的 Managed Provider。
  if (!state?.enabled) return available('managed', 'managed', 'provider_unavailable', `managed_${capability}_disabled`)
  if (state.errorCode === 'managed_capability_not_entitled') {
    return available('managed', 'managed', 'not_entitled', `managed_${capability}_not_entitled`)
  }
  if (!state.authenticated) return available('managed', 'managed', 'not_authenticated', 'managed_authentication_required')
  if (!state.runtimeReady || state.errorCode) {
    // Runtime 重启期间仍保持 Managed effectiveSource，避免新进程按 BYOK/inherited 启动；
    // runtimeReady 和 errorCode 继续通过状态字段告知 UI 当前尚未可用。
    return available('managed', 'managed', 'provider_unavailable', `managed_${capability}_unavailable`)
  }
  return available('managed', 'managed', 'available', null)
}

/** 计算 Managed Embedding 的脱敏状态，不因 Runtime 重启回退到本地 Hash。 */
function resolveManagedEmbedding(state: CapabilityConfigurationState['managedEmbedding']) {
  if (!state?.enabled) return available('managed', 'managed', 'provider_unavailable', 'managed_embedding_disabled')
  if (state.errorCode === 'managed_capability_not_entitled') {
    return available('managed', 'managed', 'not_entitled', 'managed_embedding_not_entitled')
  }
  if (!state.authenticated) return available('managed', 'managed', 'not_authenticated', 'managed_authentication_required')
  if (!state.runtimeReady || state.errorCode) {
    return available('managed', 'managed', 'provider_unavailable', 'managed_embedding_unavailable')
  }
  return available('managed', 'managed')
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
  if (root.serviceMode !== undefined && root.serviceMode !== 'managed' && root.serviceMode !== 'byok') return false
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

/** 根据现有本地配置选择官方能力失效后的安全来源，不修改或删除任何凭据。 */
function fallbackSource(
  capability: keyof SelectedCapabilitySettings['capabilities'],
  state: CapabilityConfigurationState
): SelectedCapabilitySettings['capabilities'][typeof capability] {
  switch (capability) {
    case 'chat':
      return 'byok'
    case 'embedding':
      return 'local'
    case 'vision':
      return isVisionConfigured(state) ? 'byok' : 'disabled'
    case 'web_search':
      return state.webSearch.enabled && state.webSearch.configured ? 'byok' : 'disabled'
    case 'rerank':
      return 'disabled'
  }
}
