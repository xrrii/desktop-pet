import { EventEmitter } from 'node:events'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { GuardedUpdateHttpExecutor } from './guardedUpdateHttpExecutor'
import type { UpdateManifest } from './signedUpdateManifest'

const bucket = 'synthetic-1250000000.cos.ap-shanghai.myqcloud.com'
const now = 1_800_000_000_000
const manifest: UpdateManifest = {
  schemaVersion: 1, appId: 'com.local.petdock', version: '0.2.2', channel: 'stable', platform: 'win32', arch: 'x64',
  artifact: { kind: 'nsis', fileName: 'PetDock Setup 0.2.2.exe', size: 100, sha512: Buffer.alloc(64).toString('base64') },
  issuedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-31T00:00:00Z'
}

/** 网络探针保留地址校验，但不访问网络，并用原生 redirect 事件验证 Electron 分支。 */
class Probe extends GuardedUpdateHttpExecutor {
  sent = 0
  lastRequest: Electron.ClientRequest | null = null
  lastOptions: RequestOptions | null = null

  /** 返回可观察的请求对象，每个测试都立即取消以清理计时器。 */
  protected override createTransportRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): Electron.ClientRequest {
    this.sent += 1
    this.lastOptions = options
    const events = new EventEmitter()
    const request = events as Electron.ClientRequest
    request.abort = () => { request.emit('abort') }
    request.end = vi.fn()
    events.on('response', callback)
    this.lastRequest = request
    return request
  }

  /** 把测试输入交给公开请求入口，成功时取消虚拟请求。 */
  send(value: string, extra: RequestOptions = {}): void {
    const url = new URL(value)
    this.createRequest({ protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
      path: `${url.pathname}${url.search}`, ...extra }, () => {}).abort()
  }

  /** 复现 Electron net 的 redirect 事件，并记录是否真正接受下一次请求。 */
  redirect(target: string): { reject: ReturnType<typeof vi.fn>; follow: ReturnType<typeof vi.fn> } {
    const request = new EventEmitter() as Electron.ClientRequest
    request.abort = vi.fn()
    const reject = vi.fn()
    const follow = vi.fn()
    const url = this.artifactUrl(manifest)
    this.addRedirectHandlers(request, { protocol: url.protocol, hostname: url.hostname, path: url.pathname }, reject, 0, follow)
    request.emit('redirect', 302, 'GET', target)
    expect(request.abort).toHaveBeenCalledOnce()
    return { reject, follow }
  }
}

/** 构造只含合成凭据的短期链接，不生成可访问腾讯云的实际授权。 */
function signedUrl(changes: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    'q-sign-algorithm': 'sha1', 'q-ak': 'synthetic', 'q-sign-time': '1800000000;1800001800',
    'q-key-time': '1800000000;1800001800', 'q-header-list': 'host', 'q-url-param-list': '',
    'q-signature': 'a'.repeat(40), ...changes
  })
  return `https://${bucket}/releases/0.2.2/PetDock%20Setup%200.2.2.exe?${query}`
}

