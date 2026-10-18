import { describe, expect, it, vi } from 'vitest'
import { AssistantManager } from './assistantManager'
import { ManagedControlPlaneError } from '../managed/managedControlPlaneClient'

vi.mock('electron', () => ({ app: {} }))
vi.mock('../logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const LIBRARY_ID = 'a1111111111111111111111111111111'

/** 跳过磁盘配置与原生窗口构造，保留真实 Manager 入口和会话准备逻辑。 */
function harness(source = 'managed', refresh: () => Promise<void> = vi.fn(async () => undefined)) {
  const client = {
    addKnowledgeLibrary: vi.fn().mockResolvedValue({ id: LIBRARY_ID }),
    startKnowledgeIndex: vi.fn().mockResolvedValue(true)
  }
  const start = vi.fn().mockResolvedValue(client)
  const manager: AssistantManager = Object.assign(Object.create(AssistantManager.prototype), {
    runtime: { start },
    capabilitySettings: { snapshot: () => ({ capabilities: { embedding: { effectiveSource: source } } }) },
    refreshManagedKnowledgeSession: refresh
  })
  return { manager, client, start, refresh }
}

describe('知识库索引官方会话准备', () => {
  it.each(['add', 'retry'])('首次添加和手动补建都等待刷新完成后才启动：%s', async (action) => {
    let release!: () => void
    const refresh = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const { manager, client, start } = harness('managed', refresh)
    const operation = action === 'add'
      ? manager.addKnowledgeLibrary('合成资料', 'synthetic-source')
      : manager.startKnowledgeIndex(LIBRARY_ID)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(start).toHaveBeenCalledOnce()
    expect(client.addKnowledgeLibrary).not.toHaveBeenCalled()
    expect(client.startKnowledgeIndex).not.toHaveBeenCalled()
    release()
    await operation
    expect(action === 'add' ? client.addKnowledgeLibrary : client.startKnowledgeIndex).toHaveBeenCalledOnce()
  })

  it.each(['local', 'byok'])('本地和自备服务建库无需官方认证：%s', async (source) => {
    const { manager, client, refresh } = harness(source)
    await manager.startKnowledgeIndex(LIBRARY_ID)
    expect(refresh).not.toHaveBeenCalled()
    expect(client.startKnowledgeIndex).toHaveBeenCalledOnce()
  })

  it.each([
    ['authentication_required', '检查登录状态'],
    ['network_error', '稍后重试'],
    ['capability_not_entitled', '向量能力授权']
  ] as const)('刷新失败不启动索引，并区分登录、网络和授权：%s', async (code, message) => {
    const refresh = vi.fn().mockRejectedValue(new ManagedControlPlaneError(401, code, false))
    const { manager, client } = harness('managed', refresh)
    await expect(manager.startKnowledgeIndex(LIBRARY_ID)).rejects.toThrow(message)
    await expect(manager.addKnowledgeLibrary('合成资料', 'synthetic-source')).rejects.toThrow(message)
    expect(client.startKnowledgeIndex).not.toHaveBeenCalled()
    expect(client.addKnowledgeLibrary).not.toHaveBeenCalled()
  })
})
