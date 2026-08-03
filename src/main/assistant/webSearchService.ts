import { request as httpRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { JSDOM } from 'jsdom'
import type {
  AssistantWebProvider,
  AssistantWebSettingsSnapshot,
  AssistantWebSource
} from '../../shared/assistant'
import {
  canonicalizeWebUrl,
  resolvePublicWebTarget,
  validateWebUrl,
  type ResolvedWebTarget
} from './webNetworkPolicy'

const SEARCH_LIMIT_PER_TASK = 2
const FETCH_LIMIT_PER_TASK = 4
const SEARCH_RESULTS_LIMIT = 10
const SEARCH_RESPONSE_BYTES = 1 * 1024 * 1024
const PAGE_RESPONSE_BYTES = 2 * 1024 * 1024
const PAGE_TEXT_CHARACTERS = 120_000
const REQUEST_TIMEOUT_MS = 15_000

interface WebSettingsAccess {
  snapshot(): AssistantWebSettingsSnapshot
  apiKey(provider: AssistantWebProvider): string | null
}

interface ProviderResult {
  title: string
  url: string
  excerpt: string
  publishedAt: string | null
}

export interface WebSearchProvider {
  search(query: string, maxResults: number, apiKey: string, signal: AbortSignal): Promise<ProviderResult[]>
}

type WebSearchProviderRegistry = Partial<Record<AssistantWebProvider, WebSearchProvider>>

interface WebTaskState {
  userUrls: Set<string>
  authorizedUrls: Set<string>
  sources: Map<string, AssistantWebSource>
  sourcesByIndex: Map<number, AssistantWebSource>
  nextCitationIndex: number
  searches: number
  fetches: number
  controllers: Set<AbortController>
}

export interface WebSearchToolResult {
  type: 'search_web'
  results: AssistantWebSource[]
}

export interface WebFetchToolResult {
  type: 'fetch_web_page'
  source: AssistantWebSource
  content: string
}

/** 管理单次助手任务中的搜索、抓取配额、来源编号和请求取消。 */
export class WebSearchService {
  private readonly tasks = new Map<string, WebTaskState>()

  constructor(
    private readonly settings: WebSettingsAccess,
    private readonly providers: WebSearchProviderRegistry = createDefaultProviders()
  ) {}

  beginTask(taskId: string, userInput: string): void {
    this.finishTask(taskId)
    this.tasks.set(taskId, {
      userUrls: extractUserUrls(userInput),
      authorizedUrls: new Set(),
      sources: new Map(),
      sourcesByIndex: new Map(),
      nextCitationIndex: 1,
      searches: 0,
      fetches: 0,
      controllers: new Set()
    })
  }

  async search(taskId: string, query: string, maxResults: number): Promise<WebSearchToolResult> {
    const state = this.requireTask(taskId)
    const { provider, apiKey } = this.requireConfiguredProvider()
    if (state.searches >= SEARCH_LIMIT_PER_TASK) {
      throw new Error('web_search_limit_reached')
    }
    state.searches += 1
    const normalizedQuery = query.trim()
    if (!normalizedQuery || normalizedQuery.length > 500) {
      throw new Error('web_query_invalid')
    }
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > SEARCH_RESULTS_LIMIT) {
      throw new Error('web_result_limit_invalid')
    }
    const checked = await this.withController(state, async (signal) => {
      const deadline = Date.now() + REQUEST_TIMEOUT_MS
      const candidates = await withWebDeadline(
        provider.search(normalizedQuery, maxResults, apiKey, signal),
        signal,
        deadline
      )
      return Promise.all(
        candidates.slice(0, maxResults).map(async (candidate) => {
          try {
            const target = await withWebDeadline(
              resolvePublicWebTarget(candidate.url),
              signal,
              deadline
            )
            return { candidate, url: canonicalizeWebUrl(target.url.toString()) }
          } catch (error) {
            if (
              signal.aborted ||
              (error instanceof Error && ['web_timeout', 'web_request_cancelled'].includes(error.message))
            ) {
              throw error
            }
            return null
          }
        })
      )
    })
    const results: AssistantWebSource[] = []
    for (const item of checked) {
      if (!item || state.sources.has(item.url)) {
        continue
      }
      const source = createSource(
        state.nextCitationIndex,
        item.candidate.title,
        item.url,
        item.candidate.excerpt,
        'search-summary',
        item.candidate.publishedAt
      )
      state.nextCitationIndex += 1
      state.sources.set(item.url, source)
      state.sourcesByIndex.set(source.citationIndex, source)
      state.authorizedUrls.add(item.url)
      results.push(source)
    }
    return { type: 'search_web', results }
  }

  async fetch(taskId: string, value: string): Promise<WebFetchToolResult> {
    const state = this.requireTask(taskId)
    this.requireConfiguredProvider()
    if (state.fetches >= FETCH_LIMIT_PER_TASK) {
      throw new Error('web_fetch_limit_reached')
    }
    const canonicalUrl = canonicalizeWebUrl(value)
    let source = state.sources.get(canonicalUrl)
    if (!source && !state.userUrls.has(canonicalUrl) && !state.authorizedUrls.has(canonicalUrl)) {
      throw new Error('web_url_not_authorized')
    }
    state.fetches += 1
    const page = await this.withController(state, (signal) => fetchWebPage(canonicalUrl, signal))
    const finalUrl = canonicalizeWebUrl(page.finalUrl)
    source ??= createSource(
      state.nextCitationIndex,
      page.title,
      finalUrl,
      page.content.slice(0, 500),
      'fetched-page',
      null
    )
    if (!state.sources.has(canonicalUrl)) {
      state.nextCitationIndex += 1
    }
    const fetchedSource: AssistantWebSource = {
      ...source,
      title: page.title || source.title,
      url: finalUrl,
      domain: new URL(finalUrl).hostname,
      excerpt: page.content.slice(0, 500),
      kind: 'fetched-page'
    }
    state.sources.set(canonicalUrl, fetchedSource)
    if (!state.sources.has(finalUrl)) {
      state.sources.set(finalUrl, fetchedSource)
    }
    state.sourcesByIndex.set(fetchedSource.citationIndex, fetchedSource)
    state.authorizedUrls.add(canonicalUrl)
    state.authorizedUrls.add(finalUrl)
    return { type: 'fetch_web_page', source: fetchedSource, content: page.content }
  }

  cancelTask(taskId: string): void {
    const state = this.tasks.get(taskId)
    if (!state) return
    state.controllers.forEach((controller) => controller.abort())
  }

  /** 只接受 Runtime 引用的编号，并用 Main 当前任务中的真实来源覆盖其余字段。 */
  resolveSources(taskId: string, requested: AssistantWebSource[]): AssistantWebSource[] {
    const state = this.requireTask(taskId)
    const indices = new Set(
      (Array.isArray(requested) ? requested : [])
        .map((source) => source?.citationIndex)
        .filter((index): index is number => Number.isInteger(index) && index > 0)
    )
    return [...state.sourcesByIndex.values()]
      .filter((source) => indices.has(source.citationIndex))
      .sort((left, right) => left.citationIndex - right.citationIndex)
  }

  finishTask(taskId: string): void {
    this.cancelTask(taskId)
    this.tasks.delete(taskId)
  }

  async testConnection(): Promise<number> {
    const { provider, apiKey } = this.requireConfiguredProvider(false)
    const controller = new AbortController()
    const results = await provider.search('PetDock', 1, apiKey, controller.signal)
    return results.length
  }

  private requireTask(taskId: string): WebTaskState {
    const state = this.tasks.get(taskId)
    if (!state) throw new Error('web_task_not_found')
    return state
  }

  private requireConfiguredProvider(requireEnabled = true): {
    provider: WebSearchProvider
    apiKey: string
  } {
    const snapshot = this.settings.snapshot()
    if (requireEnabled && !snapshot.enabled) throw new Error('web_search_disabled')
    const apiKey = this.settings.apiKey(snapshot.provider)
    if (!apiKey) throw new Error('web_search_not_configured')
    const provider = this.providers[snapshot.provider]
    if (!provider) throw new Error('web_provider_not_supported')
    return { provider, apiKey }
  }

  private async withController<T>(
    state: WebTaskState,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    state.controllers.add(controller)
    try {
      return await operation(controller.signal)
    } finally {
      state.controllers.delete(controller)
    }
  }
}