describe('更新网络出口的请求与原生重定向边界', () => {
  it('只允许正式入口与确切大陆桶主机配置', () => {
    expect(() => new Probe('https://download.petdock.site/', bucket, () => now)).not.toThrow()
    expect(() => new Probe('https://download.petdock.site/feed', bucket)).toThrow()
    expect(() => new Probe('https://download.petdock.site/', 'evil.example')).toThrow()
    expect(() => new Probe('http://download.petdock.site/', bucket)).toThrow()
  })

  it('签名候选授权前不得访问桶，新的检查会清除旧授权', () => {
    const probe = new Probe('https://download.petdock.site/', bucket, () => now)
    expect(() => probe.send(signedUrl())).toThrow()
    probe.beginDownload(manifest)
    expect(() => probe.send(signedUrl())).not.toThrow()
    probe.beginCheck()
    expect(() => probe.send(signedUrl())).toThrow()
    expect(probe.sent).toBe(1)
  })

  it.each<Array<Record<string, string>>[number]>([
    { 'q-sign-algorithm': 'sha256' }, { 'q-signature': 'bad' }, { 'q-ak': '' },
    { 'q-sign-time': '1800000000;1800000000' }, { 'q-sign-time': '1799990000;1799991800' },
    { 'q-sign-time': '1800000301;1800001800' }, { 'q-sign-time': '1800000000;1800001801' },
    { 'q-key-time': '1800000000;1800003600' }, { 'q-header-list': 'authorization' },
    { 'q-url-param-list': 'arbitrary' }, { extra: 'unexpected' }
  ])('无效或过期的签名参数在发送之前拒绝：%j', (changes) => {
    const probe = new Probe('https://download.petdock.site/', bucket, () => now)
    probe.beginDownload(manifest)
    expect(() => probe.send(signedUrl(changes))).toThrow()
    expect(probe.sent).toBe(0)
  })

  it('重复查询参数、额外端口、明文协议与携带凭据的请求都拒绝', () => {
    const probe = new Probe('https://download.petdock.site/', bucket, () => now)
    probe.beginDownload(manifest)
    expect(() => probe.send(signedUrl() + '&q-ak=other')).toThrow()
    expect(() => probe.send(signedUrl().replace('https:', 'http:'))).toThrow()
    expect(() => probe.send(signedUrl().replace(bucket, `${bucket}:8443`))).toThrow()
    expect(() => probe.send(signedUrl(), { auth: 'synthetic' })).toThrow()
    expect(() => probe.send(signedUrl(), { host: 'evil.example' })).toThrow()
    expect(() => probe.send(signedUrl(), Object.assign({ method: 'GET' }, { url: 'https://evil.example/' }))).toThrow()
    expect(() => probe.send(signedUrl(), { headers: { Cookie: 'synthetic' } })).toThrow()
    expect(() => probe.send(signedUrl(), { method: 'POST' })).toThrow()
    expect(probe.sent).toBe(0)
  })

  it('原生请求明确禁用会话 Cookie 与缓存 HTTP 身份', () => {
    const probe = new Probe('https://download.petdock.site/', bucket, () => now)
    probe.send('https://download.petdock.site/latest.yml')
    expect(Reflect.get(probe.lastOptions!, 'credentials')).toBe('omit')
    expect(Reflect.get(probe.lastOptions!, 'useSessionCookies')).toBe(false)
  })

  it('元数据只允许固定路径及引擎的单一 noCache 参数', () => {
    const probe = new Probe('https://download.petdock.site/feed/', bucket, () => now)
    probe.send('https://download.petdock.site/feed/latest.yml?noCache=synthetic123')
    probe.send('https://download.petdock.site/feed/manifests/0.2.2.json')
    expect(() => probe.send('https://download.petdock.site/other/latest.yml')).toThrow()
    expect(() => probe.send('https://download.petdock.site/feed/latest.yml?target=other')).toThrow()
    expect(() => probe.send('https://download.petdock.site/feed/latest.yml?noCache=a&noCache=b')).toThrow()
    expect(probe.sent).toBe(2)
  })

  it('Electron 原生重定向接受已授权对象，并拒绝任意跨域目标', () => {
    const probe = new Probe('https://download.petdock.site/', bucket, () => now)
    probe.beginDownload(manifest)
    const accepted = probe.redirect(signedUrl())
    expect(accepted.reject).not.toHaveBeenCalled()
    expect(accepted.follow).toHaveBeenCalledOnce()
    const denied = probe.redirect('https://evil.example/setup.exe')
    expect(denied.reject).toHaveBeenCalledOnce()
    expect(denied.follow).not.toHaveBeenCalled()
  })

  it('没有 socket 或响应事件时，元数据截止时间也会结束引擎等待', async () => {
    vi.useFakeTimers()
    try {
      const probe = new Probe('https://download.petdock.site/', bucket, () => now)
      const abort = vi.fn()
      const pending = probe.request({ protocol: 'https:', hostname: 'download.petdock.site', path: '/latest.yml' })
      probe.lastRequest!.on('abort', abort)
      const rejected = expect(pending).rejects.toThrow('更新请求超时')
      await vi.advanceTimersByTimeAsync(15_000)
      await rejected
      expect(abort).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('响应已到达但正文停滞时，截止时间仍生效', async () => {
    vi.useFakeTimers()
    try {
      const probe = new Probe('https://download.petdock.site/', bucket, () => now)
      const pending = probe.request({ protocol: 'https:', hostname: 'download.petdock.site', path: '/latest.yml' })
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
      probe.lastRequest!.emit('response', response)
      response.write('version: ')
      const rejected = expect(pending).rejects.toThrow('更新请求超时')
      await vi.advanceTimersByTimeAsync(15_000)
      await rejected
      expect(response.destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('正文提前关闭不能留在永久检查状态', async () => {
    const probe = new Probe('https://download.petdock.site/', bucket, () => now)
    const pending = probe.request({ protocol: 'https:', hostname: 'download.petdock.site', path: '/latest.yml' })
    const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
    probe.lastRequest!.emit('response', response)
    response.write('version: ')
    response.destroy()
    await expect(pending).rejects.toThrow('更新响应提前中断')
  })
})
