import { createPublicKey } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createReleaseDesktopUpdater } from './electronDesktopUpdater'
import { DESKTOP_UPDATE_TRUST } from './signedUpdateManifest'
import { DESKTOP_UPDATE_RELEASE } from './updatePolicy'

// 只替换安装引擎边界；正式源、公钥和传输校验仍使用实际应用配置。
vi.mock('./confirmedNsisUpdater', () => ({
  ConfirmedNsisUpdater: class {
    setTransport = vi.fn()
    setLaunchLogger = vi.fn()
    setFeedURL = vi.fn()
    on = vi.fn()
  }
}))

describe('引导版正式更新装配', () => {
  it('NSIS 与 Portable 可创建正式更新器，开发态和解包态仍关闭', () => {
    const log = vi.fn()
    const updater = createReleaseDesktopUpdater('nsis', log)
    expect(updater).not.toBeNull()
    expect(Reflect.get(updater!, 'engine').setLaunchLogger).toHaveBeenCalledWith(log)
    expect(createReleaseDesktopUpdater('portable')).not.toBeNull()
    for (const kind of ['development', 'unpacked', 'unsupported'] as const) {
      expect(createReleaseDesktopUpdater(kind)).toBeNull()
    }
  })

  it('发布公钥是独立的 Ed25519 公钥，信任表不能被运行时修改', () => {
    const keys = Object.values(DESKTOP_UPDATE_TRUST.keys)
    expect(keys).not.toHaveLength(0)
    for (const pem of keys) {
      expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----/)
      expect(pem).not.toContain('PRIVATE KEY')
      expect(createPublicKey(pem).asymmetricKeyType).toBe('ed25519')
    }
    expect(Object.isFrozen(DESKTOP_UPDATE_TRUST.keys)).toBe(true)
    expect(Object.isFrozen(DESKTOP_UPDATE_TRUST.revokedKeyIds)).toBe(true)
    expect(Object.isFrozen(DESKTOP_UPDATE_RELEASE)).toBe(true)
  })
})
