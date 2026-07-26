import { describe, expect, it } from 'vitest'
import {
  getLocalEmbeddingModel,
  localEmbeddingModelCatalog,
  validateLocalEmbeddingModelCatalog
} from './embeddingModelCatalog'

describe('本地向量模型白名单', () => {
  it('只暴露经过固定版本和摘要校验的模型', () => {
    expect(localEmbeddingModelCatalog.models.map((model) => model.id)).toEqual([
      'bge-small-zh-v1.5-int8',
      'bge-base-zh-v1.5-int8',
      'multilingual-e5-small-int8',
      'bge-large-zh-v1.5-int8'
    ])
    expect(getLocalEmbeddingModel('multilingual-e5-small-int8')?.runtime.pooling).toBe('mean')
    expect(getLocalEmbeddingModel('unknown-model')).toBeNull()
  })

  it('拒绝下载体积与文件清单不一致的模型', () => {
    const invalid = structuredClone(localEmbeddingModelCatalog) as unknown as {
      models: Array<{ downloadBytes: number }>
    }
    invalid.models[0].downloadBytes += 1

    expect(() => validateLocalEmbeddingModelCatalog(invalid)).toThrow('下载体积不一致')
  })
})
