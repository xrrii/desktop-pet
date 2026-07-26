import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const executable = resolve(
  process.env.PETDOCK_RUNTIME_SMOKE_EXECUTABLE ||
    'python-runtime/dist/petdock-assistant.exe'
)
const dataRoot = await mkdtemp(join(tmpdir(), 'petdock-runtime-smoke-'))
const token = 't'.repeat(64)

try {
  await runSmoke()
  console.log('RUNTIME_SMOKE_OK')
} finally {
  await rm(dataRoot, { recursive: true, force: true })
}

/** 启动打包 Runtime，验证 readiness、健康检查和带令牌的优雅关闭。 */
async function runSmoke() {
  const environment = {
    ...process.env,
    PETDOCK_RUNTIME_TOKEN: token,
    PETDOCK_ASSISTANT_BACKEND: 'mock',
    PETDOCK_MEMORY_DB_PATH: join(dataRoot, 'assistant.db'),
    PETDOCK_KNOWLEDGE_DB_PATH: join(dataRoot, 'knowledge.db'),
    PETDOCK_CHROMA_PATH: join(dataRoot, 'chroma')
  }
  // Windows 环境变量名不区分大小写，同时保留 Path/PATH 会让部分启动器拒绝环境字典。
  if (environment.Path) {
    delete environment.PATH
  } else if (environment.PATH) {
    environment.Path = environment.PATH
    delete environment.PATH
  }

  const child = spawn(executable, [], { env: environment, windowsHide: true })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    const ready = await readReadiness(child)
    const health = await fetch(`http://127.0.0.1:${ready.port}/health`, {
      signal: AbortSignal.timeout(5_000)
    })
    if (!health.ok || (await health.json()).protocolVersion !== 1) {
      throw new Error(`Runtime health check failed (${health.status}).`)
    }
    const shutdown = await fetch(`http://127.0.0.1:${ready.port}/v1/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (!shutdown.ok) {
      throw new Error(`Runtime shutdown failed (${shutdown.status}).`)
    }
    await waitForExit(child, 10_000)
  } catch (error) {
    if (stderr.trim()) {
      console.error(stderr.trim())
    }
    throw error
  } finally {
    if (child.exitCode === null) {
      child.kill()
    }
  }
}

/** 读取 Runtime stdout 的第一行 readiness JSON，并限制单文件解包启动时间。 */
function readReadiness(child) {
  return new Promise((resolveReady, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => finish(new Error('Runtime readiness timed out.')), 30_000)
    const onExit = (code) => finish(new Error(`Runtime exited before readiness (${code}).`))
    const onData = (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) {
        return
      }
      try {
        const ready = JSON.parse(buffer.slice(0, newline))
        if (ready?.type !== 'ready' || !Number.isInteger(ready.port)) {
          throw new Error('Runtime readiness payload is invalid.')
        }
        finish(undefined, ready)
      } catch (error) {
        finish(error)
      }
    }
    const finish = (error, ready) => {
      clearTimeout(timeout)
      child.stdout.removeListener('data', onData)
      child.removeListener('exit', onExit)
      if (error) {
        reject(error)
      } else {
        resolveReady(ready)
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.once('exit', onExit)
  })
}

/** 等待 Runtime 完成优雅退出，超时由调用方强制结束测试进程。 */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error('Runtime did not exit after shutdown.')), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolveExit()
    })
  })
}
