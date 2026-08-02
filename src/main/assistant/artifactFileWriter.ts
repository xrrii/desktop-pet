import { randomUUID } from 'node:crypto'
import { lstat, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

type ArtifactFileWriterOperations = {
  lstat: typeof lstat
  rename: typeof rename
  rm: typeof rm
  writeFile: typeof writeFile
}

const defaultOperations: ArtifactFileWriterOperations = { lstat, rename, rm, writeFile }

/**
 * 将 Artifact 写入同目录临时文件后原子替换目标。
 * 直接替换而不先移走旧文件，确保替换失败时原目标仍留在原路径。
 * 调用方必须保证 targetPath 来自 Electron 原生保存对话框。
 */
export async function writeArtifactAtomically(
  targetPath: string,
  content: Uint8Array,
  operationOverrides: Partial<ArtifactFileWriterOperations> = {}
): Promise<{ overwritten: boolean }> {
  const operations = { ...defaultOperations, ...operationOverrides }
  const directory = dirname(targetPath)
  const safeBase = basename(targetPath).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'artifact'
  const nonce = randomUUID()
  const temporaryPath = join(directory, `.${safeBase}.${nonce}.petdock.tmp`)
  let existing = false

  try {
    try {
      const stat = await operations.lstat(targetPath)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('保存目标必须是普通文件。')
      }
      existing = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    await operations.writeFile(temporaryPath, content, { flag: 'wx', mode: 0o600 })
    await operations.rename(temporaryPath, targetPath)
    return { overwritten: existing }
  } finally {
    await operations.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}
