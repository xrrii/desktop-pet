import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.argv[2] || 'dist'

/** 递归读取构建产物中的文本文件，不输出文件路径或配置值。 */
async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path))
    } else {
      files.push(path)
    }
  }
  return files
}

/** 生产制品只禁止静态开发服务端点；运行时拼接的 loopback 回调不命中这些模式。 */
function containsForbiddenEndpoint(text) {
  return [
    /https?:\/\/(?:localhost|127\.0\.0\.1)(?::(?:\d+))?(?:[/'"`]|$)/i,
    /https?:\/\/[^\s/'"`]+\.local(?:[/'"`]|$)/i,
    /https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)[^\s/'"`]+/i,
    /(?:localhost|127\.0\.0\.1):(?:8080|8090|15432|16379|49152)\b/i
  ].some((pattern) => pattern.test(text))
}

try {
  const files = await collectFiles(root)
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    if (containsForbiddenEndpoint(text)) {
      console.error('生产制品端点检查失败。')
      process.exitCode = 1
      break
    }
  }
  if (process.exitCode !== 1) {
    console.log('生产制品端点检查通过。')
  }
} catch {
  console.error('生产制品端点检查失败。')
  process.exitCode = 1
}
