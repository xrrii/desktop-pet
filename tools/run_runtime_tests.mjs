import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 每次使用独立目录，避免 pytest 清理另一身份或历史执行留下的受限目录。 */
async function runRuntimeTests() {
  const tempRoot = join(projectRoot, 'temp')
  await mkdir(tempRoot, { recursive: true })
  const runRoot = await mkdtemp(join(tempRoot, 'pytest-runtime-'))
  try {
    const child = spawn(join(projectRoot, 'python-runtime', '.venv', 'Scripts', 'python.exe'), [
      '-m', 'pytest', '-q', '-p', 'no:cacheprovider',
      join(projectRoot, 'python-runtime', 'tests'), '--basetemp', join(runRoot, 'tests')
    ], {
      cwd: projectRoot,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: 'inherit',
      windowsHide: true
    })
    const { code, signal } = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    process.exitCode = signal === null && code !== null ? code : 1
  } finally {
    // 只清理本次 mkdtemp 创建的目录，不读取、删除或改权限历史 pytest 输出。
    try {
      await rm(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      console.warn('Runtime 测试临时目录清理未完成，请保留目录用于排查。')
    }
  }
}

try {
  await runRuntimeTests()
} catch (error) {
  console.error(`Runtime 测试启动失败（${error?.code || 'UNKNOWN'}），请核对 Python 环境与临时目录权限。`)
  process.exitCode = 1
}
