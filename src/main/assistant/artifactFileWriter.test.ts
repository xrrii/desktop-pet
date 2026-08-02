import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeArtifactAtomically } from './artifactFileWriter'

const testRoots = new Set<string>()

/** 创建测试独占目录，避免并行用例互相覆盖。 */
async function createTestRoot(): Promise<string> {
  const root = join(process.cwd(), 'temp', `artifact-save-test-${randomUUID()}`)
  testRoots.add(root)
  await mkdir(root, { recursive: true })
  return root
}

afterEach(async () => {
  await Promise.all([...testRoots].map((root) => rm(root, { recursive: true, force: true })))
  testRoots.clear()
})

describe('writeArtifactAtomically', () => {
  it('创建新文件并安全覆盖已有普通文件', async () => {
    const root = await createTestRoot()
    const target = join(root, 'report.md')

    const first = await writeArtifactAtomically(target, new TextEncoder().encode('第一版'))
    const second = await writeArtifactAtomically(target, new TextEncoder().encode('第二版'))

    expect(first.overwritten).toBe(false)
    expect(second.overwritten).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('第二版')
  })

  it('覆盖替换失败时保留原文件并清理临时文件', async () => {
    const root = await createTestRoot()
    const target = join(root, 'report.md')
    await writeFile(target, '原始内容', 'utf8')
    const replacementFailure = Object.assign(new Error('模拟替换失败'), { code: 'EACCES' })

    await expect(
      writeArtifactAtomically(target, new TextEncoder().encode('覆盖内容'), {
        rename: async () => {
          throw replacementFailure
        }
      })
    ).rejects.toBe(replacementFailure)

    expect(await readFile(target, 'utf8')).toBe('原始内容')
    expect(await readdir(root)).toEqual(['report.md'])
  })

  it('替换成功后清理异常不误报保存失败且不留下备份', async () => {
    const root = await createTestRoot()
    const target = join(root, 'report.md')
    await writeFile(target, '原始内容', 'utf8')
    const failingCleanup = vi.fn(async () => {
      throw new Error('模拟清理失败')
    })

    await expect(
      writeArtifactAtomically(target, new TextEncoder().encode('覆盖内容'), {
        rm: failingCleanup
      })
    ).resolves.toEqual({ overwritten: true })

    expect(failingCleanup).toHaveBeenCalledOnce()
    expect(await readFile(target, 'utf8')).toBe('覆盖内容')
    expect(await readdir(root)).toEqual(['report.md'])
  })

  it.runIf(process.platform === 'win32')('拒绝把符号链接作为覆盖目标', async () => {
    const root = await createTestRoot()
    const source = join(root, 'source.txt')
    const link = join(root, 'link.txt')
    await writeFile(source, '原始内容', 'utf8')
    try {
      await symlink(source, link, 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }

    await expect(
      writeArtifactAtomically(link, new TextEncoder().encode('覆盖内容'))
    ).rejects.toThrow('普通文件')
    expect(await readFile(source, 'utf8')).toBe('原始内容')
  })
})
