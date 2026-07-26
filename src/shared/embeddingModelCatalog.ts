import rawCatalog from '../../assets/assistant/embedding-model-whitelist.json'

export type LocalEmbeddingTier = 'light' | 'balanced' | 'quality'
export type LocalEmbeddingPooling = 'cls' | 'mean'
export type LocalEmbeddingValidation = 'runtime-smoke-tested' | 'metadata-verified'

export interface LocalEmbeddingDownloadSource {
  id: string
  name: string
  baseUrl: string
  official: boolean
}

export interface LocalEmbeddingModelFile {
  path: string
  target: string
  sizeBytes: number
  sha256: string
}

export interface LocalEmbeddingModel {
  id: string
  displayName: string
  tier: LocalEmbeddingTier
  description: string
  languages: string[]
  recommendedFor: string[]
  license: {
    spdx: string
    url: string
  }
  source: {
    upstreamRepository: string
    upstreamRevision: string
    conversionRepository: string
    conversionRevision: string
  }
  downloadBytes: number
  files: LocalEmbeddingModelFile[]
  runtime: {
    engine: 'onnxruntime'
    precision: 'int8'
    dimensions: number
    maxTokens: number
    pooling: LocalEmbeddingPooling
    normalize: boolean
    queryPrefix: string
    documentPrefix: string
  }
  validation: LocalEmbeddingValidation
}

export interface LocalEmbeddingModelCatalog {
  schemaVersion: 1
  catalogVersion: string
  downloadSources: LocalEmbeddingDownloadSource[]
  models: LocalEmbeddingModel[]
}

/** 校验本地向量模型白名单，避免下载器消费被误改或不完整的模型描述。 */
export function validateLocalEmbeddingModelCatalog(value: unknown): LocalEmbeddingModelCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.catalogVersion !== 'string') {
    throw new Error('本地向量模型白名单版本无效。')
  }
  if (!Array.isArray(value.downloadSources) || value.downloadSources.length === 0) {
    throw new Error('本地向量模型白名单没有可用下载源。')
  }
  value.downloadSources.forEach(validateDownloadSource)
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new Error('本地向量模型白名单为空。')
  }

  const ids = new Set<string>()
  value.models.forEach((model) => {
    validateModel(model)
    if (ids.has(model.id as string)) {
      throw new Error(`本地向量模型 ID 重复：${String(model.id)}`)
    }
    ids.add(model.id as string)
  })
  return value as unknown as LocalEmbeddingModelCatalog
}

/** 根据稳定 ID 获取白名单模型；未知 ID 不允许继续下载。 */
export function getLocalEmbeddingModel(modelId: string): LocalEmbeddingModel | null {
  return localEmbeddingModelCatalog.models.find((model) => model.id === modelId) ?? null
}

function validateDownloadSource(value: unknown): void {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.baseUrl !== 'string' ||
    !value.baseUrl.startsWith('https://') ||
    typeof value.official !== 'boolean'
  ) {
    throw new Error('本地向量模型下载源配置无效。')
  }
}

function validateModel(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-z0-9.-]+$/.test(value.id)) {
    throw new Error('本地向量模型 ID 无效。')
  }
  if (!['light', 'balanced', 'quality'].includes(String(value.tier))) {
    throw new Error(`本地向量模型档位无效：${value.id}`)
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error(`本地向量模型缺少下载文件：${value.id}`)
  }
  value.files.forEach((file) => validateModelFile(file, value.id as string))
  const actualBytes = value.files.reduce(
    (total, file) => total + ((file as LocalEmbeddingModelFile).sizeBytes || 0),
    0
  )
  if (!Number.isSafeInteger(value.downloadBytes) || value.downloadBytes !== actualBytes) {
    throw new Error(`本地向量模型下载体积不一致：${value.id}`)
  }
  if (!isRecord(value.source)) {
    throw new Error(`本地向量模型来源无效：${value.id}`)
  }
  for (const key of ['upstreamRevision', 'conversionRevision']) {
    if (!/^[a-f0-9]{40}$/.test(String(value.source[key]))) {
      throw new Error(`本地向量模型 revision 无效：${value.id}`)
    }
  }
  if (!isRecord(value.runtime)) {
    throw new Error(`本地向量模型运行参数无效：${value.id}`)
  }
  if (
    value.runtime.engine !== 'onnxruntime' ||
    value.runtime.precision !== 'int8' ||
    !Number.isInteger(value.runtime.dimensions) ||
    Number(value.runtime.dimensions) <= 0 ||
    !['cls', 'mean'].includes(String(value.runtime.pooling)) ||
    value.runtime.normalize !== true
  ) {
    throw new Error(`本地向量模型推理配置无效：${value.id}`)
  }
  if (!['runtime-smoke-tested', 'metadata-verified'].includes(String(value.validation))) {
    throw new Error(`本地向量模型验证状态无效：${value.id}`)
  }
}

function validateModelFile(value: unknown, modelId: string): void {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    !value.path ||
    typeof value.target !== 'string' ||
    !/^[a-z0-9._-]+$/.test(value.target) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    Number(value.sizeBytes) <= 0 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw new Error(`本地向量模型文件配置无效：${modelId}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const localEmbeddingModelCatalog = validateLocalEmbeddingModelCatalog(rawCatalog)
