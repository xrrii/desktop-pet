import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AssistantRuntimeReady,
  AssistantRuntimeStatus
} from '../../shared/assistant'
import { logError, logInfo } from '../logger'
import { AssistantRuntimeClient } from './runtimeClient'
import { normalizeRuntimeEnvironment } from './runtimeEnvironment'

// PyInstaller 单文件在 Windows 上需要先解包依赖，冷启动时间明显长于开发环境。
const START_TIMEOUT_MS = app.isPackaged ? 30_000 : 10_000
const STOP_TIMEOUT_MS = 3_000

export class AssistantRuntimeProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private client: AssistantRuntimeClient | null = null
  private startPromise: Promise<AssistantRuntimeClient> | null = null
  private stopping = false
  private status: AssistantRuntimeStatus = { state: 'stopped', backend: null, error: null }

  constructor(
    private readonly onStatus: (status: AssistantRuntimeStatus) => void,
    private readonly getRuntimeEnvironment: () => Record<string, string> = () => ({})
  ) {}

  getStatus(): AssistantRuntimeStatus {
    return { ...this.status }
  }

  async start(): Promise<AssistantRuntimeClient> {
    if (this.client && this.status.state === 'ready') {
      return this.client
    }
    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) {
      this.setStatus({ state: 'stopped', backend: null, error: null })
      return
    }

    this.stopping = true
    this.setStatus({ ...this.status, state: 'stopping', error: null })
    await this.client?.shutdown().catch(() => undefined)

    if (child.exitCode === null) {
      const exited = await waitForExit(child, STOP_TIMEOUT_MS)
      if (!exited) {
        child.kill()
        await waitForExit(child, 1_000)
      }
    }

    this.child = null
    this.client = null
    this.stopping = false
    this.setStatus({ state: 'stopped', backend: null, error: null })
  }

  /** 释放旧 Provider 后按最新模型配置启动新的 Runtime。 */
  async restart(): Promise<AssistantRuntimeClient> {
    await this.stop()
    return this.start()
  }

  private async startInternal(): Promise<AssistantRuntimeClient> {
    this.setStatus({ state: 'starting', backend: null, error: null })
    const token = randomBytes(32).toString('base64url')
    const invocation = resolveRuntimeInvocation()
    let runtimeEnvironment: Record<string, string>
    try {
      runtimeEnvironment = this.getRuntimeEnvironment()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus({ state: 'failed', backend: null, error: message })
      throw error
    }
    const environment = normalizeRuntimeEnvironment(process.env, {
      ...runtimeEnvironment,
      PETDOCK_RUNTIME_TOKEN: token,
      PETDOCK_MEMORY_DB_PATH: join(app.getPath('userData'), 'assistant.db'),
      PETDOCK_KNOWLEDGE_DB_PATH: join(app.getPath('userData'), 'knowledge.db'),
      PETDOCK_CHROMA_PATH: join(app.getPath('userData'), 'rag', 'chroma'),
      PETDOCK_SKILLS_DB_PATH: join(app.getPath('userData'), 'skills.db'),
      PETDOCK_SKILLS_ROOT: join(app.getPath('userData'), 'skills', 'packages'),
      PETDOCK_ATTACHMENT_ROOT: join(app.getPath('userData'), 'assistant', 'attachments'),
      PYTHONUNBUFFERED: '1'
    })
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    child.stdin.end()
    this.child = child

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim()
      if (message) {
        logError('assistant runtime stderr', message)
      }
    })

    child.once('exit', (code, signal) => {
      if (this.child !== child) {
        return
      }
      this.child = null
      this.client = null
      if (!this.stopping) {
        const error = `Assistant Runtime exited (code=${String(code)}, signal=${String(signal)}).`
        logError(error)
        this.setStatus({ state: 'failed', backend: null, error })
      }
    })

    try {
      const readiness = await waitForReadiness(child)
      const client = new AssistantRuntimeClient(readiness, token)
      await waitForHealth(client)
      this.client = client
      this.setStatus({ state: 'ready', backend: readiness.backend, error: null })
      logInfo('assistant runtime ready', {
        pid: readiness.pid,
        port: readiness.port,
        backend: readiness.backend
      })
      return client
    } catch (error) {
      child.kill()
      if (this.child === child) {
        this.child = null
      }
      this.client = null
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus({ state: 'failed', backend: null, error: message })
      throw error
    }
  }

  private setStatus(status: AssistantRuntimeStatus): void {
    this.status = status
    this.onStatus({ ...status })
  }
}

interface RuntimeInvocation {
  command: string
  args: string[]
  cwd: string
}

function resolveRuntimeInvocation(): RuntimeInvocation {
  const runtimeRoot = app.isPackaged
    ? join(process.resourcesPath, 'python-runtime')
    : join(app.getAppPath(), 'python-runtime')
  const packagedExecutable = join(runtimeRoot, 'petdock-assistant.exe')
  if (existsSync(packagedExecutable)) {
    return { command: packagedExecutable, args: [], cwd: runtimeRoot }
  }

  const configuredPython = process.env.PETDOCK_PYTHON?.trim()
  const virtualEnvironmentPython = join(runtimeRoot, '.venv', 'Scripts', 'python.exe')
  const command = configuredPython || (existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python')
  return { command, args: [join(runtimeRoot, 'app.py')], cwd: runtimeRoot }
}

function waitForReadiness(child: ChildProcessWithoutNullStreams): Promise<AssistantRuntimeReady> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout })
    const timeout = setTimeout(() => finish(new Error('Assistant Runtime startup timed out.')), START_TIMEOUT_MS)

    const onExit = (code: number | null): void => {
      finish(new Error(`Assistant Runtime exited before readiness (code=${String(code)}).`))
    }

    const finish = (error?: Error, readiness?: AssistantRuntimeReady): void => {
      clearTimeout(timeout)
      child.removeListener('exit', onExit)
      lines.removeAllListeners()
      lines.close()
      if (error) {
        reject(error)
      } else if (readiness) {
        resolve(readiness)
      }
    }

    child.once('exit', onExit)
    lines.on('line', (line) => {
      try {
        const readiness = JSON.parse(line) as unknown
        if (isReadiness(readiness)) {
          finish(undefined, readiness)
        }
      } catch {
        logInfo('assistant runtime stdout', line)
      }
    })
  })
}

async function waitForHealth(client: AssistantRuntimeClient): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await client.health()
      return
    } catch (error) {
      lastError = error
      await delay(100)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Assistant Runtime health check timed out.')
}

function isReadiness(value: unknown): value is AssistantRuntimeReady {
  if (!value || typeof value !== 'object') {
    return false
  }
  const ready = value as Record<string, unknown>
  return (
    ready.type === 'ready' &&
    ready.protocolVersion === 1 &&
    Number.isInteger(ready.port) &&
    Number(ready.port) > 0 &&
    Number.isInteger(ready.pid) &&
    (ready.backend === 'mock' || ready.backend === 'langchain')
  )
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timeout)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
