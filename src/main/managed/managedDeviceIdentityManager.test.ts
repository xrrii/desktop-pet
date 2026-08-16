import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagedDeviceIdentityManager, normalizeManagedDeviceDisplayName } from './managedDeviceIdentityManager'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ManagedDeviceIdentityManager', () => {
  it('同一 issuer 和 subject 跨实例复用稳定 UUID，落盘不包含 subject 原文', async () => {
    const directory = await createTemporaryDirectory()
    const storePath = join(directory, 'device-identities.v1.json')
    const first = new ManagedDeviceIdentityManager(new URL('https://account.petdock.site'), storePath)
    const second = new ManagedDeviceIdentityManager(new URL('https://account.petdock.site'), storePath)

    const deviceId = await first.getOrCreate('opaque-user-subject')

    expect(await second.getOrCreate('opaque-user-subject')).toBe(deviceId)
    expect(await readFile(storePath, 'utf8')).not.toContain('opaque-user-subject')
  })

  it('不同账号使用不同设备 UUID，撤销后生成新 UUID', async () => {
    const directory = await createTemporaryDirectory()
    const manager = new ManagedDeviceIdentityManager(
      new URL('https://account.petdock.site'),
      join(directory, 'device-identities.v1.json')
    )
    const first = await manager.getOrCreate('subject-a')
    const second = await manager.getOrCreate('subject-b')

    await manager.clear('subject-a')

    expect(second).not.toBe(first)
    expect(await manager.getOrCreate('subject-a')).not.toBe(first)
  })

  it('按冻结规则规范化显示名并拒绝控制字符', () => {
    expect(normalizeManagedDeviceDisplayName('  Work\u3000\u3000PC  ')).toBe('Work PC')
    expect(normalizeManagedDeviceDisplayName('Office\nPC')).toBe('Windows Desktop')
    expect(normalizeManagedDeviceDisplayName('')).toBe('Windows Desktop')
  })
})

/** 创建单测专用临时目录并登记回收。 */
async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'petdock-managed-'))
  temporaryDirectories.push(directory)
  return directory
}
