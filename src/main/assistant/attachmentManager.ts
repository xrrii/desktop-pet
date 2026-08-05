import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'

import type { AssistantAttachmentSummary } from '../../shared/assistant'

const MAX_ATTACHMENT_COUNT = 10
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENT_BATCH_BYTES = 30 * 1024 * 1024

const SUPPORTED_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml',
  '.toml', '.ini', '.conf', '.cfg', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.py', '.pyi', '.java',
  '.kt', '.kts', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift', '.dart',
  '.rb', '.php', '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.properties',
  '.gradle', '.dockerfile', '.pdf', '.docx', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.bmp', '.tif', '.tiff'
])

const SUPPORTED_EXTENSIONLESS_NAMES = new Set([
  'dockerfile', 'makefile', 'readme', 'license', 'notice'
])

export interface AssistantAttachmentRegistration {
  id: string
  name: string
  relativePath: string
  sizeBytes: number
}

/**
 * 把用户明确选择的文件复制到应用受控目录，Runtime 只接收相对路径和附件 ID。
 */
export class AssistantAttachmentManager {
  constructor(private readonly root: string) {}

  /** 校验并暂存一批文件；任一文件失败时回滚本批次创建的全部目录。 */
  async stage(paths: string[]): Promise<AssistantAttachmentRegistration[]> {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_ATTACHMENT_COUNT) {
      throw new TypeError(`一次最多添加 ${MAX_ATTACHMENT_COUNT} 个附件。`)
    }
    const uniquePaths = [...new Set(paths)]
    if (uniquePaths.length !== paths.length) {
      throw new TypeError('同一批附件不能包含重复文件。')
    }

    await mkdir(this.root, { recursive: true })
    const registrations: AssistantAttachmentRegistration[] = []
    const createdIds: string[] = []
    let totalBytes = 0

    try {
      for (const path of paths) {
        if (typeof path !== 'string' || path.length < 1 || path.length > 32_768) {
          throw new TypeError('附件路径无效。')
        }
        const sourceInfo = await lstat(path)
        if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
          throw new TypeError('只能添加普通文件，暂不支持目录或符号链接。')
        }
        const source = await realpath(path)
        const sourceStat = await stat(source)
        if (!sourceStat.isFile()) {
          throw new TypeError('只能添加普通文件。')
        }
        if (sourceStat.size < 1 || sourceStat.size > MAX_ATTACHMENT_BYTES) {
          throw new TypeError('单个附件必须大于 0 字节且不超过 10 MB。')
        }
        totalBytes += sourceStat.size
        if (totalBytes > MAX_ATTACHMENT_BATCH_BYTES) {
          throw new TypeError('单批附件总大小不能超过 30 MB。')
        }

        const name = basename(source)
        validateAttachmentName(name)
        const extension = extname(name).toLowerCase()
        if (!isSupportedTextFile(name, extension)) {
          throw new TypeError(`暂不支持该附件类型：${extension || name}`)
        }

        const id = randomBytes(16).toString('hex')
        const directory = join(this.root, id)
        const targetName = `source${extension}`
        const target = join(directory, targetName)
        await mkdir(directory, { recursive: false })
        createdIds.push(id)
        await copyFile(source, target, constants.COPYFILE_EXCL)
        const copied = await stat(target)
        if (!copied.isFile() || copied.size !== sourceStat.size) {
          throw new Error('附件复制校验失败。')
        }
        registrations.push({
          id,
          name,
          relativePath: relative(this.root, target),
          sizeBytes: copied.size
        })
      }
      return registrations
    } catch (error) {
      await Promise.allSettled(createdIds.map((id) => rm(join(this.root, id), { recursive: true, force: true })))
      throw error
    }
  }

  /** Runtime 登记失败时删除尚未绑定会话的受控副本。 */
  async rollback(registrations: AssistantAttachmentRegistration[]): Promise<void> {
    await Promise.allSettled(
      registrations.map((item) => rm(join(this.root, item.id), { recursive: true, force: true }))
    )
  }
}

/** 只允许安全文件名和首版明确支持的 UTF-8 文本格式。 */
function validateAttachmentName(name: string): void {
  if (!name || name.length > 255 || /[\u0000-\u001f]/.test(name)) {
    throw new TypeError('附件文件名无效。')
  }
}

/** 判断显示文件名是否属于 C1 明确支持的文本格式。 */
function isSupportedTextFile(name: string, extension: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extension) || SUPPORTED_EXTENSIONLESS_NAMES.has(name.toLowerCase())
}

/** 供 Main 校验 Runtime 返回对象时复用的窄类型守卫。 */
export function isAttachmentSummary(value: unknown): value is AssistantAttachmentSummary {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Partial<AssistantAttachmentSummary>
  return (
    typeof item.id === 'string' && /^[a-f0-9]{32}$/.test(item.id) &&
    typeof item.name === 'string' &&
    typeof item.extension === 'string' &&
    typeof item.detectedMime === 'string' &&
    typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes) &&
    (item.status === 'staging' || item.status === 'parsing' || item.status === 'ready' || item.status === 'error') &&
    (item.conversationId === null || typeof item.conversationId === 'string') &&
    (item.parserId === null || typeof item.parserId === 'string') &&
    (item.warning === null || typeof item.warning === 'string') &&
    (item.error === null || typeof item.error === 'string')
  )
}