/** 使用固定豆包搜索 API Key 端点，以 POST JSON 返回可引用的网页候选。 */
export class VolcengineSearchProvider implements WebSearchProvider {
  constructor(
    private readonly requestResource: typeof requestPublicResource = requestPublicResource
  ) {}

  async search(
    query: string,
    maxResults: number,
    apiKey: string,
    signal: AbortSignal
  ): Promise<ProviderResult[]> {
    const body = Buffer.from(JSON.stringify({
      Query: query,
      SearchType: 'web',
      Count: maxResults,
      Filter: {
        NeedContent: false,
        NeedUrl: true
      }
    }), 'utf8')
    const response = await this.requestResource('https://open.feedcoopapi.com/search_api/web_search', {
      signal,
      maxBytes: SEARCH_RESPONSE_BYTES,
      allowedMimeTypes: ['application/json'],
      redirects: 0,
      method: 'POST',
      body,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    })
    let payload: unknown
    try {
      payload = JSON.parse(decodeResponse(response.body, response.contentType))
    } catch {
      throw new Error('web_provider_response_invalid')
    }
    return parseVolcengineSearchResponse(payload)
  }
}

/** 校验豆包搜索统一响应元信息，并转换为 Provider 通用结果。 */
export function parseVolcengineSearchResponse(payload: unknown): ProviderResult[] {
  const root = asRecord(payload)
  const metadata = asRecord(root?.ResponseMetadata)
  const providerError = asRecord(metadata?.Error)
  if (providerError) {
    throw new Error(volcengineProviderErrorCode(providerError))
  }
  const result = asRecord(root?.Result)
  const rawResults = result?.WebResults
  if (rawResults === null && result?.ResultCount === 0) return []
  if (!Array.isArray(rawResults)) throw new Error('web_provider_response_invalid')
  return rawResults.flatMap((item): ProviderResult[] => {
    const value = asRecord(item)
    if (!value || typeof value.Url !== 'string' || !value.Url.trim()) return []
    const excerpt = typeof value.Summary === 'string' && value.Summary.trim()
      ? value.Summary
      : typeof value.Snippet === 'string' ? value.Snippet : ''
    return [{
      title: cleanInlineText(typeof value.Title === 'string' ? value.Title : value.Url, 300),
      url: value.Url,
      excerpt: cleanInlineText(excerpt, 1_000),
      publishedAt: parsePublishedAt(value.PublishTime)
    }]
  })
}

