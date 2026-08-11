import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageLockPath = join(projectRoot, 'package-lock.json')
const requirementsPath = join(projectRoot, 'python-runtime', 'requirements.lock')
const sitePackagesPath = join(projectRoot, 'python-runtime', '.venv', 'Lib', 'site-packages')
const noticesPath = join(projectRoot, 'THIRD_PARTY_NOTICES.md')
const licensesPath = join(projectRoot, 'THIRD_PARTY_LICENSES.txt')
const licenseOverridesRoot = join(projectRoot, 'licenses', 'third-party')

const LICENSE_FILE_PATTERN =
  /^(?:licen[cs]e|copying|copyright|notice|third[-_.]?party[-_.]?notices?)(?:[-_.]|$)/i
const LICENSE_OVERRIDES = new Map([
  ['npm:saxes@6.0.0', 'npm/saxes-6.0.0-LICENSE.txt'],
  ['PyPI:flatbuffers@25.12.19', 'common/Apache-2.0.txt'],
  ['PyPI:langchain-core@1.4.9', 'pypi/langchain-core-1.4.9-LICENSE.txt'],
  ['PyPI:langsmith@0.10.6', 'pypi/langsmith-0.10.6-LICENSE.txt'],
  ['PyPI:tokenizers@0.23.1', 'common/Apache-2.0.txt']
])

const [nodePackages, pythonPackages] = await Promise.all([
  collectNodePackages(),
  collectPythonPackages()
])
const packages = [...nodePackages, ...pythonPackages]
const missingLicenseBodies = packages.filter((item) => item.licenseTexts.length === 0)

await Promise.all([
  writeFile(noticesPath, renderNotices(nodePackages, pythonPackages, missingLicenseBodies), 'utf8'),
  writeFile(licensesPath, renderLicenseBundle(packages), 'utf8')
])

console.info(
  `第三方许可证清单已生成 Node=${nodePackages.length} Python=${pythonPackages.length} ` +
    `缺少正文=${missingLicenseBodies.length}`
)
for (const item of missingLicenseBodies) {
  console.warn(`第三方依赖缺少许可证正文 ecosystem=${item.ecosystem} package=${item.name}@${item.version}`)
}

/** 从 package-lock 和已安装目录收集实际存在的生产 Node 依赖。 */
async function collectNodePackages() {
  const lock = JSON.parse(await readFile(packageLockPath, 'utf8'))
  const records = new Map()
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (!location.includes('node_modules/') || entry.dev === true) {
      continue
    }
    const packageRoot = join(projectRoot, ...location.split('/'))
    const manifestPath = join(packageRoot, 'package.json')
    if (!existsSync(manifestPath)) {
      continue
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const name = String(manifest.name || packageNameFromLocation(location))
    const version = String(manifest.version || entry.version || 'unknown')
    const key = `${name}@${version}`
    if (records.has(key)) {
      continue
    }
    const record = {
      ecosystem: 'npm',
      name,
      version,
      license: normalizeLicense(manifest.license ?? entry.license),
      source: normalizeSource(manifest.homepage ?? manifest.repository),
      licenseTexts: await readNodeLicenseFiles(packageRoot)
    }
    await appendLicenseOverride(record)
    records.set(key, record)
  }
  return sortPackages([...records.values()])
}

/** 从 requirements.lock 和 dist-info 元数据收集锁定的 Python 依赖。 */
async function collectPythonPackages() {
  if (!existsSync(sitePackagesPath)) {
    throw new Error('Python 虚拟环境不存在，无法生成第三方许可证清单。')
  }
  const requirements = parseRequirements(await readFile(requirementsPath, 'utf8'))
  const distributions = await readPythonDistributions()
  const records = []
  for (const requirement of requirements) {
    const distribution = distributions.get(canonicalPackageName(requirement.name))
    if (!distribution || distribution.version !== requirement.version) {
      throw new Error(
        `Python 锁定依赖与虚拟环境不一致：${requirement.name}==${requirement.version}`
      )
    }
    records.push(distribution)
  }
  return sortPackages(records)
}

