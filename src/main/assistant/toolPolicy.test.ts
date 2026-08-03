import { describe, expect, it } from 'vitest'
import type { ToolCall } from '../../shared/assistant'
import { evaluateToolCall } from './toolPolicy'

describe('联网工具策略', () => {
  it('归一化搜索参数并按安全工具自动执行', () => {
    const result = evaluateToolCall(call('search_web', { query: '  PetDock C3  ', maxResults: 4 }))
    expect(result).toMatchObject({
      toolName: 'search_web',
      action: 'execute',
      risk: 'safe',
      args: { query: 'PetDock C3', maxResults: 4 }
    })
  })

  it('拒绝搜索数量越界和空查询', () => {
    expect(evaluateToolCall(call('search_web', { query: '', maxResults: 5 })).action).toBe('deny')
    expect(evaluateToolCall(call('search_web', { query: '测试', maxResults: 11 })).action).toBe('deny')
  })

  it('只允许静态结构合规的网页读取 URL', () => {
    expect(evaluateToolCall(call('fetch_web_page', { url: 'https://example.com/news' }))).toMatchObject({
      toolName: 'fetch_web_page',
      action: 'execute',
      risk: 'safe'
    })
    expect(evaluateToolCall(call('fetch_web_page', { url: 'http://127.0.0.1/admin' })).action).toBe('deny')
    expect(evaluateToolCall(call('fetch_web_page', { url: 'file:///C:/secret.txt' })).action).toBe('deny')
  })
})

/** 创建 Runtime 风险字段故意错误的调用，确认 Main 会重新计算策略。 */
function call(name: string, args: unknown): ToolCall {
  return { id: 'call-1', name, args, risk: 'confirm', preview: '不可信预览' }
}