/** 使用固定 Brave API 端点返回原始网页候选，不让 Provider 代替模型生成答案。 */
export class BraveSearchProvider implements WebSearchProvider {
  async search(
    query: string,
    maxResults: number,
    apiKey: string,
    signal: AbortSignal
  ): Promise<ProviderResult[]> {
    const endpoint = new URL('https://api.search.brave.com/res/v1/web/search')
    endpoint.searchParams.set('q', query)
    endpoint.searchParams.set('count', String(maxResults))
    endpoint.searchParams.set('safesearch', 'moderate')
    endpoint.searchParams.set('text_decorations', 'false')
    endpoint.searchParams.set('spellcheck', 'true')
    const response = await requestPublicResource(endpoint.toString(), {
      signal,
      maxBytes: SEARCH_RESPONSE_BYTES,
      allowedMimeTypes: ['application/json'],
      redirects: 0,
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey
      }
    })
    let body: unknown
    try {
      body = JSON.parse(decodeResponse(response.body, response.contentType))
    } catch {
      throw new Error('web_provider_response_invalid')
    }
    const rawResults = asRecord(asRecord(body)?.web)?.results
    if (!Array.isArray(rawResults)) {
      throw new Error('web_provider_response_invalid')
    }
    return rawResults.flatMap((item): ProviderResult[] => {
      const value = asRecord(item)
      if (!value || typeof value.url !== 'string') return []
      return [{
        title: cleanInlineText(typeof value.title === 'string' ? value.title : value.url, 300),
        url: value.url,
        excerpt: cleanInlineText(typeof value.description === 'string' ? value.description : '', 1_000),
        publishedAt: parsePublishedAt(value.page_age)
      }]
    })
  }
}

export interface PublicResourceOptions {
  signal: AbortSignal
  maxBytes: number
  allowedMimeTypes: string[]
  redirects: number
  headers?: Record<string, string>
  method?: 'GET' | 'POST'
  body?: Buffer
}

export interface PublicResource {
  body: Buffer
  contentType: string
  finalUrl: string
}

/** 以固定 DNS 结果连接公开网页，每次重定向都会重新校验目标。 */
export async function requestPublicResource(
  value: string,
  options: PublicResourceOptions
): Promise<PublicResource> {
  return requestPublicResourceAt(
    value,
    options,
    options.redirects,
    Date.now() + REQUEST_TIMEOUT_MS
  )
}