/** 读取 site-packages 中的 dist-info 元数据，并建立规范化包名索引。 */
async function readPythonDistributions() {
  const records = new Map()
  for (const entry of await readdir(sitePackagesPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) {
      continue
    }
    const distributionRoot = join(sitePackagesPath, entry.name)
    const metadataPath = join(distributionRoot, 'METADATA')
    if (!existsSync(metadataPath)) {
      continue
    }
    const headers = parseMetadataHeaders(await readFile(metadataPath, 'utf8'))
    const name = firstHeader(headers, 'name') || entry.name.replace(/\.dist-info$/i, '')
    const version = firstHeader(headers, 'version') || 'unknown'
    const metadataLicense = firstHeader(headers, 'license')
    const license =
      firstHeader(headers, 'license-expression') ||
      shortLicense(metadataLicense) ||
      licenseFromClassifiers(headers.get('classifier') ?? [])
    const licenseTexts = await readPythonLicenseFiles(distributionRoot, name)
    if (licenseTexts.length === 0 && metadataLicense && metadataLicense.length > 160) {
      licenseTexts.push({ label: 'METADATA License', text: normalizeText(metadataLicense) })
    }
    const record = {
      ecosystem: 'PyPI',
      name,
      version,
      license: license || 'UNKNOWN',
      source: pythonProjectUrl(headers),
      licenseTexts
    }
    await appendLicenseOverride(record)
    records.set(canonicalPackageName(name), record)
  }
  return records
}

/** 解析 Python Core Metadata 头部，保留重复字段和折行内容。 */
function parseMetadataHeaders(metadata) {
  const headers = new Map()
  let currentKey = null
  for (const line of metadata.replaceAll('\r\n', '\n').split('\n')) {
    if (line === '') {
      break
    }
    if (/^[ \t]/.test(line) && currentKey) {
      const values = headers.get(currentKey)
      values[values.length - 1] += `\n${line.trim()}`
      continue
    }
    const separator = line.indexOf(':')
    if (separator <= 0) {
      continue
    }
    currentKey = line.slice(0, separator).toLowerCase()
    const value = line.slice(separator + 1).trim()
    const values = headers.get(currentKey) ?? []
    values.push(value)
    headers.set(currentKey, values)
  }
  return headers
}

/** 读取 Node 包根目录中要求随分发保留的许可证和 NOTICE 文件。 */
async function readNodeLicenseFiles(packageRoot) {
  const texts = []
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name)) {
      texts.push(await readLicenseText(join(packageRoot, entry.name), entry.name))
    }
  }
  return texts.filter(Boolean).sort((left, right) => left.label.localeCompare(right.label))
}

/** 读取 Python dist-info、包根目录及 licenses 子目录中的许可证文件。 */
async function readPythonLicenseFiles(distributionRoot, packageName) {
  const candidates = []
  for (const entry of await readdir(distributionRoot, { withFileTypes: true })) {
    const path = join(distributionRoot, entry.name)
    if (entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name)) {
      candidates.push(path)
    } else if (entry.isDirectory() && entry.name.toLowerCase() === 'licenses') {
      candidates.push(...(await listFilesRecursively(path)))
    }
  }
  const packageRoot = await findPythonPackageRoot(distributionRoot, packageName)
  if (packageRoot) {
    for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
      if (entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name)) {
        candidates.push(join(packageRoot, entry.name))
      }
    }
  }
  const texts = await Promise.all(
    candidates.map((path) =>
      readLicenseText(path, relative(sitePackagesPath, path).replaceAll('\\', '/'))
    )
  )
  return texts.filter(Boolean).sort((left, right) => left.label.localeCompare(right.label))
}

