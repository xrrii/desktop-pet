import type { IncomingMessage, RequestOptions } from 'node:http'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import type { UpdateManifest } from './signedUpdateManifest'
import { isReleaseVersion } from './signedUpdateManifest'
import { requireOfficialUpdateUrl } from './updatePolicy'

/** 在真实引擎发出每一次请求前校验地址，约束默认 COS 域名的签名重定向。 */
export class GuardedUpdateHttpExecutor extends ElectronHttpExecutor {
  private readonly base: URL
  private artifact: UpdateManifest | null = null
  private requests = 0

  constructor(feedUrl: string, private readonly bucketHost: string | null, private readonly now = Date.now) {
    super()
    this.base = requireOfficialUpdateUrl(feedUrl)
    if (!this.base.pathname.endsWith('/') || (bucketHost !== null &&
        !/^[a-z0-9][a-z0-9-]*-\d+\.cos\.ap-(beijing|shanghai|guangzhou|nanjing|chengdu)\.myqcloud\.com$/.test(bucketHost))) {
      throw new Error('桌面更新传输配置无效。')
    }
  }

  /** 每次检查清除旧下载授权，不允许新元数据借用已验证候选的传输权限。 */
  beginCheck(): void {
    this.requests = 0
    this.artifact = null
  }

  /** 签名验证后仅开放这一份制品，重试从固定入口重新获取短期链接。 */
  beginDownload(manifest: UpdateManifest): void {
    this.requests = 0
    this.artifact = manifest
  }

  /** 元数据中的下载地址必须与签名清单确定的版本和文件名完全一致。 */
  artifactUrl(manifest: UpdateManifest): URL {
    return new URL(`releases/${manifest.version}/${encodeURIComponent(manifest.artifact.fileName)}`, this.base)
  }

  /** 签名清单通过相同受限入口读取，响应与请求均有大小和时间边界。 */
  async readManifest(version: string): Promise<unknown> {
    if (!isReleaseVersion(version)) throw new Error('更新版本格式无效。')
    try {
      const url = new URL(`manifests/${version}.json`, this.base)
      const text = await this.request({ protocol: url.protocol, hostname: url.hostname, path: url.pathname, timeout: 15_000, method: 'GET' })
      if (!text) throw new Error()
      return JSON.parse(text)
    } catch {
      throw new Error('更新签名清单读取失败，请稍后重试。')
    }
  }

