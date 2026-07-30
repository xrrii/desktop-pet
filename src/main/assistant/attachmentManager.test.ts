import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { AssistantAttachmentManager } from './attachmentManager'

const testRoots = new Set<string>()

/** 创建本测试独占的临时目录，并登记到 afterEach 精确清理。 */
function createTestRoot(): string {
  const root = join(process.cwd(), 'temp', `attachment-test-${randomUUID()}`)
  testRoots.add(root)
  return root
}

afterEach(async () => {
  await Promise.all([...testRoots].map((root) => rm(root, { recursive: true, force: true })))
  testRoots.clear()
})

describe('AssistantAttachmentManager', () => {
  it('把支持的 UTF-8 文本复制到随机附件目录', async () => {
    const root = createTestRoot()
    const sourceRoot = join(root, 'source')
    const targetRoot = join(root, 'target')
    await mkdir(sourceRoot, { recursive: true })
    const source = join(sourceRoot, '说明.md')
    await writeFile(source, '# PetDock\n\n附件测试。', 'utf8')

    const [registration] = await new AssistantAttachmentManager(targetRoot).stage([source])

    expect(registration.id).toMatch(/^[a-f0-9]{32}$/)
    expect(registration.name).toBe('说明.md')
    expect(await readFile(join(targetRoot, registration.relativePath), 'utf8')).toContain('附件测试')
  })

  it('拒绝目录、不支持格式和重复路径', async () => {
    const root = createTestRoot()
    const targetRoot = join(root, 'target')
    await mkdir(root, { recursive: true })
    const binary = join(root, 'payload.exe')
    await writeFile(binary, 'not executable', 'utf8')
    const manager = new AssistantAttachmentManager(targetRoot)

    await expect(manager.stage([root])).rejects.toThrow('普通文件')
    await expect(manager.stage([binary])).rejects.toThrow('暂不支持')
    await expect(manager.stage([binary, binary])).rejects.toThrow('重复文件')
  })

  it.runIf(process.platform === 'win32')('拒绝符号链接来源', async () => {
    const root = createTestRoot()
    await mkdir(root, { recursive: true })
    const source = join(root, 'source.txt')
    const link = join(root, 'link.txt')
    await writeFile(source, 'content', 'utf8')
    try {
      await symlink(source, link, 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return
      }
      throw error
    }

    await expect(new AssistantAttachmentManager(join(root, 'target')).stage([link])).rejects.toThrow('符号链接')
  })
})
