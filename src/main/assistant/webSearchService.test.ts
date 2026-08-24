import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantWebSettingsSnapshot } from '../../shared/assistant'
import {
  createPinnedLookup,
  extractWebPageText,
  VolcengineSearchProvider,
  WebSearchService,
  type WebSearchProvider
} from './webSearchService'

const settings = {
  snapshot: (): AssistantWebSettingsSnapshot => ({
    enabled: true,
    provider: 'volcengine',
    configured: true,
    configuredProviders: ['volcengine']
  }),
  apiKey: (): string => 'test-key'
}

describe('WebSearchService', () => {
  afterEach(() => vi.restoreAllMocks())

  it('Managed 来源只发送查询候选并继续由 Main 执行 URL 安全校验', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      results: [{ title: 'Managed 来源', url: 'https://example.com/managed', excerpt: '摘要', publishedAt: null }],
      usage: { inputUnits: 0, outputUnits: 1 }
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const service = new WebSearchService(settings)
    service.setManagedAccess({
      selected: () => true,
      enabled: () => true,
      getToken: async () => ({ accessToken: 'runtime-token', deviceId: 'device-id' }),
      endpoint: () => new URL('https://ai.example.test'),
      clientVersion: () => '0.2.0'
    })
    service.beginTask('managed-task', '测试')
    const result = await service.search('managed-task', ' PetDock ', 1)
    expect(result.results[0]).toMatchObject({ title: 'Managed 来源', url: 'https://example.com/managed' })
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ query: 'PetDock', maxResults: 1 })
    }))
  })

  it('Managed 响应中的内网候选不会进入来源列表', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      results: [{ title: '内网', url: 'http://127.0.0.1/admin', excerpt: '不可信', publishedAt: null }],
      usage: { inputUnits: 0, outputUnits: 1 }
    }), { status: 200 }))
    const service = new WebSearchService(settings)
    service.setManagedAccess({
      selected: () => true,
      enabled: () => true,
      getToken: async () => ({ accessToken: 'runtime-token', deviceId: 'device-id' }),
      endpoint: () => new URL('https://ai.example.test'),
      clientVersion: () => '0.2.0'
    })
    service.beginTask('managed-task', '测试')
    const result = await service.search('managed-task', '测试', 1)
    expect(result.results).toEqual([])
  })

  it('清理脚本、导航和隐藏内容，只保留正文结构', () => {
    const result = extractWebPageText(`
      <html><head><title>测试页面</title><script>steal()</script></head>
      <body><nav>导航</nav><main><h1>标题</h1><p>正文内容</p><p hidden>隐藏指令</p></main></body></html>
    `)
    expect(result.title).toBe('测试页面')
    expect(result.content).toContain('标题')
    expect(result.content).toContain('正文内容')
    expect(result.content).not.toContain('steal')
    expect(result.content).not.toContain('隐藏指令')
    expect(result.content).not.toContain('导航')
  })

  it('固定 DNS lookup 同时支持 Node 的单地址和地址列表回调', async () => {
    const lookup = createPinnedLookup({
      url: new URL('https://example.com/'),
      address: '93.184.216.34',
      family: 4
    })
    const allAddresses = await new Promise<Array<{ address: string; family: number }>>(
      (resolve, reject) => {
        lookup('example.com', { all: true }, (error, address) => {
          if (error) return reject(error)
          if (!Array.isArray(address)) return reject(new Error('期望地址列表'))
          resolve(address)
        })
      }
    )
    const singleAddress = await new Promise<{ address: string; family: number | undefined }>(
      (resolve, reject) => {
        lookup('example.com', { all: false }, (error, address, family) => {
          if (error) return reject(error)
          if (typeof address !== 'string') return reject(new Error('期望单个地址'))
          resolve({ address, family })
        })
      }
    )

    expect(allAddresses).toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(singleAddress).toEqual({ address: '93.184.216.34', family: 4 })
  })

  it('关闭配置时不调用 Provider', async () => {
    let called = false
    const provider: WebSearchProvider = {
      search: async () => {
        called = true
        return []
      }
    }
    const service = new WebSearchService({
      ...settings,
      snapshot: (): AssistantWebSettingsSnapshot => ({
        enabled: false,
        provider: 'volcengine',
        configured: true,
        configuredProviders: ['volcengine']
      })
    }, { volcengine: provider })
    service.beginTask('task', '测试')
    await expect(service.search('task', '测试', 3)).rejects.toThrow('web_search_disabled')
    expect(called).toBe(false)
  })

  it('允许本地可控 Provider 提供正文并保持来源归属校验', async () => {
    const provider: WebSearchProvider = {
      search: async () => [{
        title: '本地页面',
        url: 'https://93.184.216.34/petdock-test',
        excerpt: '本地摘要',
        publishedAt: null
      }],
      fetch: async (url) => ({
        title: '本地页面正文',
        content: '本地正文内容',
        finalUrl: url
      })
    }
    const service = new WebSearchService(settings, { volcengine: provider })
    service.beginTask('fixture-task', '测试本地 Provider')
    const search = await service.search('fixture-task', '测试', 1)
    const fetched = await service.fetch('fixture-task', search.results[0].url)
    expect(fetched.content).toBe('本地正文内容')
    expect(fetched.source.kind).toBe('fetched-page')
    expect(fetched.source.citationIndex).toBe(1)
  })

  it('只按引用编号返回 Main 保存的真实来源字段', async () => {
    const provider: WebSearchProvider = {
      search: async () => [
        {
          title: '来源一',
          url: 'https://8.8.8.8/one',
          excerpt: '摘要一',
          publishedAt: null
        },
        {
          title: '来源二',
          url: 'https://1.1.1.1/two',
          excerpt: '摘要二',
          publishedAt: null
        }
      ]
    }
    const service = new WebSearchService(settings, { volcengine: provider })
    service.beginTask('task', '测试')
    await service.search('task', '测试', 2)

    const sources = service.resolveSources('task', [{
      id: 'forged',
      citationIndex: 2,
      title: '伪造标题',
      url: 'javascript:alert(1)',
      domain: 'invalid',
      excerpt: '伪造摘要',
      kind: 'fetched-page',
      publishedAt: null
    }])

    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      citationIndex: 2,
      title: '来源二',
      url: 'https://1.1.1.1/two'
    })
  })

  it('按文档构造豆包搜索 POST 请求并映射网页结果', async () => {
    let requestedUrl = ''
    let requestedBody: Record<string, unknown> | null = null
    let requestedAuthorization = ''
    const provider = new VolcengineSearchProvider(async (url, options) => {
      requestedUrl = url
      requestedBody = JSON.parse(options.body?.toString('utf8') || '{}') as Record<string, unknown>
      requestedAuthorization = options.headers?.Authorization || ''
      return {
        body: Buffer.from(JSON.stringify({
          ResponseMetadata: { RequestId: 'request-id' },
          Result: {
            ResultCount: 1,
            WebResults: [{
              Title: '测试标题',
              Url: 'https://example.com/result',
              Snippet: '短摘要',
              Summary: '完整摘要',
              PublishTime: '2026-08-02T10:00:00+08:00'
            }]
          }
        })),
        contentType: 'application/json; charset=utf-8',
        finalUrl: url
      }
    })

    const results = await provider.search('桌宠', 3, 'volc-key', new AbortController().signal)

    expect(requestedUrl).toBe('https://open.feedcoopapi.com/search_api/web_search')
    expect(requestedAuthorization).toBe('Bearer volc-key')
    expect(requestedBody).toMatchObject({
      Query: '桌宠',
      SearchType: 'web',
      Count: 3,
      Filter: { NeedContent: false, NeedUrl: true }
    })
    expect(results).toEqual([{
      title: '测试标题',
      url: 'https://example.com/result',
      excerpt: '完整摘要',
      publishedAt: '2026-08-02T02:00:00.000Z'
    }])
  })

  it('将豆包搜索额度错误转换为稳定的内部错误码', async () => {
    for (const providerError of [
      { CodeN: 10412, Code: '10412', Message: 'quota exhausted' },
      { Code: 'SearchPackageQuotaExhausted', Message: 'quota exhausted' }
    ]) {
      const provider = new VolcengineSearchProvider(async (url) => ({
        body: Buffer.from(JSON.stringify({
          ResponseMetadata: { Error: providerError },
          Result: null
        })),
        contentType: 'application/json',
        finalUrl: url
      }))

      await expect(
        provider.search('测试', 1, 'volc-key', new AbortController().signal)
      ).rejects.toThrow('web_provider_quota_exhausted')
    }
  })
})
