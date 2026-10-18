import type { AssistantKnowledgeLibrary } from '../../shared/assistant'

/** 显示索引任务状态，并明确区分可检索与语义索引完整。 */
export function knowledgeStatusText(library: AssistantKnowledgeLibrary): string {
  switch (library.status) {
    case 'indexing':
      return `正在索引 ${library.processedFiles}/${library.totalFiles}`
    case 'paused':
      return `已暂停 · ${library.documentCount} 个文档`
    case 'ready': {
      const index = library.embeddingIndex
      const quality = !index ? '' : index.totalDocuments === 0 ? ' · 尚无索引文档' : index.mode === 'hash' ? ' · 本地检索'
        : index.requiresRebuild ? ' · 语义索引待补建' : ' · 语义索引完整'
      return `${library.documentCount} 个文档 · ${library.chunkCount} 个片段${quality}`
    }
    case 'error':
      return '索引失败'
    default:
      return '等待索引'
  }
}

/** 根据持久化覆盖率解释降级原因；旧记录无原因时不猜测额度不足。 */
export function knowledgeIndexNotice(library: AssistantKnowledgeLibrary): string | null {
  const index = library.embeddingIndex
  if (!index || index.mode !== 'semantic' || !index.requiresRebuild) return null
  const coverage = `语义索引已完成 ${index.readyDocuments}/${index.totalDocuments} 个文档。`
  if (library.status === 'indexing') {
    return `${coverage}正在建立语义索引，未完成的内容暂用本地检索。`
  }
  const reasons: Record<string, string> = {
    managed_quota_exhausted: '最近一次建库请求额度不足。',
    managed_authentication_required: '最近一次建库会话认证被拒绝；点击“补建语义索引”会自动刷新官方会话，仍失败时请检查登录状态。',
    managed_capability_not_entitled: '最近一次建库未获得向量能力授权。',
    embedding_provider_timeout: '最近一次建库向量服务超时。',
    embedding_provider_unavailable: '最近一次建库向量服务不可用。',
    embedding_provider_invalid_response: '最近一次建库向量服务返回异常。',
    embedding_provider_invalid_input: '最近一次建库输入未通过向量服务校验。'
  }
  const reason = index.lastFailureCode ? reasons[index.lastFailureCode] ?? '' : ''
  const fallback = index.fallbackDocuments > 0 ? `${index.fallbackDocuments} 个文档仍使用本地检索。` : ''
  return `${coverage}${fallback}${reason}条件恢复后点击“补建语义索引”，已完成且未变化的文档会复用。`
}

/** 把暂停、补建和普通增量刷新显示为明确的操作。 */
export function knowledgeIndexAction(library: AssistantKnowledgeLibrary): string {
  if (library.status === 'indexing') return '暂停索引'
  if (library.embeddingIndex?.requiresRebuild) return '补建语义索引'
  return library.status === 'ready' ? '刷新索引' : '继续索引'
}