  /** 所有初始请求和重定向请求都经此入口，不能用引擎的默认跨域跟随绕过校验。 */
  override createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): Electron.ClientRequest {
    const url = this.validateRequest(options)
    if (++this.requests > 12) throw new Error('更新请求或重定向次数超过限制。')
    const isArtifact = this.artifact !== null && url.pathname === this.artifactUrl(this.artifact).pathname
    let activeResponse: IncomingMessage | null = null
    // 匿名下载也不能借用专用会话缓存的 HTTP 身份；地址只由已校验的 hostname/path 确定。
    const request = this.createTransportRequest({ ...options, redirect: 'manual', credentials: 'omit', useSessionCookies: false } as RequestOptions, (response) => {
      activeResponse = response
      let ended = false
      response.once('end', () => { ended = true; clearTimeout(timeout) })
      response.once('error', () => clearTimeout(timeout))
      response.once('close', () => {
        clearTimeout(timeout)
        if (!ended) request.emit('error', new Error('更新响应提前中断，请重新检查后重试。'))
      })
      const maxBytes = isArtifact && [200, 206].includes(response.statusCode || 0) ? this.artifact!.artifact.size : 65_536
      let bytes = 0
      response.on('data', (chunk: Buffer | string) => {
        bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        if (bytes > maxBytes) response.destroy(new Error('更新响应超过允许大小。'))
      })
      try {
        callback(response)
        const length = response.headers['content-length']
        if (length && (!/^\d+$/.test(String(length)) || Number(length) > maxBytes)) {
          response.destroy(new Error('更新响应超过允许大小。'))
        }
      } catch {
        // Node 回环测试的 Location 分支会同步递归；校验异常也必须归还给引擎 Promise。
        response.destroy()
        request.emit('error', new Error('更新响应或重定向不符合安全边界。'))
      }
    })
    // Electron net 不保证发出 Node socket 事件，因此额外设置覆盖整个请求的截止时间。
    const timeout = setTimeout(() => {
      const error = new Error('更新请求超时，请重新检查后重试。')
      // abort 事件本身不会让引擎 Promise 失败，先通知错误，再关闭响应与请求。
      request.emit('error', error)
      activeResponse?.destroy(error)
      request.abort()
    }, isArtifact ? 30 * 60_000 : 15_000)
    request.once('error', () => clearTimeout(timeout))
    request.once('abort', () => clearTimeout(timeout))
    timeout.unref()
    return request
  }

  /** 保留 Electron 的网络会话和代理支持；回环测试仅替换这一层网络映射。 */
  protected createTransportRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): Electron.ClientRequest {
    return super.createRequest(options, callback)
  }

  /** 原生 Electron 重定向先取消原请求，再由带地址校验的请求入口重新发送。 */
  protected override addRedirectHandlers(
    request: Electron.ClientRequest, options: RequestOptions, reject: (error: Error) => void,
    _redirectCount: number, handler: (options: RequestOptions) => void
  ): void {
    request.on('redirect', (_statusCode, _method, redirectUrl) => {
      request.abort()
      try {
        const next = ElectronHttpExecutor.prepareRedirectUrlOptions(redirectUrl, options)
        this.validateRequest(next)
        handler(next)
      } catch {
        reject(new Error('更新重定向不在允许范围内。'))
      }
    })
  }

  /** 明确区分小型元数据与已授权制品，仅后者可前往内置的确切私有桶主机。 */
  private validateRequest(options: RequestOptions): URL {
    const url = new URL(options.path || '/', `${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ''}`)
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || options.auth ||
        options.host || Reflect.has(options, 'url') ||
        !['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase()) ||
        Object.keys(options.headers || {}).some((name) => /^(host|cookie|authorization|proxy-authorization)$/i.test(name))) {
      throw new Error('更新请求不符合安全边界。')
    }
    const packageUrl = this.artifact ? this.artifactUrl(this.artifact) : null
    if (url.hostname === this.base.hostname) {
      const path = url.pathname.slice(this.base.pathname.length)
      const metadata = url.pathname.startsWith(this.base.pathname) &&
        (path === 'latest.yml' || /^manifests\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.json$/.test(path))
      if ((!metadata && url.pathname !== packageUrl?.pathname) ||
          (url.search && !(metadata && /^\?noCache=[a-z0-9]+$/.test(url.search)))) {
        throw new Error('更新入口路径不在允许范围内。')
      }
      return url
    }
    if (!packageUrl || !this.bucketHost || url.hostname !== this.bucketHost || url.pathname !== packageUrl.pathname) {
      throw new Error('更新制品不属于已授权的私有桶对象。')
    }
    this.requireSignedQuery(url)
    return url
  }

  /** 链接本身只限制读取窗口；内容信任仍由独立 Ed25519 清单和制品摘要负责。 */
  private requireSignedQuery(url: URL): void {
    const names = ['q-sign-algorithm', 'q-ak', 'q-sign-time', 'q-key-time', 'q-header-list', 'q-url-param-list', 'q-signature']
    const allowed = [...names, 'x-cos-security-token']
    const query = url.searchParams
    if (url.search.length > 8192 || names.some((name) => query.getAll(name).length !== 1) ||
        [...query.keys()].some((name) => !allowed.includes(name) || query.getAll(name).length !== 1) ||
        query.get('q-sign-algorithm') !== 'sha1' || !/^[A-Za-z0-9_-]{1,128}$/.test(query.get('q-ak') || '') ||
        !/^[a-f0-9]{40}$/i.test(query.get('q-signature') || '') ||
        !['', 'host'].includes(query.get('q-header-list') || '') ||
        !['', 'x-cos-security-token'].includes(query.get('q-url-param-list') || '')) {
      throw new Error('更新私有桶链接格式无效。')
    }
    for (const name of ['q-sign-time', 'q-key-time']) {
      const time = query.get(name) || ''
      const [start, end] = time.split(';').map(Number)
      const now = this.now() / 1000
      if (!/^\d{1,12};\d{1,12}$/.test(time) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start > now + 300 || end <= now || end <= start || end - start > 1800) {
        throw new Error('更新私有桶链接已过期或时效无效。')
      }
    }
  }
}
