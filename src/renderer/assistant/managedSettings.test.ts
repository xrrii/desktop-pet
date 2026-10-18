// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ManagedAuthStatus, ManagedUsageSummaryResult } from '../../shared/managed'
import { initializeAssistant } from './main'

const html = readFileSync(resolve('src/renderer/index.html'), 'utf8')
let windowEvents: MockInstance<typeof window.addEventListener>
let documentEvents: MockInstance<typeof document.addEventListener>

beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
  windowEvents = vi.spyOn(window, 'addEventListener')
  documentEvents = vi.spyOn(document, 'addEventListener')
})

afterEach(() => {
  for (const args of windowEvents.mock.calls) window.removeEventListener(...args)
  for (const args of documentEvents.mock.calls) document.removeEventListener(...args)
  vi.restoreAllMocks()
})

/** 构造不含真实账号或凭据的脱敏状态。 */
function authStatus(next: Partial<ManagedAuthStatus> = {}): ManagedAuthStatus {
  return {
    state: 'idle', managedLoginEnabled: true, managedChatEnabled: true,
    managedEmbeddingEnabled: true, managedVisionEnabled: true, managedWebSearchEnabled: true,
    managedRerankEnabled: true, managedServiceSelected: true, managedSubscriptionActive: null,
    minimumClientVersion: null, errorCode: null, sessionSyncState: 'idle',
    runtimeSessionState: 'idle', runtimeSessionErrorCode: null, account: null, device: null,
    ...next
  }
}

/** 生成可由测试主动完成或失败的在途请求，避免依赖真实浏览器和网络。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** 在实际页面和初始化函数上注入 IPC 替身，保留真实点击、渲染及并发状态。 */
async function page(initial = authStatus()) {
  let status = initial
  let notify!: (value: ManagedAuthStatus) => void
  const usage = vi.fn<() => Promise<ManagedUsageSummaryResult>>().mockResolvedValue(null)
  const login = vi.fn<() => Promise<ManagedAuthStatus>>().mockResolvedValue(status)
  const cancel = vi.fn<() => Promise<ManagedAuthStatus>>().mockResolvedValue(authStatus({ state: 'cancelled' }))
  const methods: Record<string, unknown> = {
    getManagedAuthStatus: async () => status,
    refreshManagedFeatures: async () => status,
    onManagedAuthStatus: (listener: typeof notify) => { notify = listener },
    getManagedUsageSummary: usage, loginManaged: login, cancelManagedLogin: cancel,
    getAssistantModelSettings: async () => ({ configuredKey: false, baseUrl: '', model: 'synthetic-model' }),
    getAssistantCapabilitySettings: async () => ({ capabilities: Object.fromEntries(
      ['chat', 'embedding', 'vision', 'web_search', 'rerank'].map((name) => [name, {
        selectedSource: 'managed', effectiveSource: 'managed', status: 'available'
      }])
    ) }),
    getAssistantLayout: async () => ({
      expanded: false, revision: 1, side: 'left', pet: { x: 0, y: 0 },
      panel: { x: 0, y: 0, width: 400, height: 600 }
    }),
    getAssistantStatus: async () => ({ state: 'stopped' }),
    getAssistantKnowledge: async () => ({ libraries: [] }),
    getAssistantEmbeddingModels: async () => ({ models: [] }),
    getAssistantSkills: async () => ({ skills: [] }),
    getAssistantWebSettings: async () => ({}),
    getSettings: async () => ({ petId: 'synthetic-pet', assistantKnowledgeLibraryIds: [] })
  }
  window.desktopPet = new Proxy(methods, {
    get: (target, name: string) => target[name] ?? (() => undefined)
  }) as unknown as typeof window.desktopPet
  initializeAssistant()
  button('#settings-button').click()
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#settings-view')!.hidden).toBe(false))
  await vi.waitFor(() => expect(button('#managed-usage-refresh').getAttribute('aria-busy')).toBe('false'))
  return {
    usage, login, cancel,
    emit: (value: ManagedAuthStatus) => { status = value; notify(value) }
  }
}

/** 通过实际按钮触发事件，不绕过 disabled 状态。 */
function button(selector: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(selector)
  if (!element) throw new Error(`缺少页面按钮：${selector}`)
  return element
}