/** 根据 top_level.txt 或规范化包名定位 Python 导入包根目录。 */
async function findPythonPackageRoot(distributionRoot, packageName) {
  const candidates = []
  const topLevelPath = join(distributionRoot, 'top_level.txt')
  if (existsSync(topLevelPath)) {
    const topLevels = (await readFile(topLevelPath, 'utf8')).split(/\r?\n/).filter(Boolean)
    candidates.push(...topLevels)
  }
  candidates.push(packageName.replaceAll('-', '_'), packageName.replaceAll('-', ''))
  for (const name of new Set(candidates)) {
    const packageRoot = join(sitePackagesPath, name)
    if (existsSync(packageRoot)) {
      return packageRoot
    }
  }
  return null
}

/** 为未随安装包分发正文的精确版本追加已登记的上游许可证副本。 */
async function appendLicenseOverride(record) {
  if (record.licenseTexts.length > 0) {
    return
  }
  const relativePath = LICENSE_OVERRIDES.get(
    `${record.ecosystem}:${record.name}@${record.version}`
  )
  if (!relativePath) {
    return
  }
  const licensePath = join(licenseOverridesRoot, ...relativePath.split('/'))
  const licenseText = await readLicenseText(licensePath, `上游许可证副本: ${relativePath}`)
  if (licenseText) {
    record.licenseTexts.push(licenseText)
  }
}

/** 递归枚举许可证目录中的普通文件。 */
async function listFilesRecursively(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(path)))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }
  return files
}

/** 读取许可证文本；二进制或空文件不会进入最终清单。 */
async function readLicenseText(path, label) {
  try {
    const text = normalizeText(await readFile(path, 'utf8'))
    if (!text || text.includes('\u0000')) {
      return null
    }
    return { label, text }
  } catch (error) {
    console.warn(`读取许可证文件失败 path=${path} error=${error?.name ?? 'UnknownError'}`)
    return null
  }
}

/** 生成便于仓库审阅的 Markdown 依赖摘要。 */
function renderNotices(nodePackages, pythonPackages, missingLicenseBodies) {
  const sections = [
    '# 第三方依赖声明',
    '',
    '> 本文件由 `npm run licenses` 自动生成，请勿手工修改依赖表。',
    '',
    'PetDock 的 MIT 许可证仅覆盖项目自有代码和文档。下列组件继续适用各自的',
    '许可证和版权声明；完整文本见 `THIRD_PARTY_LICENSES.txt`。清单按当前 Windows',
    '开发环境生成：Node 部分只包含实际安装的生产依赖，Python 部分包含',
    '`python-runtime/requirements.lock` 中的完整锁定环境，可能比 PyInstaller 最终',
    '收集的模块更宽，以避免遗漏分发义务。',
    '',
    '## Node.js 生产依赖',
    '',
    renderPackageTable(nodePackages),
    '',
    '## Python 锁定依赖',
    '',
    renderPackageTable(pythonPackages),
    '',
    '## 人工复核',
    ''
  ]
  if (missingLicenseBodies.length === 0) {
    sections.push('- 所有条目均已找到许可证正文或元数据中的完整许可证文本。')
  } else {
    sections.push('- 以下条目未找到许可证正文，正式发布前必须从上游补齐：')
    for (const item of missingLicenseBodies) {
      sections.push(`  - ${item.ecosystem}: \`${item.name}@${item.version}\`（${item.license}）`)
    }
  }
  sections.push(
    '- 自动识别结果不能替代对上游许可证、NOTICE、商标和素材条款的发布前审阅。',
    '- 升级锁文件、改变打包入口或新增依赖后，必须重新运行 `npm run licenses`。',
    ''
  )
  return `${sections.join('\n')}\n`
}

