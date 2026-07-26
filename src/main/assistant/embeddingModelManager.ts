import { app, safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type {
  AssistantEmbeddingModelSnapshot,
  AssistantEmbeddingOnlineInput,
  AssistantEmbeddingSnapshot
} from '../../shared/assistant'
import {
  getLocalEmbeddingModel,
  localEmbeddingModelCatalog,
  type LocalEmbeddingModel,
  type LocalEmbeddingModelFile
} from '../../shared/embeddingModelCatalog'
import { logError, logInfo } from '../logger'

type EmbeddingProfile =
  | { provider: 'hash' }
  | { provider: 'local'; modelId: string }
  | {
      provider: 'online'
      baseUrl: string
      model: string
      dimensions: number
    }

interface DownloadState {
  status: 'downloading' | 'paused' | 'error'
  downloadedBytes: number
  totalBytes: number
  error: string | null
  controller: AbortController | null
}

export interface EmbeddingConfigurationBackup {
  profile: EmbeddingProfile
  encryptedApiKey: Buffer | null
}

/** 管理白名单模型下载、完整性校验、激活配置和在线密钥。 */
export class EmbeddingModelManager {
  private readonly downloads = new Map<string, DownloadState>()

  /** 返回 Renderer 可见的脱敏模型状态。 */
  async snapshot(): Promise<AssistantEmbeddingSnapshot> {
    const profile = this.loadProfile()
    const models = await Promise.all(
      localEmbeddingModelCatalog.models.map((model) => this.modelSnapshot(model))
    )
    return {
      provider: profile.provider,
      activeModelId: profile.provider === 'local' ? profile.modelId : null,
      online: profile.provider === 'online'
        ? {
            configured: this.hasOnlineApiKey(),
            baseUrl: profile.baseUrl,
            model: profile.model,
            dimensions: profile.dimensions
          }
        : null,
      models
    }
  }

  /** 下载白名单模型；中断后保留 `.partial` 文件供下次续传。 */
  async download(modelId: string): Promise<void> {
    const model = this.requireModel(modelId)
    if (this.downloads.get(modelId)?.status === 'downloading') {
      throw new Error('该向量模型正在下载。')
    }
    const state: DownloadState = {
      status: 'downloading',
      downloadedBytes: await this.downloadedBytes(model),
      totalBytes: model.downloadBytes,
      error: null,
      controller: new AbortController()
    }
    this.downloads.set(modelId, state)
    try {
      for (const file of model.files) {
        await this.downloadFile(model, file, state)
      }
      await writeFile(
        this.installManifestPath(model),
        JSON.stringify({ modelId: model.id, revision: model.source.conversionRevision }, null, 2),
        'utf8'
      )
      this.downloads.delete(modelId)
      logInfo('embedding model installed', { modelId, bytes: model.downloadBytes })
    } catch (error) {
      if (state.controller?.signal.aborted) {
        state.status = 'paused'
        state.error = null
      } else {
        state.status = 'error'
        state.error = error instanceof Error ? error.message : String(error)
        logError('embedding model download failed', { modelId, error: state.error })
      }
      state.controller = null
      throw error
    }
  }

  /** 暂停正在进行的下载，已完成字节不会被删除。 */
  pause(modelId: string): boolean {
    const state = this.downloads.get(modelId)
    if (!state || state.status !== 'downloading' || !state.controller) {
      return false
    }
    state.controller.abort()
    return true
  }

  /** 切换为 Hash 或已经完整安装的本地模型。 */
  async selectLocal(modelId: string | null): Promise<void> {
    if (modelId === null) {
      await this.saveProfile({ provider: 'hash' })
      return
    }
    const model = this.requireModel(modelId)
    if (!(await this.isInstalled(model))) {
      throw new Error('向量模型尚未完整安装。')
    }
    await this.saveProfile({ provider: 'local', modelId })
  }

  /** 加密保存在线 API Key，并激活在线 Embedding。 */
  async configureOnline(input: AssistantEmbeddingOnlineInput): Promise<void> {
    const baseUrl = validateBaseUrl(input.baseUrl)
    const model = input.model.trim()
    if (!model || model.length > 200 || !Number.isInteger(input.dimensions) || input.dimensions < 64) {
      throw new TypeError('在线向量模型配置无效。')
    }
    if (!input.apiKey.trim()) {
      throw new TypeError('在线向量模型 API Key 不能为空。')
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统无法安全加密 API Key。')
    }
    await mkdir(dirname(this.apiKeyPath()), { recursive: true })
    await writeFile(this.apiKeyPath(), safeStorage.encryptString(input.apiKey.trim()))
    await this.saveProfile({ provider: 'online', baseUrl, model, dimensions: input.dimensions })
  }

  /** 删除未激活模型文件，知识库原文和其他索引不受影响。 */
  async delete(modelId: string): Promise<void> {
    const model = this.requireModel(modelId)
    const profile = this.loadProfile()
    if (profile.provider === 'local' && profile.modelId === modelId) {
      throw new Error('不能删除正在使用的向量模型，请先切换为其他模型。')
    }
    this.pause(modelId)
    await rm(this.modelRoot(model), { recursive: true, force: true })
    this.downloads.delete(modelId)
    logInfo('embedding model deleted', { modelId })
  }

  /** 捕获切换前配置，供 Runtime 健康检查失败时完整回滚。 */
  captureConfiguration(): EmbeddingConfigurationBackup {
    let encryptedApiKey: Buffer | null = null
    try {
      encryptedApiKey = readFileSync(this.apiKeyPath())
    } catch {
      // 尚未配置在线模型时没有密钥文件。
    }
    return { profile: this.loadProfile(), encryptedApiKey }
  }

  /** 恢复 Provider 配置和加密密钥，不接触已下载模型。 */
  async restoreConfiguration(backup: EmbeddingConfigurationBackup): Promise<void> {
    await this.saveProfile(backup.profile)
    if (backup.encryptedApiKey) {
      await writeFile(this.apiKeyPath(), backup.encryptedApiKey)
    } else {
      await rm(this.apiKeyPath(), { force: true })
    }
  }

  /** 构造只交给 Runtime 子进程的环境变量，在线密钥不会进入 Renderer。 */
  runtimeEnvironment(): Record<string, string> {
    const profile = this.loadProfile()
    if (profile.provider === 'hash') {
      return { PETDOCK_EMBEDDING_PROVIDER: 'hash' }
    }
    if (profile.provider === 'local') {
      const model = this.requireModel(profile.modelId)
      return {
        PETDOCK_EMBEDDING_PROVIDER: 'local',
        PETDOCK_EMBEDDING_MODEL_DIR: this.modelRoot(model),
        PETDOCK_EMBEDDING_DESCRIPTOR_JSON: JSON.stringify({
          id: model.id,
          revision: model.source.conversionRevision,
          tokenizerVersion: model.source.conversionRevision,
          chunkStrategyVersion: 'v2',
          ...model.runtime
        })
      }
    }
    const apiKey = this.readOnlineApiKey()
    if (!apiKey) {
      throw new Error('在线向量模型 API Key 不可用。')
    }
    return {
      PETDOCK_EMBEDDING_PROVIDER: 'online',
      PETDOCK_EMBEDDING_API_KEY: apiKey,
      PETDOCK_EMBEDDING_BASE_URL: profile.baseUrl,
      PETDOCK_EMBEDDING_MODEL: profile.model,
      PETDOCK_EMBEDDING_DIMENSIONS: String(profile.dimensions)
    }
  }

  private async modelSnapshot(model: LocalEmbeddingModel): Promise<AssistantEmbeddingModelSnapshot> {
    const state = this.downloads.get(model.id)
    const installed = await this.isInstalled(model)
    return {
      id: model.id,
      displayName: model.displayName,
      tier: model.tier,
      description: model.description,
      downloadBytes: model.downloadBytes,
      status: installed ? 'installed' : state?.status ?? 'not-installed',
      downloadedBytes: installed ? model.downloadBytes : state?.downloadedBytes ?? await this.downloadedBytes(model),
      error: state?.error ?? null
    }
  }

  private async downloadFile(
    model: LocalEmbeddingModel,
    file: LocalEmbeddingModelFile,
    state: DownloadState
  ): Promise<void> {
    const target = join(this.modelRoot(model), file.target)
    const partial = `${target}.partial`
    await mkdir(dirname(target), { recursive: true })
    if (await fileMatches(target, file)) {
      return
    }
    if (await fileMatches(partial, file)) {
      await rm(target, { force: true })
      await rename(partial, target)
      return
    }
    const invalidTargetBytes = await fileSize(target)
    state.downloadedBytes = Math.max(0, state.downloadedBytes - invalidTargetBytes)
    await rm(target, { force: true })

    let lastError: unknown
    for (const source of localEmbeddingModelCatalog.downloadSources) {
      try {
        await this.fetchFile(source.baseUrl, model, file, partial, state)
        if (!(await fileMatches(partial, file))) {
          throw new Error(`文件校验失败：${file.target}`)
        }
        await rename(partial, target)
        return
      } catch (error) {
        if (state.controller?.signal.aborted) {
          throw error
        }
        const partialBytes = await fileSize(partial)
        if (partialBytes >= file.sizeBytes) {
          await rm(partial, { force: true })
          state.downloadedBytes = Math.max(0, state.downloadedBytes - partialBytes)
        }
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`模型文件下载失败：${file.target}`)
  }

  private async fetchFile(
    baseUrl: string,
    model: LocalEmbeddingModel,
    file: LocalEmbeddingModelFile,
    partial: string,
    state: DownloadState
  ): Promise<void> {
    const existing = await fileSize(partial)
    const url = `${baseUrl}/${model.source.conversionRepository}/resolve/${model.source.conversionRevision}/${file.path}`
    const response = await fetch(url, {
      headers: existing > 0 ? { Range: `bytes=${existing}-` } : undefined,
      signal: state.controller?.signal
    })
    if (!response.ok || !response.body) {
      throw new Error(`模型下载失败（HTTP ${response.status}）`)
    }
    const append = existing > 0 && response.status === 206
    if (!append && existing > 0) {
      state.downloadedBytes -= existing
    }
    const output = createWriteStream(partial, { flags: append ? 'a' : 'w' })
    const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>)
    body.on('data', (chunk: Buffer) => {
      state.downloadedBytes += chunk.length
    })
    await pipeline(body, output)
  }

  private requireModel(modelId: string): LocalEmbeddingModel {
    const model = getLocalEmbeddingModel(modelId)
    if (!model) {
      throw new TypeError('向量模型不在白名单中。')
    }
    return model
  }

  private modelRoot(model: LocalEmbeddingModel): string {
    return join(app.getPath('userData'), 'rag', 'models', model.id, model.source.conversionRevision)
  }

  private installManifestPath(model: LocalEmbeddingModel): string {
    return join(this.modelRoot(model), 'installed.json')
  }

  private async isInstalled(model: LocalEmbeddingModel): Promise<boolean> {
    if (!existsSync(this.installManifestPath(model))) {
      return false
    }
    const results = await Promise.all(
      model.files.map((file) => fileMatches(join(this.modelRoot(model), file.target), file, false))
    )
    return results.every(Boolean)
  }

  private async downloadedBytes(model: LocalEmbeddingModel): Promise<number> {
    const sizes = await Promise.all(
      model.files.map(async (file) => {
        const target = join(this.modelRoot(model), file.target)
        return Math.min(file.sizeBytes, Math.max(await fileSize(target), await fileSize(`${target}.partial`)))
      })
    )
    return sizes.reduce((total, value) => total + value, 0)
  }

  private profilePath(): string {
    return join(app.getPath('userData'), 'rag', 'embedding-profile.json')
  }

  private apiKeyPath(): string {
    return join(app.getPath('userData'), 'rag', 'embedding-api-key.bin')
  }

  private loadProfile(): EmbeddingProfile {
    try {
      const value = JSON.parse(readFileSync(this.profilePath(), 'utf8')) as Partial<EmbeddingProfile>
      if (value.provider === 'local' && typeof value.modelId === 'string' && getLocalEmbeddingModel(value.modelId)) {
        return { provider: 'local', modelId: value.modelId }
      }
      if (
        value.provider === 'online' &&
        typeof value.baseUrl === 'string' &&
        typeof value.model === 'string' &&
        Number.isInteger(value.dimensions)
      ) {
        return {
          provider: 'online',
          baseUrl: value.baseUrl,
          model: value.model,
          dimensions: Number(value.dimensions)
        }
      }
    } catch {
      // 首次启动或配置损坏时明确回退到可用的 Hash Provider。
    }
    return { provider: 'hash' }
  }

  private async saveProfile(profile: EmbeddingProfile): Promise<void> {
    await mkdir(dirname(this.profilePath()), { recursive: true })
    await writeFile(this.profilePath(), JSON.stringify(profile, null, 2), 'utf8')
  }

  private hasOnlineApiKey(): boolean {
    return this.readOnlineApiKey() !== null
  }

  private readOnlineApiKey(): string | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return null
      }
      return safeStorage.decryptString(readFileSync(this.apiKeyPath()))
    } catch {
      return null
    }
  }
}

/** 校验在线端点，正式远端必须使用 HTTPS，本机调试允许 HTTP。 */
function validateBaseUrl(value: string): string {
  const parsed = new URL(value.trim())
  const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new TypeError('在线向量模型地址必须使用 HTTPS。')
  }
  return parsed.toString().replace(/\/$/, '')
}

/** 读取文件大小；文件不存在时返回零。 */
async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** 校验模型文件长度，并按需计算 SHA-256。 */
async function fileMatches(
  path: string,
  file: LocalEmbeddingModelFile,
  verifyHash = true
): Promise<boolean> {
  if ((await fileSize(path)) !== file.sizeBytes) {
    return false
  }
  if (!verifyHash) {
    return true
  }
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex') === file.sha256
}