async function requestPublicResourceAt(
  value: string,
  options: PublicResourceOptions,
  redirectsLeft: number,
  deadline: number
): Promise<PublicResource> {
  if (options.signal.aborted) throw new Error('web_request_cancelled')
  const target = await withWebDeadline(resolvePublicWebTarget(value), options.signal, deadline)
  const response = await performRequest(target, options, deadline)
  if (response.statusCode >= 300 && response.statusCode < 400 && response.location) {
    if (redirectsLeft <= 0) throw new Error('web_redirect_denied')
    if (options.body) throw new Error('web_redirect_denied')
    let nextUrl: string
    try {
      nextUrl = new URL(response.location, target.url).toString()
    } catch {
      throw new Error('web_redirect_denied')
    }
    return requestPublicResourceAt(
      nextUrl,
      { ...options, headers: safeRedirectHeaders(options.headers) },
      redirectsLeft - 1,
      deadline
    )
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`web_http_${response.statusCode}`)
  }
  const mime = response.contentType.split(';', 1)[0].trim().toLowerCase()
  if (!options.allowedMimeTypes.includes(mime)) throw new Error('web_mime_denied')
  return { body: response.body, contentType: response.contentType, finalUrl: target.url.toString() }
}

async function performRequest(
  target: ResolvedWebTarget,
  options: PublicResourceOptions,
  deadline: number
): Promise<{ statusCode: number; location: string | null; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const timeoutMs = deadline - Date.now()
    if (timeoutMs <= 0) {
      reject(new Error('web_timeout'))
      return
    }
    const requestOptions: RequestOptions = {
      protocol: target.url.protocol,
      hostname: target.url.hostname,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: options.method || 'GET',
      signal: options.signal,
      headers: {
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        'User-Agent': 'PetDock/0.1 (+desktop assistant)',
        ...(options.body ? { 'Content-Length': String(options.body.length) } : {}),
        ...options.headers
      },
      lookup: createPinnedLookup(target)
    }
    const createRequest = target.url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = createRequest(requestOptions, (response) => {
      const statusCode = response.statusCode || 0
      const location = typeof response.headers.location === 'string' ? response.headers.location : null
      const contentType = typeof response.headers['content-type'] === 'string'
        ? response.headers['content-type']
        : 'application/octet-stream'
      const encoding = response.headers['content-encoding']
      if (encoding && encoding !== 'identity') {
        response.resume()
        reject(new Error('web_encoding_denied'))
        return
      }
      const declaredLength = Number(response.headers['content-length'] || 0)
      if (declaredLength > options.maxBytes) {
        response.resume()
        reject(new Error('web_response_too_large'))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > options.maxBytes) {
          request.destroy(new Error('web_response_too_large'))
          return
        }
        chunks.push(chunk)
      })
      response.once('end', () => resolve({
        statusCode,
        location,
        contentType,
        body: Buffer.concat(chunks)
      }))
      response.once('error', reject)
    })
    const timeout = setTimeout(() => request.destroy(new Error('web_timeout')), timeoutMs)
    request.once('close', () => clearTimeout(timeout))
    request.once('error', (error) => {
      if (options.signal.aborted) reject(new Error('web_request_cancelled'))
      else reject(error)
    })
    request.end(options.body)
  })
}

/** 兼容 Node 单地址和 `all: true` 地址列表回调，同时保持连接固定到已校验 IP。 */
export function createPinnedLookup(target: ResolvedWebTarget): LookupFunction {
  return (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) {
      callback(null, [{ address: target.address, family: target.family }])
      return
    }
    callback(null, target.address, target.family)
  }
}

