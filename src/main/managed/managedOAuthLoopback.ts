import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { logInfo } from '../logger'

const CALLBACK_PATH = '/oauth/callback'
const CALLBACK_HOST = '127.0.0.1'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000

/** Loopback 生命周期错误，Main 会将其映射为稳定错误码。 */
export class ManagedOAuthLoopbackError extends Error {
  constructor(
    readonly reason: 'cancelled' | 'timed_out' | 'invalid_callback' | 'server_error',
    message: string
  ) {
    super(message)
    this.name = 'ManagedOAuthLoopbackError'
  }
}

/** 一次性 loopback 回调监听器，只绑定 127.0.0.1。 */
export class ManagedOAuthLoopbackSession {
  readonly redirectUri: string
  private consumed = false
  private settled = false
  private expectedState: string | null = null
  private timeout: NodeJS.Timeout | null = null
  private readonly callbackPromise: Promise<URL>
  private resolveCallback!: (url: URL) => void
  private rejectCallback!: (error: Error) => void

  private constructor(private readonly server: Server, port: number, timeoutMs: number) {
    this.redirectUri = `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`
    this.callbackPromise = new Promise<URL>((resolve, reject) => {
      this.resolveCallback = resolve
      this.rejectCallback = reject
    })
    this.timeout = setTimeout(() => {
      this.finish(new ManagedOAuthLoopbackError('timed_out', 'OAuth 登录等待已超时。'))
    }, timeoutMs)
    this.timeout.unref()
  }

  /** 绑定随机端口并返回一次性登录会话。 */
  static async listen(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ManagedOAuthLoopbackSession> {
    const server = createServer()
    const address = await new Promise<{ port: number }>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        const value = server.address()
        if (!value || typeof value === 'string' || value.address !== CALLBACK_HOST) {
          server.close()
          reject(new ManagedOAuthLoopbackError('server_error', 'OAuth 回调监听地址不安全。'))
          return
        }
        resolve({ port: value.port })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, CALLBACK_HOST)
    })
    const session = new ManagedOAuthLoopbackSession(server, address.port, timeoutMs)
    server.on('request', (request, response) => session.handleRequest(request, response))
    logInfo('managed OAuth loopback listening', { port: address.port })
    return session
  }

  /** 等待一次合法 OAuth 回调；消费后监听器立即关闭。 */
  waitForCallback(): Promise<URL> {
    return this.callbackPromise
  }

  /** 写入本次授权的 state；只有写入后才接受浏览器回调。 */
  setExpectedState(state: string): void {
    if (this.settled || !state) {
      throw new ManagedOAuthLoopbackError('invalid_callback', 'OAuth 回调状态不可用。')
    }
    this.expectedState = state
  }

  /** 取消当前授权并关闭监听器。 */
  cancel(): void {
    if (!this.settled) {
      this.finish(new ManagedOAuthLoopbackError('cancelled', 'OAuth 登录已取消。'))
    }
  }

  /** 应用退出时清理监听器和超时，不把回调内容写入日志。 */
  dispose(): void {
    if (!this.settled) {
      this.finish(new ManagedOAuthLoopbackError('cancelled', '应用退出，OAuth 登录已取消。'))
    }
  }

  /** 校验 HTTP 方法、Host、路径、state 和授权响应参数。 */
  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (this.settled || this.consumed) {
      writeResponse(response, 410, 'OAuth 回调已消费。')
      return
    }
    if (request.method !== 'GET') {
      this.rejectRequest(response, 'OAuth 回调方法无效。')
      return
    }
    const host = request.headers.host
    if (host !== this.redirectUri.slice('http://'.length).split('/')[0]) {
      this.rejectRequest(response, 'OAuth 回调 Host 无效。')
      return
    }
    let callbackUrl: URL
    try {
      callbackUrl = new URL(request.url || '', this.redirectUri)
    } catch {
      this.rejectRequest(response, 'OAuth 回调地址无效。')
      return
    }
    if (callbackUrl.pathname !== CALLBACK_PATH || callbackUrl.hostname !== CALLBACK_HOST) {
      this.rejectRequest(response, 'OAuth 回调路径无效。')
      return
    }
    if (callbackUrl.port !== this.redirectUri.split(':')[2].split('/')[0]) {
      this.rejectRequest(response, 'OAuth 回调端口无效。')
      return
    }
    const state = callbackUrl.searchParams.get('state')
    if (!state || !this.expectedState || state !== this.expectedState) {
      this.rejectRequest(response, 'OAuth 回调状态缺失。')
      return
    }
    if (!callbackUrl.searchParams.get('code') && !callbackUrl.searchParams.get('error')) {
      this.rejectRequest(response, 'OAuth 回调结果缺失。')
      return
    }
    this.consumed = true
    writeResponse(response, 200, 'PetDock 登录回调已接收，可以返回应用。')
    this.finish(null, callbackUrl)
  }

  /** 拒绝非法回调并结束一次授权，响应不回显查询参数。 */
  private rejectRequest(response: ServerResponse, message: string): void {
    writeResponse(response, 400, message)
    this.finish(new ManagedOAuthLoopbackError('invalid_callback', message))
  }

  /** 统一完成路径，保证 close 只执行一次。 */
  private finish(error: Error | null, callbackUrl?: URL): void {
    if (this.settled) {
      return
    }
    this.settled = true
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
    this.server.close()
    if (error) {
      this.rejectCallback(error)
    } else if (callbackUrl) {
      this.resolveCallback(callbackUrl)
    }
  }
}

/** 写入不包含授权码、Token 或完整回调 URL 的浏览器响应。 */
function writeResponse(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(message)
}
