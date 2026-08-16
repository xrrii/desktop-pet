import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  userDataPath: '',
  available: true
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userDataPath
  },
  safeStorage: {
    isEncryptionAvailable: () => electronState.available,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('encrypted:')) throw new Error('synthetic decrypt failure')
      return text.slice('encrypted:'.length)
    }
  }
}))

import { ElectronManagedTokenStore } from './managedTokenStore'

describe('ElectronManagedTokenStore', () => {
  beforeEach(async () => {
    electronState.userDataPath = await mkdtemp(join(tmpdir(), 'petdock-managed-token-'))
    electronState.available = true
  })

  afterEach(async () => {
    await rm(electronState.userDataPath, { recursive: true, force: true })
  })

  it('使用 safeStorage 密文原子保存并读取 Refresh Token', async () => {
    const store = new ElectronManagedTokenStore()

    await store.save('synthetic-refresh-token')

    await expect(store.load()).resolves.toEqual({
      status: 'available',
      refreshToken: 'synthetic-refresh-token'
    })
    const serialized = await readFile(storePath(), 'utf8')
    expect(serialized).not.toContain('synthetic-refresh-token')
    expect(JSON.parse(serialized)).toMatchObject({ version: 1 })
    expect((await readdir(join(electronState.userDataPath, 'managed')))
      .filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('文件不存在时不要求 safeStorage 可用', async () => {
    electronState.available = false
    const store = new ElectronManagedTokenStore()

    expect(store.isAvailable()).toBe(false)
    await expect(store.load()).resolves.toEqual({ status: 'missing' })
  })

  it('已有密文但 safeStorage 暂不可用时保留文件', async () => {
    const store = new ElectronManagedTokenStore()
    await store.save('synthetic-refresh-token')
    electronState.available = false

    await expect(store.load()).resolves.toEqual({ status: 'unavailable' })
    await expect(readFile(storePath(), 'utf8')).resolves.toBeTruthy()
    await expect(store.save('next-token')).rejects.toMatchObject({
      reason: 'unavailable'
    })
  })

  it('损坏密文不会进入解密结果并会隔离活动文件', async () => {
    await writeManagedDocument({
      version: 1,
      encryptedRefreshToken: Buffer.from('not-encrypted', 'utf8').toString('base64'),
      updatedAt: new Date().toISOString()
    })
    const store = new ElectronManagedTokenStore()

    await expect(store.load()).resolves.toEqual({ status: 'corrupt' })
    await expect(readFile(storePath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(join(electronState.userDataPath, 'managed')))
      .some((name) => name.includes('.corrupt.'))).toBe(true)
  })

  it('清除操作幂等删除活动密文', async () => {
    const store = new ElectronManagedTokenStore()
    await store.save('synthetic-refresh-token')

    await store.clear()
    await store.clear()

    await expect(store.load()).resolves.toEqual({ status: 'missing' })
  })
})

function storePath(): string {
  return join(electronState.userDataPath, 'managed', 'refresh-token.v1.json')
}

/** 写入合成文档，测试损坏和版本校验路径。 */
async function writeManagedDocument(value: unknown): Promise<void> {
  const directory = join(electronState.userDataPath, 'managed')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }))
  await writeFile(storePath(), JSON.stringify(value), 'utf8')
}
