import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  userDataPath: ''
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userDataPath
  }
}))

vi.mock('../logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn()
}))

import {
  CapabilitySettingsManager,
  type CapabilityConfigurationState
} from './capabilitySettingsManager'

describe('CapabilitySettingsManager', () => {
  let state: CapabilityConfigurationState

  beforeEach(async () => {
    electronState.userDataPath = await mkdtemp(join(tmpdir(), 'petdock-capabilities-'))
    state = offlineState()
  })

  afterEach(async () => {
    await rm(electronState.userDataPath, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('首次启动只迁移来源，并保留无密钥时的 Mock 兼容行为', async () => {
    const manager = new CapabilitySettingsManager(() => state)
    const snapshot = manager.snapshot()

    expect(snapshot.capabilities.chat).toEqual({
      selectedSource: 'byok',
      effectiveSource: 'mock',
      status: 'not_configured',
      reason: 'byok_not_configured'
    })
    expect(snapshot.capabilities.embedding.effectiveSource).toBe('local')
    expect(snapshot.capabilities.vision.effectiveSource).toBe('disabled')
    expect(snapshot.capabilities.web_search.effectiveSource).toBe('disabled')

    const persisted = await readFile(settingsPath(), 'utf8')
    expect(JSON.parse(persisted)).toEqual({
      version: 1,
      capabilities: {
        chat: 'byok',
        embedding: 'local',
        vision: 'disabled',
        rerank: 'disabled',
        web_search: 'disabled'
      }
    })
    expect(persisted).not.toContain('configuredKey')
    expect(JSON.parse(manager.runtimeEnvironment().PETDOCK_RUNTIME_CAPABILITIES_JSON)).toEqual(snapshot)
  })

  it('从现有在线配置迁移为 BYOK，但不保存任何凭据内容', async () => {
    state = configuredState()
    const manager = new CapabilitySettingsManager(() => state)
    const snapshot = manager.snapshot()

    expect(snapshot.capabilities.chat.effectiveSource).toBe('byok')
    expect(snapshot.capabilities.embedding.effectiveSource).toBe('byok')
    expect(snapshot.capabilities.vision.effectiveSource).toBe('byok')
    expect(snapshot.capabilities.web_search.effectiveSource).toBe('byok')
    const persisted = await readFile(settingsPath(), 'utf8')
    expect(persisted).not.toContain('api-key')
    expect(persisted).not.toContain('secret')
  })

  it('显式 Mock 后端优先于已存在的 BYOK Key', () => {
    state = configuredState()
    state.chatBackend = 'mock'
    const manager = new CapabilitySettingsManager(() => state)

    expect(manager.snapshot().capabilities.chat).toEqual({
      selectedSource: 'byok',
      effectiveSource: 'mock',
      status: 'available',
      reason: 'mock_backend_requested'
    })
  })

  it('Managed 不可用时保留选择且不自动使用现有 BYOK', () => {
    state = configuredState()
    const manager = new CapabilitySettingsManager(() => state)
    manager.snapshot()
    manager.setSelectedSource('chat', 'managed')
    manager.setSelectedSource('embedding', 'managed')
    manager.setSelectedSource('vision', 'managed')
    manager.setSelectedSource('web_search', 'managed')

    const snapshot = manager.snapshot()
    expect(snapshot.capabilities.chat).toMatchObject({
      selectedSource: 'managed',
      effectiveSource: 'managed',
      status: 'provider_unavailable',
      reason: 'managed_chat_disabled'
    })
    expect(snapshot.capabilities.embedding.effectiveSource).toBe('local')
    expect(snapshot.capabilities.vision.effectiveSource).toBe('disabled')
    expect(snapshot.capabilities.web_search.effectiveSource).toBe('disabled')
  })

  it('Managed 登录、Runtime 和开关都就绪时才进入官方 Chat', () => {
    state = configuredState()
    state.managedChat = { enabled: true, authenticated: true, runtimeReady: true, errorCode: null }
    const manager = new CapabilitySettingsManager(() => state)
    manager.snapshot()
    manager.setSelectedSource('chat', 'managed')

    expect(manager.snapshot().capabilities.chat).toEqual({
      selectedSource: 'managed',
      effectiveSource: 'managed',
      status: 'available',
      reason: null
    })
  })

  it('Provider 切换失败时可以恢复完整的来源选择', () => {
    const manager = new CapabilitySettingsManager(() => state)
    const backup = manager.captureConfiguration()
    manager.setSelectedSource('embedding', 'byok')
    expect(manager.snapshot().capabilities.embedding.selectedSource).toBe('byok')

    manager.restoreConfiguration(backup)
    expect(manager.snapshot().capabilities.embedding.selectedSource).toBe('local')
  })

  it('配置损坏时按当前脱敏状态重新迁移', async () => {
    await mkdir(join(electronState.userDataPath, 'assistant'), { recursive: true })
    await writeFile(settingsPath(), '{invalid', 'utf8')
    const manager = new CapabilitySettingsManager(() => state)

    expect(manager.snapshot().capabilities.chat.effectiveSource).toBe('mock')
    expect(JSON.parse(await readFile(settingsPath(), 'utf8')).version).toBe(1)
  })
})

function offlineState(): CapabilityConfigurationState {
  return {
    chat: { baseUrl: '', model: 'gpt-4o-mini', configuredKey: false, source: 'environment' },
    chatBackend: 'auto',
    managedChat: { enabled: false, authenticated: false, runtimeReady: false, errorCode: null },
    embedding: { provider: 'hash', configured: true },
    vision: {
      mode: 'inherit',
      baseUrl: '',
      model: '',
      independentCredentials: false,
      configuredKey: false
    },
    webSearch: {
      enabled: false,
      provider: 'volcengine',
      configured: false,
      configuredProviders: []
    }
  }
}

function configuredState(): CapabilityConfigurationState {
  return {
    chat: {
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      configuredKey: true,
      source: 'saved'
    },
    chatBackend: 'auto',
    managedChat: { enabled: false, authenticated: false, runtimeReady: false, errorCode: null },
    embedding: { provider: 'online', configured: true },
    vision: {
      mode: 'custom',
      baseUrl: 'https://vision.example.test/v1',
      model: 'vision-model',
      independentCredentials: true,
      configuredKey: true
    },
    webSearch: {
      enabled: true,
      provider: 'volcengine',
      configured: true,
      configuredProviders: ['volcengine']
    }
  }
}

function settingsPath(): string {
  return join(electronState.userDataPath, 'assistant', 'capability-settings.json')
}