/** 生成随安装包分发的完整第三方许可证文本。 */
function renderLicenseBundle(packages) {
  const lines = [
    'PetDock Third-Party Licenses',
    'Generated from package-lock.json and python-runtime/requirements.lock.',
    'Do not remove this file from source or binary distributions.',
    ''
  ]
  for (const item of packages) {
    lines.push('='.repeat(88))
    lines.push(`${item.ecosystem} package: ${item.name}@${item.version}`)
    lines.push(`Declared license: ${item.license}`)
    if (item.source) {
      lines.push(`Project source: ${item.source}`)
    }
    if (item.licenseTexts.length === 0) {
      lines.push('License text: NOT FOUND - review required before distribution.')
      lines.push('')
      continue
    }
    for (const licenseText of item.licenseTexts) {
      lines.push('-'.repeat(88))
      lines.push(licenseText.label)
      lines.push('-'.repeat(88))
      lines.push(licenseText.text)
      lines.push('')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** 渲染稳定排序的依赖表。 */
function renderPackageTable(packages) {
  const lines = ['| 包 | 版本 | 许可证 | 项目地址 |', '| --- | --- | --- | --- |']
  for (const item of packages) {
    lines.push(
      `| ${escapeMarkdown(item.name)} | ${escapeMarkdown(item.version)} | ` +
        `${escapeMarkdown(item.license)} | ${escapeMarkdown(item.source || '-')} |`
    )
  }
  return lines.join('\n')
}

/** 解析 requirements.lock 中的固定版本依赖。 */
function parseRequirements(content) {
  const records = []
  for (const line of content.replaceAll('\r\n', '\n').split('\n')) {
    const match = /^([A-Za-z0-9_.-]+)==([^\s;]+)/.exec(line.trim())
    if (match) {
      records.push({ name: match[1], version: match[2] })
    }
  }
  return records
}

/** 从 package-lock 的物理路径推导包名。 */
function packageNameFromLocation(location) {
  const parts = location.split('/node_modules/').at(-1).split('/')
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

/** 规范化 Python 包名，匹配 PEP 503 的等价命名。 */
function canonicalPackageName(value) {
  return value.toLowerCase().replace(/[._-]+/g, '-')
}

/** 返回元数据字段的第一个非空值。 */
function firstHeader(headers, name) {
  return (headers.get(name) ?? []).find(Boolean) ?? ''
}

/** 优先选择适合展示的 Python 项目地址。 */
function pythonProjectUrl(headers) {
  for (const value of headers.get('project-url') ?? []) {
    const separator = value.indexOf(',')
    const url = separator >= 0 ? value.slice(separator + 1).trim() : value.trim()
    if (/^https?:\/\//i.test(url)) {
      return url
    }
  }
  return firstHeader(headers, 'home-page')
}

/** 从分类器中提取可读许可证名称。 */
function licenseFromClassifiers(classifiers) {
  const value = classifiers.find((item) => item.startsWith('License ::'))
  return value ? value.split('::').at(-1).trim() : ''
}

/** 避免把整份许可证正文塞进 Markdown 表格。 */
function shortLicense(value) {
  const normalized = String(value || '').trim()
  return normalized.length > 0 && normalized.length <= 160 && !normalized.includes('\n')
    ? normalized
    : ''
}

/** 兼容 package.json 中字符串、数组和对象形式的许可证字段。 */
function normalizeLicense(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  if (Array.isArray(value)) {
    const licenses = value.map(normalizeLicense).filter((item) => item !== 'UNKNOWN')
    return licenses.length > 0 ? licenses.join(' OR ') : 'UNKNOWN'
  }
  if (value && typeof value === 'object') {
    return normalizeLicense(value.type ?? value.name)
  }
  return 'UNKNOWN'
}

/** 规范化 package.json 的 homepage 或 repository 字段。 */
function normalizeSource(value) {
  const source = typeof value === 'string' ? value : value?.url
  return String(source || '').replace(/^git\+/, '').replace(/\.git$/, '')
}

/** 稳定排序，避免不同文件系统枚举顺序造成无意义差异。 */
function sortPackages(packages) {
  return packages.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en')
  )
}

/** 统一换行并去除 BOM 和首尾空白。 */
function normalizeText(value) {
  return String(value).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').trim()
}

/** 转义 Markdown 表格中的控制字符。 */
function escapeMarkdown(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}
