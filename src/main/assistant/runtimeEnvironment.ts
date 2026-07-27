/**
 * 合并 Runtime 环境，并在 Windows 上消除 Path/PATH 重名项。
 * Windows 环境变量不区分大小写，重复项会让 PyInstaller 内 ONNX DLL 使用错误的搜索路径。
 */
export function normalizeRuntimeEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base, ...overrides }
  if (platform !== 'win32') {
    return environment
  }

  const pathKeys = Object.keys(environment).filter((key) => key.toLowerCase() === 'path')
  const pathValue = environment.Path ?? environment.PATH ?? environment[pathKeys[0] ?? '']
  for (const key of pathKeys) {
    delete environment[key]
  }
  if (pathValue) {
    environment.Path = pathValue
  }
  return environment
}
