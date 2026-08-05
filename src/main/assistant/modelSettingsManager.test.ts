import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronState = vi.hoisted(() => ({ userDataPath: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => electronState.userDataPath },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}))

import { ModelSettingsManager } from './modelSettingsManager'

describe('ModelSettingsManager', () => {
  beforeEach(async () => {
    electronState.userDataPath = await mkdtemp(join(tmpdir(), 'petdock-model-settings-'))
    delete process.env.PETDOCK_LLM_API_KEY
    delete process.env.PETDOCK_LLM_BASE_URL
    process.env.PETDOCK_LLM_MODEL = 'env-model'
  })

  afterEach(async () => {
    delete process.env.PETDOCK_LLM_MODEL
    await rm(electronState.userDataPath, { recursive: true, force: true })
  })

  it('首次读取继承环境配置且不暴露密钥', () => {
    process.env.PETDOCK_LLM_API_KEY = 'environment-secret'
    const manager = new ModelSettingsManager()
    expect(manager.snapshot()).toMatchObject({ model: 'env-model', configuredKey: true, source: 'environment' })
    expect(JSON.stringify(manager.snapshot())).not.toContain('environment-secret')
    expect(manager.runtimeEnvironment()).toEqual({})
  })

  it('保存后通过 safeStorage 注入并可明确清除环境密钥', async () => {
    const manager = new ModelSettingsManager()
    expect(await manager.configure({ baseUrl: 'https://api.example/v1', model: 'saved-model', apiKey: 'saved-key' })).toBe(true)
    expect(manager.runtimeEnvironment()).toEqual({
      PETDOCK_LLM_BASE_URL: 'https://api.example/v1',
      PETDOCK_LLM_MODEL: 'saved-model',
      PETDOCK_LLM_API_KEY: 'saved-key'
    })
    expect(await manager.configure({ baseUrl: 'https://api.example/v1', model: 'saved-model', clearApiKey: true })).toBe(true)
    expect(manager.runtimeEnvironment().PETDOCK_LLM_API_KEY).toBe('')
  })

  it('保存非敏感字段时继承环境密钥，不会意外清除', async () => {
    process.env.PETDOCK_LLM_API_KEY = 'environment-secret'
    const manager = new ModelSettingsManager()
    await manager.configure({ baseUrl: 'https://api.example/v1', model: 'saved-model' })
    expect(manager.snapshot().configuredKey).toBe(true)
    expect(manager.runtimeEnvironment()).not.toHaveProperty('PETDOCK_LLM_API_KEY')
  })
})
