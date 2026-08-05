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

import { VisionSettingsManager } from './visionSettingsManager'

describe('VisionSettingsManager', () => {
  beforeEach(async () => {
    electronState.userDataPath = await mkdtemp(join(tmpdir(), 'petdock-vision-settings-'))
  })

  afterEach(async () => {
    await rm(electronState.userDataPath, { recursive: true, force: true })
  })

  it('默认继承主模型且不额外注入环境变量', () => {
    const manager = new VisionSettingsManager()
    expect(manager.snapshot()).toMatchObject({ mode: 'inherit', configuredKey: false })
    expect(manager.runtimeEnvironment()).toEqual({})
  })

  it('允许同一地址和凭据下仅覆盖视觉模型', async () => {
    const manager = new VisionSettingsManager()
    await manager.configure({ mode: 'custom', model: 'vision-only', independentCredentials: false })
    expect(manager.runtimeEnvironment()).toEqual({ PETDOCK_VISION_MODEL: 'vision-only' })
  })

  it('独立端点和密钥通过 safeStorage 注入 Runtime', async () => {
    const manager = new VisionSettingsManager()
    await manager.configure({
      mode: 'custom',
      baseUrl: 'https://vision.example/v1',
      model: 'vision-model',
      independentCredentials: true,
      apiKey: 'private-key'
    })
    expect(manager.snapshot()).toMatchObject({ configuredKey: true, independentCredentials: true })
    expect(manager.runtimeEnvironment()).toEqual({
      PETDOCK_VISION_BASE_URL: 'https://vision.example/v1',
      PETDOCK_VISION_MODEL: 'vision-model',
      PETDOCK_VISION_API_KEY: 'private-key'
    })
  })

  it('重复保存同一配置不会报告变化', async () => {
    const manager = new VisionSettingsManager()
    const input = { mode: 'custom' as const, model: 'vision-model', independentCredentials: false }
    expect(await manager.configure(input)).toBe(true)
    expect(await manager.configure(input)).toBe(false)
  })

  it('模型变化和密钥新增或清除会报告变化', async () => {
    const manager = new VisionSettingsManager()
    await manager.configure({ mode: 'custom', model: 'vision-a', independentCredentials: true, apiKey: 'key-a' })
    expect(await manager.configure({ mode: 'custom', model: 'vision-b', independentCredentials: true })).toBe(true)
    expect(await manager.configure({ mode: 'custom', model: 'vision-b', independentCredentials: true, clearApiKey: true })).toBe(true)
  })
})