/** 读取用户可见状态，验证不会残留上一账号或请求的反馈。 */
function text(selector: string): string {
  return document.querySelector(selector)?.textContent ?? ''
}

describe('官方登录与能力刷新交互', () => {
  it('浏览器一直未回调时可取消，取消后能再次点击登录', async () => {
    const ui = await page()
    const pending = deferred<ManagedAuthStatus>()
    ui.login.mockReturnValueOnce(pending.promise)
    button('#managed-login').click()
    ui.emit(authStatus({ state: 'waiting_callback' }))
    expect(button('#managed-cancel-login').hidden).toBe(false)
    expect(button('#managed-cancel-login').disabled).toBe(false)
    ui.cancel.mockImplementationOnce(async () => {
      const cancelled = authStatus({ state: 'cancelled', errorCode: 'oauth_cancelled' })
      pending.resolve(cancelled)
      return cancelled
    })
    button('#managed-cancel-login').click()
    await vi.waitFor(() => expect(button('#managed-login').hidden || button('#managed-login').disabled).toBe(false))
    expect(text('#managed-account-status')).toContain('已取消')
    button('#managed-login').click()
    expect(ui.login).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(button('#managed-login').disabled).toBe(false))
  })

  it.each(['cancelled', 'timed_out', 'failed', 'offline'] as const)('%s 终态仍可重新登录', async (state) => {
    await page(authStatus({ state }))
    expect(button('#managed-login').hidden).toBe(false)
    expect(button('#managed-login').disabled).toBe(false)
  })

  it('无套餐也允许刷新，显示在途反馈且成功后解除禁用', async () => {
    const ui = await page(authStatus({ state: 'authenticated', sessionSyncState: 'ready', managedSubscriptionActive: false }))
    const pending = deferred<ManagedUsageSummaryResult>()
    ui.usage.mockClear().mockReturnValueOnce(pending.promise)
    expect(button('#managed-usage-refresh').disabled).toBe(false)
    button('#managed-usage-refresh').click()
    expect(button('#managed-usage-refresh').disabled).toBe(true)
    expect(button('#managed-usage-refresh').getAttribute('aria-busy')).toBe('true')
    expect(text('#managed-usage-refresh')).toContain('刷新中')
    button('#managed-usage-refresh').click()
    expect(ui.usage).toHaveBeenCalledOnce()
    pending.resolve(null)
    await vi.waitFor(() => expect(button('#managed-usage-refresh').disabled).toBe(false))
    expect(text('#managed-usage-status')).toContain('已刷新')
  })

  it('有额度时刷新后显示新数值、完成时间，成功后可再次点击', async () => {
    const ui = await page(authStatus({ state: 'authenticated', sessionSyncState: 'ready' }))
    ui.usage.mockResolvedValueOnce({
      billingMode: 'subscription', periodStart: '2030-01-01T00:00:00Z', periodEnd: '2030-02-01T00:00:00Z',
      capabilities: { chat: { quotaMode: 'quota', remaining: 12345, used: 7, unit: 'tokens' } }
    })
    button('#managed-usage-refresh').click()
    await vi.waitFor(() => expect(text('#managed-usage-chat')).toContain('12,345'))
    expect(text('#managed-usage-status')).toMatch(/已刷新 \d+:\d+:\d+/)
    expect(button('#managed-usage-refresh').disabled).toBe(false)
  })

  it('刷新失败后可重试，登出后迟到的旧请求不覆盖空状态', async () => {
    const ui = await page(authStatus({ state: 'authenticated', sessionSyncState: 'ready' }))
    ui.usage.mockRejectedValueOnce(new Error('合成网络错误'))
    button('#managed-usage-refresh').click()
    await vi.waitFor(() => expect(text('#managed-usage-status')).toContain('暂时无法'))
    expect(button('#managed-usage-refresh').disabled).toBe(false)
    const pending = deferred<ManagedUsageSummaryResult>()
    ui.usage.mockReturnValueOnce(pending.promise)
    button('#managed-usage-refresh').click()
    ui.emit(authStatus())
    pending.resolve(null)
    await vi.waitFor(() => expect(button('#managed-usage-refresh').getAttribute('aria-busy')).toBe('false'))
    expect(text('#managed-usage-status')).toBe('登录后可查看额度。')
    expect(button('#managed-usage-refresh').disabled).toBe(true)
  })
})
