import { describe, expect, it } from 'vitest'
import type { AssistantKnowledgeLibrary } from '../../shared/assistant'
import { knowledgeIndexAction, knowledgeIndexNotice, knowledgeStatusText } from './knowledgeStatus'

/** 构造一个任务完成但仅有部分语义索引的合成知识库。 */
function library(): AssistantKnowledgeLibrary {
  return {
    id: 'test-library', name: '合成资料', displayPath: '.../notes', status: 'ready',
    documentCount: 10, chunkCount: 100, processedFiles: 10, totalFiles: 10,
    error: null, createdAt: '', updatedAt: '', lastIndexedAt: null,
    embeddingIndex: {
      mode: 'semantic', totalDocuments: 10, readyDocuments: 3, fallbackDocuments: 7,
      pendingDocuments: 0, requiresRebuild: true, lastFailureCode: 'managed_quota_exhausted'
    }
  }
}

describe('知识库索引状态', () => {
  it('任务就绪但语义未完成时显示原因、覆盖情况和补建操作', () => {
    const item = library()
    expect(knowledgeStatusText(item)).toContain('语义索引待补建')
    expect(knowledgeIndexNotice(item)).toContain('3/10')
    expect(knowledgeIndexNotice(item)).toContain('7 个文档仍使用本地检索')
    expect(knowledgeIndexNotice(item)).toContain('建库请求额度不足')
    expect(knowledgeIndexAction(item)).toBe('补建语义索引')
  })

  it('历史原因未知或会话失效时不误报额度不足', () => {
    const item = library()
    item.embeddingIndex!.lastFailureCode = null
    expect(knowledgeIndexNotice(item)).not.toContain('额度不足')
    item.embeddingIndex!.lastFailureCode = 'managed_authentication_required'
    expect(knowledgeIndexNotice(item)).toContain('会话认证被拒绝')
    expect(knowledgeIndexNotice(item)).toContain('自动刷新官方会话')
    expect(knowledgeIndexNotice(item)).not.toContain('重开应用')
    expect(knowledgeIndexNotice(item)).not.toContain('额度不足')
  })

  it('补建期间展示进度和暂停操作', () => {
    const item = library()
    item.status = 'indexing'
    expect(knowledgeIndexNotice(item)).toContain('正在建立语义索引')
    expect(knowledgeIndexNotice(item)).not.toContain('点击')
    expect(knowledgeIndexAction(item)).toBe('暂停索引')
  })

  it('完整语义索引和主动使用本地检索时不告警', () => {
    const item = library()
    item.embeddingIndex!.requiresRebuild = false
    expect(knowledgeIndexNotice(item)).toBeNull()
    expect(knowledgeStatusText(item)).toContain('语义索引完整')
    expect(knowledgeIndexAction(item)).toBe('刷新索引')
    item.embeddingIndex!.mode = 'hash'
    expect(knowledgeIndexNotice(item)).toBeNull()
    expect(knowledgeStatusText(item)).toContain('本地检索')
  })

  it('兼容旧 Runtime，缺失覆盖数据不声称语义索引完整', () => {
    const item = library()
    delete item.embeddingIndex
    expect(knowledgeStatusText(item)).not.toContain('语义索引完整')
    expect(knowledgeIndexNotice(item)).toBeNull()
  })
})
