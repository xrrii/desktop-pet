import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const executable = resolve(
  process.env.PETDOCK_RUNTIME_SMOKE_EXECUTABLE ||
    'python-runtime/dist/petdock-assistant.exe'
)
const dataRoot = await mkdtemp(join(tmpdir(), 'petdock-runtime-smoke-'))
const token = 't'.repeat(64)
const attachmentRoot = join(dataRoot, 'attachments')
const registrations = JSON.parse(execFileSync(
  resolve('python-runtime/.venv/Scripts/python.exe'),
  [resolve('tools/generate_c4_input_fixtures.py'), attachmentRoot],
  { encoding: 'utf8', windowsHide: true }
))

let smokeError
try {
  await runSmoke()
  console.log('RUNTIME_SMOKE_OK')
} catch (error) {
  smokeError = error
  throw error
} finally {
  try {
    // Windows 上 SQLite WAL/SHM 文件句柄可能在子进程退出后短暂滞留，清理需要重试。
    await rm(dataRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250
    })
  } catch (error) {
    // 不能让清理异常覆盖真正的冒烟断言；成功路径下保留可诊断的非敏感日志。
    if (!smokeError) {
      console.warn(`RUNTIME_SMOKE_CLEANUP_WARNING=${error?.code || error?.name || 'unknown'}`)
    }
  }
}

/** 启动打包 Runtime，验证 readiness、健康检查和带令牌的优雅关闭。 */
async function runSmoke() {
  const environment = {
    ...process.env,
    PETDOCK_RUNTIME_TOKEN: token,
    PETDOCK_ASSISTANT_BACKEND: 'mock',
    PETDOCK_MEMORY_DB_PATH: join(dataRoot, 'assistant.db'),
    PETDOCK_KNOWLEDGE_DB_PATH: join(dataRoot, 'knowledge.db'),
    PETDOCK_CHROMA_PATH: join(dataRoot, 'chroma'),
    PETDOCK_SKILLS_DB_PATH: join(dataRoot, 'skills.db'),
    PETDOCK_SKILLS_ROOT: join(dataRoot, 'skills', 'packages'),
    PETDOCK_ATTACHMENT_ROOT: attachmentRoot,
    PETDOCK_ARTIFACT_ROOT: join(dataRoot, 'artifacts')
  }
  // Windows 环境变量名不区分大小写，同时保留 Path/PATH 会让部分启动器拒绝环境字典。
  if (environment.Path) {
    delete environment.PATH
  } else if (environment.PATH) {
    environment.Path = environment.PATH
    delete environment.PATH
  }
  if (process.platform === 'win32' && environment.Path) {
    const system32 = join(environment.SystemRoot || 'C:\\Windows', 'System32')
    environment.Path = system32
  }

  const startedAt = Date.now()
  const child = spawn(executable, [], { env: environment, windowsHide: true })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    process.stderr.write(chunk)
  })

  try {
    const ready = await readReadiness(child)
    console.log(`RUNTIME_COLD_START_MS=${Date.now() - startedAt}`)
    const health = await fetch(`http://127.0.0.1:${ready.port}/health`, {
      signal: AbortSignal.timeout(5_000)
    })
    if (!health.ok || (await health.json()).protocolVersion !== 1) {
      throw new Error(`Runtime health check failed (${health.status}).`)
    }
    const capabilities = await fetch(`http://127.0.0.1:${ready.port}/v1/document-capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000)
    })
    const capabilityPayload = await capabilities.json()
    const parserIds = new Set(capabilityPayload.parsers?.map((item) => item.parserId))
    for (const parserId of ['pdf-text-v1', 'docx-ooxml-v1', 'xlsx-openpyxl-v1', 'pptx-python-v1', 'image-metadata-v1']) {
      if (!parserIds.has(parserId)) {
        throw new Error(`Packaged Runtime is missing parser ${parserId}.`)
      }
    }
    if (!['unconfigured', 'untested'].includes(capabilityPayload.vision?.status)) {
      throw new Error(`Unexpected packaged Vision status: ${capabilityPayload.vision?.status}`)
    }
    const registrationResponse = await fetch(`http://127.0.0.1:${ready.port}/v1/attachments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ attachments: registrations }),
      signal: AbortSignal.timeout(30_000)
    })
    const registrationPayload = await registrationResponse.json()
    if (!registrationResponse.ok) {
      throw new Error(`Packaged document registration failed: ${JSON.stringify(registrationPayload)}`)
    }
    const documents = registrationPayload.attachments || []
    const expectedParsers = ['pdf-text-v1', 'docx-ooxml-v1', 'xlsx-openpyxl-v1', 'pptx-python-v1']
    for (const parserId of expectedParsers) {
      const document = documents.find((item) => item.parserId === parserId)
      if (document?.status !== 'ready' || !Array.isArray(document.blocks) || document.blocks.length === 0) {
        throw new Error(`Packaged parser did not return blocks: ${parserId}`)
      }
    }
    const image = documents.find((item) => item.name === 'sample.png')
    if (image?.status !== 'ready' || image.parserId !== 'image-metadata-v1') {
      throw new Error(`Packaged image registration is invalid: ${JSON.stringify(image)}`)
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