/** 让 DNS 解析也受整次联网调用的统一超时和取消信号约束。 */
async function withWebDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadline: number
): Promise<T> {
  const timeoutMs = deadline - Date.now()
  if (timeoutMs <= 0) throw new Error('web_timeout')
  return new Promise<T>((resolve, reject) => {
    const finish = (callback: () => void): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => finish(() => reject(new Error('web_request_cancelled')))
    const timeout = setTimeout(() => finish(() => reject(new Error('web_timeout'))), timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}

async function fetchWebPage(value: string, signal: AbortSignal): Promise<{
  title: string
  content: string
  finalUrl: string
}> {
  const response = await requestPublicResource(value, {
    signal,
    maxBytes: PAGE_RESPONSE_BYTES,
    allowedMimeTypes: ['text/html', 'application/xhtml+xml', 'text/plain'],
    redirects: 5,
    headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' }
  })
  const text = decodeResponse(response.body, response.contentType)
  const mime = response.contentType.split(';', 1)[0].trim().toLowerCase()
  if (mime === 'text/plain') {
    return {
      title: new URL(response.finalUrl).hostname,
      content: normalizePageText(text).slice(0, PAGE_TEXT_CHARACTERS),
      finalUrl: response.finalUrl
    }
  }
  const extracted = extractWebPageText(text, response.finalUrl)
  return {
    title: extracted.title,
    content: extracted.content.slice(0, PAGE_TEXT_CHARACTERS),
    finalUrl: response.finalUrl
  }
}

/** 使用 DOM 解析网页，只保留主内容中的文本结构，不执行脚本或加载远程资源。 */
export function extractWebPageText(html: string, url = 'https://invalid.example/'): {
  title: string
  content: string
} {
  const dom = new JSDOM(html, { url })
  const document = dom.window.document
  document.querySelectorAll(
    'script,style,noscript,template,svg,canvas,form,input,button,nav,footer,aside,[hidden],[aria-hidden="true"]'
  ).forEach((node) => node.remove())
  const root = document.querySelector('article,main,[role="main"]') || document.body
  const blocks = [...root.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre,th,td')]
    .map((node) => normalizePageText(node.textContent || ''))
    .filter((text, index, values) => text.length > 0 && text !== values[index - 1])
  const fallback = normalizePageText(root.textContent || '')
  const content = blocks.length > 0 ? blocks.join('\n') : fallback
  const title = cleanInlineText(document.title || document.querySelector('h1')?.textContent || new URL(url).hostname, 300)
  dom.window.close()
  if (!content) throw new Error('web_content_empty')
  return { title, content }
}

function createSource(
  citationIndex: number,
  title: string,
  url: string,
  excerpt: string,
  kind: AssistantWebSource['kind'],
  publishedAt: string | null
): AssistantWebSource {
  return {
    id: `web-${citationIndex}`,
    citationIndex,
    title: cleanInlineText(title || new URL(url).hostname, 300),
    url,
    domain: new URL(url).hostname,
    excerpt: cleanInlineText(excerpt, 1_000),
    kind,
    publishedAt
  }
}

function extractUserUrls(input: string): Set<string> {
  const urls = new Set<string>()
  for (const match of input.matchAll(/https?:\/\/[^\s<>"'）)\]]+/gi)) {
    try {
      urls.add(canonicalizeWebUrl(match[0]))
    } catch {
      // 非法或非公网结构的用户 URL 不进入允许集合。
    }
  }
  return urls
}

function decodeResponse(body: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1]?.toLowerCase() || 'utf-8'
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

function normalizePageText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
}

function cleanInlineText(value: string, maxLength: number): string {
  const dom = new JSDOM(`<body>${value}</body>`)
  const text = normalizePageText(dom.window.document.body.textContent || '').replace(/\n+/g, ' ')
  dom.window.close()
  return text.slice(0, maxLength)
}

function safeRedirectHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {}
  const safe = { ...headers }
  delete safe.Authorization
  delete safe.authorization
  delete safe['X-Subscription-Token']
  return safe
}

function createDefaultProviders(): WebSearchProviderRegistry {
  return {
    volcengine: new VolcengineSearchProvider(),
    brave: new BraveSearchProvider()
  }
}

function volcengineProviderErrorCode(error: Record<string, unknown>): string {
  const code = typeof error.CodeN === 'number' || typeof error.CodeN === 'string'
    ? String(error.CodeN)
    : typeof error.Code === 'string' ? error.Code : ''
  switch (code) {
    case '10400':
    case '10402':
    case 'ParamError':
    case 'InvalidSearchType':
      return 'web_provider_request_invalid'
    case '10403':
    case 'InvalidAccountId':
      return 'web_provider_not_enabled'
    case '10406':
    case '10412':
    case 'FreeQuotaExhausted':
    case 'SearchPackageQuotaExhausted':
      return 'web_provider_quota_exhausted'
    case '10409':
    case '10410':
    case 'SearchPackageModeUnsupported':
    case 'SearchPackageUnavailable':
      return 'web_provider_key_mode_invalid'
    case '700429':
    case 'FreeRateLimitExceeded':
      return 'web_provider_rate_limited'
    default:
      return 'web_provider_failed'
  }
}

function parsePublishedAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
