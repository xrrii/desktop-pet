import { spawn } from 'node:child_process'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pythonPath = join(projectRoot, 'python-runtime', '.venv', 'Scripts', 'python.exe')
const runtimeRoot = join(projectRoot, 'python-runtime')

const pyinstallerArgs = [
  '-m',
  'PyInstaller',
  '--noconfirm',
  '--clean',
  '--onefile',
  '--name',
  'petdock-assistant',
  '--specpath',
  join(runtimeRoot, 'build'),
  '--distpath',
  join(runtimeRoot, 'dist'),
  '--workpath',
  join(runtimeRoot, 'build'),
  '--hidden-import',
  'chromadb.api.rust',
  '--hidden-import',
  'chromadb.telemetry.product.posthog',
  '--hidden-import',
  'onnxruntime',
  '--hidden-import',
  'tokenizers',
  '--collect-data',
  'chromadb',
  '--exclude-module',
  'chromadb.test',
  '--exclude-module',
  'pytest',
  '--exclude-module',
  '_pytest',
  join(runtimeRoot, 'app.py')
]

await runPyInstaller()

/** 启动 PyInstaller，并把退出码原样返回给 npm。 */
async function runPyInstaller() {
  const child = spawn(pythonPath, pyinstallerArgs, {
    cwd: projectRoot,
    env: createBuildEnvironment(process.env),
    stdio: 'inherit',
    windowsHide: true
  })
  const result = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  if (result.code !== 0) {
    throw new Error(
      `PyInstaller 构建失败（code=${String(result.code)}, signal=${String(result.signal)}）。`
    )
  }
}

/**
 * 创建可重复的构建环境。
 * Windows 优先从 System32 解析 VC Runtime，避免 JDK 等工具目录中的旧 DLL 被打进 Runtime。
 */
function createBuildEnvironment(base) {
  const environment = { ...base, PYTHONNOUSERSITE: '1' }
  if (process.platform !== 'win32') {
    return environment
  }

  const pathKeys = Object.keys(environment).filter((key) => key.toLowerCase() === 'path')
  const pathValue = environment.Path ?? environment.PATH ?? environment[pathKeys[0] ?? ''] ?? ''
  for (const key of pathKeys) {
    delete environment[key]
  }
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? 'C:\\Windows'
  const system32 = join(systemRoot, 'System32')
  const entries = pathValue
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => resolve(entry).toLowerCase() !== resolve(system32).toLowerCase())
  environment.Path = [system32, ...entries].join(delimiter)
  return environment
}
