import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronState = vi.hoisted(() => ({ userDataPath: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userDataPath
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}))

import { WebSettingsManager } from './webSettingsManager'

describe('WebSettingsManager', () => {
  beforeEach(async () => {
    electronState.userDataPath = await mkdtemp(join(tmpdir(), 'petdock-web-settings-'))
  })

  afterEach(async () => {
    await rm(electronState.userDataPath, { recursive: true, force: true })
  })

  it('首次运行默认选择火山引擎且保持关闭', () => {
    const manager = new WebSettingsManager()

    expect(manager.snapshot()).toEqual({
      enabled: false,
      provider: 'volcengine',
      configured: false,
      configuredProviders: []
    })
  })

  it('按 Provider 隔离保存和删除 API Key', async () => {
    const manager = new WebSettingsManager()

    await manager.configure({ enabled: false, provider: 'volcengine', apiKey: 'volc-key' })
    await manager.configure({ enabled: false, provider: 'brave', apiKey: 'brave-key' })

    expect(manager.apiKey('volcengine')).toBe('volc-key')
    expect(manager.apiKey('brave')).toBe('brave-key')
    expect(manager.snapshot().configuredProviders).toEqual(['volcengine', 'brave'])

    await manager.configure({ enabled: false, provider: 'brave', clearApiKey: true })

    expect(manager.apiKey('brave')).toBeNull()
    expect(manager.apiKey('volcengine')).toBe('volc-key')
    expect(manager.snapshot().configuredProviders).toEqual(['volcengine'])
  })

  it('将 C3 早期配置和旧密钥文件继续识别为 Brave 配置', async () => {
    const assistantDirectory = join(electronState.userDataPath, 'assistant')
    await mkdir(assistantDirectory, { recursive: true })
    await writeFile(
      join(assistantDirectory, 'web-search.json'),
      JSON.stringify({ version: 1, enabled: true, provider: 'brave' }),
      'utf8'
    )
    await writeFile(
      join(assistantDirectory, 'web-search-api-key.bin'),
      Buffer.from('encrypted:legacy-brave-key', 'utf8')
    )

    const manager = new WebSettingsManager()
    expect(manager.snapshot()).toEqual({
      enabled: true,
      provider: 'brave',
      configured: true,
      configuredProviders: ['brave']
    })

    await manager.configure({ enabled: false, provider: 'volcengine' })

    expect(manager.snapshot()).toMatchObject({
      provider: 'volcengine',
      configured: false,
      configuredProviders: ['brave']
    })
    expect(manager.apiKey('volcengine')).toBeNull()
    expect(manager.apiKey('brave')).toBe('legacy-brave-key')
  })
})
