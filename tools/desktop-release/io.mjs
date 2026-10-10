import { spawn } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto'
import { cp, mkdir, open, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { get } from 'node:https'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { homedir } from 'node:os'
import { build } from 'esbuild'
import { compareVersions, ReleaseError, requireReply, requireVersion } from './core.mjs'

const MAX_JSON = 65_536
const require = createRequire(import.meta.url)

/** 内部保留有限子进程输出供协议解析，错误消息始终不包含正文。 */
class ProcessExitError extends ReleaseError {
  /** 仅留给固定 JSON 协议解析，调用者不能直接打印输出。 */
  constructor(output) {
    super('发布阶段失败，请核对依赖、权限或连接；底层输出已隐藏。')
    this.output = output
  }
}

/** 有限读取配置和事务记录，拒绝特殊文件和巨大正文。 */
export async function readJson(path, maximum = MAX_JSON) {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 1 || info.size > maximum) throw new ReleaseError('配置或发布记录文件无效。')
    const bytes = await file.readFile()
    if (bytes.length > maximum) throw new ReleaseError('配置或发布记录超过大小上限。')
    return JSON.parse(bytes.toString('utf8'))
  } finally { await file.close() }
}

/** 同目录写临时文件再替换，保留可恢复的本地事务记录。 */
export async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

/** 小型凭据只核对文件位置、类型和体积，不读取正文。 */
async function requireExternalFile(path, roots, maximum = 16_384) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new ReleaseError('本机配置必须使用完整文件路径。')
  const actual = await realpath(path)
  const info = await stat(actual)
  if (!info.isFile() || info.size < 1 || info.size > maximum || roots.some((root) => {
    const part = relative(root, actual)
    return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part))
  })) throw new ReleaseError('凭据必须是仓库外的小型普通文件。')
  return actual
}

/** 从仓库外配置读取路径，正式域名/桶仍由应用内置策略决定。 */
export async function loadConfig(path, root) {
  const config = await readJson(path)
  const cloudRoot = resolve(root, '..', 'petdock-office', 'petdock-cloud')
  const roots = [root, cloudRoot, resolve(cloudRoot, '..', 'petdock-web')]
  const actual = await realpath(path)
  if (roots.some((item) => { const part = relative(item, actual); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`) })) {
    throw new ReleaseError('发布配置必须保存在仓库外。')
  }
  if (config.schemaVersion !== 1 || Object.keys(config).some((key) => !['schemaVersion', 'ssh', 'signing', 'cosCredentialsFile', 'cloudRepository', 'pythonExecutable'].includes(key)) ||
      !config.ssh || !config.signing || Object.keys(config.ssh).some((key) => !['host', 'port', 'identityFile'].includes(key)) ||
      Object.keys(config.signing).some((key) => !['privateKeyFile', 'keyId'].includes(key)) ||
      !/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/.test(config.ssh.host ?? '') ||
      !Number.isInteger(config.ssh.port) || config.ssh.port < 1 || config.ssh.port > 65535 ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(config.signing.keyId ?? '')) {
    throw new ReleaseError('发布配置结构或 SSH 参数无效。')
  }
  if (config.cloudRepository !== undefined && (typeof config.cloudRepository !== 'string' || !isAbsolute(config.cloudRepository))) throw new ReleaseError('Cloud 仓库必须使用完整目录路径。')
  const repository = await realpath(config.cloudRepository ?? cloudRoot)
  roots.push(repository)
  await stat(join(repository, 'tools', 'desktop_cos_upload.py'))
  const python = config.pythonExecutable ?? join(repository, 'services', 'desktop-download', '.venv', 'Scripts', 'python.exe')
  if (!isAbsolute(python) || !(await stat(python)).isFile()) throw new ReleaseError('COS SDK 专用 Python 环境不可用。')
  return {
    ...config, cloudRepository: repository, pythonExecutable: python,
    ssh: { ...config.ssh, identityFile: await requireExternalFile(config.ssh.identityFile, roots) },
    signing: { ...config.signing, privateKeyFile: await requireExternalFile(config.signing.privateKeyFile, roots) },
    cosCredentialsFile: await requireExternalFile(config.cosCredentialsFile, roots)
  }
}

/** 子进程不使用 shell，敏感阶段仅返回有限输出，不回显底层错误。 */
export function runProcess(executable, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true, shell: false, stdio: options.visible ? 'inherit' : ['pipe', 'pipe', 'pipe']
    })
    const chunks = []
    let size = 0
    let failed = false
    const timer = setTimeout(() => { failed = true; child.kill() }, options.timeout ?? 120_000)
    child.once('error', () => { clearTimeout(timer); reject(new ReleaseError('发布子进程启动失败，请核对本机依赖。')) })
    if (!options.visible) {
      child.stdout.on('data', (chunk) => {
        size += chunk.length
        if (size > (options.outputLimit ?? MAX_JSON)) { failed = true; child.kill() } else chunks.push(chunk)
      })
      child.stderr.resume()
      child.stdin.on('error', () => {})
      child.stdin.end(options.input ?? '')
    }
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const output = Buffer.concat(chunks).toString('utf8')
      if (failed || signal !== null) reject(new ReleaseError('发布阶段失败或超时；底层输出已隐藏。'))
      else if (code !== 0) reject(new ProcessExitError(output))
      else resolveResult(output)
    })
  })
}

/** 复用 npm 已确认的 CLI 文件执行检查和构建，避开 Windows .cmd 的 shell 拼接。 */
export async function runNpm(root, task) {
  const npm = process.env.npm_execpath
  if (!npm || !isAbsolute(npm)) throw new ReleaseError('请通过 npm run release:desktop 执行发布命令。')
  const args = [npm, 'run', task]
  if (task === 'dist') args.push('--', '--win', '--x64')
  await runProcess(process.execPath, args, { cwd: root, visible: true, timeout: 60 * 60 * 1000 })
}

/** 拒绝未追踪的构建输入，再捕获 tracked 快照；排除 dist 自动生成的许可清单。 */
export async function snapshotSource(root, execute = runProcess) {
  const untracked = await execute('git', ['ls-files', '--others', '--exclude-standard', '-z', '--',
    'src', 'python-runtime', 'assets', 'tools', 'package.json', 'package-lock.json', 'electron.vite.config.ts', 'tsconfig.json'], { cwd: root })
  if (untracked.length) throw new ReleaseError('发布输入含未追踪源码，请先纳入 Git，再执行检查和构建。')
  const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
  const difference = await execute('git', ['diff', '--binary', 'HEAD', '--', '.',
    ':(exclude)THIRD_PARTY_NOTICES.md', ':(exclude)THIRD_PARTY_LICENSES.txt'], { cwd: root, outputLimit: 32 * 1024 * 1024 })
  return { sourceCommit: commit, sourceDiffSha256: createHash('sha256').update(difference).digest('hex') }
}

/** 内存编译实际客户端验签器，复用正式公钥与更新源边界。 */
export async function loadPolicy(root) {
  const result = await build({ stdin: {
    contents: 'export * from "./src/main/update/signedUpdateManifest"; export * from "./src/main/update/updatePolicy";', resolveDir: root
  }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
  const policy = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)
  if (!policy.DESKTOP_UPDATE_RELEASE.trustReady) throw new ReleaseError('正式客户端信任尚未就绪。')
  return policy
}

/** 发布前从私钥推导公钥并与客户端内置信任比较，错误密钥不进入昂贵构建。 */
export async function verifySigningKey(config, policy) {
  const file = await open(config.signing.privateKeyFile, 'r')
  try {
    const buffer = Buffer.alloc(16_385)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 16_384) throw new ReleaseError('签名私钥文件超限。')
    const bytes = buffer.subarray(0, bytesRead)
    const key = createPrivateKey(bytes)
    const trusted = policy.DESKTOP_UPDATE_TRUST
    if (key.asymmetricKeyType !== 'ed25519' || !trusted.keys[config.signing.keyId] || trusted.revokedKeyIds.includes(config.signing.keyId)) throw new ReleaseError('本机签名密钥不在正式客户端信任表中。')
    const der = createPublicKey(key).export({ type: 'spki', format: 'der' })
    const expected = createPublicKey(trusted.keys[config.signing.keyId]).export({ type: 'spki', format: 'der' })
    if (!der.equals(expected)) throw new ReleaseError('本机私钥与客户端正式公钥不匹配。')
  } finally { await file.close() }
}

/** 将版本同步到现有两个根节点，依赖内容与用户其他修改保持原值。 */
export async function updateVersion(root, version) {
  const packagePath = join(root, 'package.json')
  const lockPath = join(root, 'package-lock.json')
  const pkg = await readJson(packagePath)
  const lock = await readJson(lockPath, 8 * 1024 * 1024)
  requireVersion(pkg.version)
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new ReleaseError('应用与锁文件根版本不一致，请先统一。')
  if (compareVersions(version, pkg.version) < 0) throw new ReleaseError('发布版本不能低于当前源码版本。')
  if (version === pkg.version) return
  pkg.version = lock.version = lock.packages[''].version = version
  await writeJson(packagePath, pkg)
  await writeJson(lockPath, lock)
}

/** 流式计算稳定普通文件摘要，用于归档与完整 HTTPS 校验。 */
export async function describeFile(path, algorithm = 'sha512') {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 1 || info.size > 2_147_483_648) throw new ReleaseError('构建制品无效。')
    const hash = createHash(algorithm)
    let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) { size += chunk.length; hash.update(chunk) }
    const after = await file.stat()
    if (size !== info.size || after.mtimeMs !== info.mtimeMs || after.size !== info.size) throw new ReleaseError('构建制品读取期间发生变化。')
    return { size, [algorithm]: hash.digest(algorithm === 'sha512' ? 'base64' : 'hex') }
  } finally { await file.close() }
}

/** 归档完整解包应用与两个发行包；对真实 app.asar 和 Runtime 做交叉验证。 */
export async function archiveBuild(root, runDirectory, version) {
  const source = join(root, 'release')
  const archive = join(runDirectory, 'artifacts')
  await mkdir(archive)
  for (const name of [`PetDock Setup ${version}.exe`, `PetDock Portable ${version}.exe`, 'win-unpacked']) {
    await cp(join(source, name), join(archive, name), { recursive: true, errorOnExist: true, force: false })
  }
  const { extractFile } = require('@electron/asar')
  const pkg = JSON.parse(extractFile(join(archive, 'win-unpacked', 'resources', 'app.asar'), 'package.json').toString('utf8'))
  if (pkg.version !== version) throw new ReleaseError('实际打包应用版本不一致。')
  const hashes = {}
  for (const name of [`PetDock Setup ${version}.exe`, `PetDock Portable ${version}.exe`, 'win-unpacked/PetDock.exe', 'win-unpacked/resources/app.asar', 'win-unpacked/resources/python-runtime/petdock-assistant.exe']) {
    const frozen = await describeFile(join(archive, name))
    const original = await describeFile(join(source, name))
    if (frozen.size !== original.size || frozen.sha512 !== original.sha512) throw new ReleaseError('归档制品摘要与构建输出不一致。')
    hashes[name] = frozen
  }
  return hashes
}

/** 取消后复用原始冻结制品和签名，为新的服务器事务生成新编号，不重建同版本。 */
export async function forkAbortedRelease(runs, state) {
  const releaseId = randomUUID()
  const source = join(runs, state.releaseId, 'manifest.json')
  const directory = join(runs, releaseId)
  const envelope = await readJson(source)
  await mkdir(directory)
  await writeJson(join(directory, 'manifest.json'), envelope)
  const next = { ...state, releaseId, phase: 'signed', artifactReleaseId: state.artifactReleaseId ?? state.releaseId,
    previousReleaseId: state.releaseId, createdAt: new Date().toISOString() }
  await writeJson(join(directory, 'state.json'), next)
  return next
}

/** SSH 仅执行固定受控入口，JSON 通过 stdin 传输，禁用交互和新主机自动信任。 */
export async function callRemote(config, action, release, execute = runProcess) {
  const input = { schemaVersion: 1, action, releaseId: release.releaseId, version: release.version }
  if (action === 'prepare') input.manifest = release.envelope
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-p', String(config.ssh.port), '-i', config.ssh.identityFile, config.ssh.host,
    'sudo -n /usr/local/sbin/petdock-desktop-release']
  let output
  try { output = await execute('ssh.exe', args, { input: `${JSON.stringify(input)}\n` }) }
  catch (error) { if (error instanceof ProcessExitError) output = error.output; else throw error }
  const reply = JSON.parse(output)
  if (reply.status === 'failed') {
    if (reply.schemaVersion !== 1 || reply.releaseId !== release.releaseId || reply.version !== release.version) throw new ReleaseError('服务器错误回应身份不一致，请查询本次事务后再操作。')
    const hints = {
      catalog_or_manifest_invalid: '服务器历史目录或新清单无效，可能已有旧版本过期；请按指南续签维护后再发布。',
      download_paused: '下载入口处于运维暂停状态；请先完成服务器检查，发布工具不会自行解除此暂停。',
      version_conflict: '服务器拒绝同版本或非递增发布，请核对版本和已有对象。',
      release_in_progress: '服务器存在未结束事务，请先查询并处理原事务。',
      operation_incomplete: '服务器事务中断在切换阶段，请先取消事务以恢复并暂停入口。',
      baseline_changed: '正式目录、信任或暂停开关已发生变化，已停止发布。',
      pause_failed: '服务器暂停失败，请立即按部署指南执行 root 应急暂停。'
    }
    const error = new ReleaseError(hints[reply.category] ?? '服务器拒绝发布，请在服务器核对事务状态、目录时效和权限。')
    error.prepareRejected = action === 'prepare' && ['invalid_request', 'catalog_or_manifest_invalid', 'catalog_unavailable', 'download_paused', 'version_conflict', 'release_in_progress', 'manifest_invalid'].includes(reply.category)
    throw error
  }
  return reply
}

/** HTTPS 元数据不跟随跳转；整包仅接受从正式入口到固定 COS 主机的一次跳转。 */
export function httpsRead(url, { maximum, expectedStatus = 200, digest = false, method = 'GET' } = {}, send = get) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    const hash = digest ? createHash('sha512') : null
    let size = 0
    const request = send(url, { method, headers: { Accept: 'application/json, application/yaml, application/octet-stream' } }, (response) => {
      if (response.statusCode !== expectedStatus) { response.destroy(); reject(new ReleaseError('HTTPS 状态不符合发布验收要求。')); return }
      if (expectedStatus === 302) {
        const location = response.headers.location
        response.destroy()
        resolveBody(location)
        return
      }
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > maximum) response.destroy(new ReleaseError('HTTPS 响应超出发布验收范围。'))
        else if (hash) hash.update(chunk)
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        if (!response.complete) reject(new ReleaseError('HTTPS 传输未完成。'))
        else resolveBody(hash ? { size, sha512: hash.digest('base64') } : Buffer.concat(chunks))
      })
      response.once('close', () => { clearTimeout(timer); if (!response.complete) reject(new ReleaseError('HTTPS 传输未完成。')) })
    })
    const timer = setTimeout(() => request.destroy(new ReleaseError('HTTPS 验收超时。')), digest ? 30 * 60 * 1000 : 15_000)
    request.once('error', () => { clearTimeout(timer); reject(new ReleaseError('HTTPS 传输失败。')) })
    request.once('close', () => clearTimeout(timer))
  })
}

/** 正式入口完整校验清单、元数据与 EXE，不在磁盘保留校验下载或签名链接。 */
export async function verifyHttps(policy, release, full, read = httpsRead) {
  const base = policy.requireOfficialUpdateUrl(policy.DESKTOP_UPDATE_RELEASE.feedUrl)
  const metadata = JSON.parse((await read(new URL('latest.yml', base), { maximum: MAX_JSON })).toString('utf8'))
  const envelope = JSON.parse((await read(new URL(`manifests/${release.version}.json`, base), { maximum: MAX_JSON })).toString('utf8'))
  const verified = policy.verifySignedUpdateManifest(envelope, policy.DESKTOP_UPDATE_TRUST, release.version)
  const artifact = verified.manifest.artifact
  const path = `releases/${release.version}/${encodeURIComponent(artifact.fileName)}`
  if (metadata.version !== release.version || metadata.files?.length !== 1 || metadata.files[0].url !== path ||
      metadata.files[0].size !== artifact.size || metadata.files[0].sha512 !== artifact.sha512 ||
      metadata.path !== path || metadata.sha512 !== artifact.sha512 || 'stagingPercentage' in metadata || 'packages' in metadata ||
      envelope.keyId !== release.envelope.keyId || envelope.manifest !== release.envelope.manifest || envelope.signature !== release.envelope.signature ||
      artifact.size !== release.artifact.size || artifact.sha512 !== release.artifact.sha512) throw new ReleaseError('正式 HTTPS 清单或元数据与本次发布不一致。')
  if (!full) return
  const headLocation = new URL(await read(new URL(path, base), { method: 'HEAD', expectedStatus: 302 }))
  if (headLocation.protocol !== 'https:' || headLocation.hostname !== policy.DESKTOP_UPDATE_RELEASE.bucketHost || headLocation.port || headLocation.username || headLocation.password || headLocation.hash || headLocation.pathname !== new URL(path, base).pathname) throw new ReleaseError('整包 HEAD 跳转不在正式 COS 允许范围内。')
  const location = await read(new URL(path, base), { expectedStatus: 302 })
  const target = new URL(location)
  if (target.protocol !== 'https:' || target.hostname !== policy.DESKTOP_UPDATE_RELEASE.bucketHost || target.port || target.username || target.password || target.hash || target.pathname !== new URL(path, base).pathname) {
    throw new ReleaseError('整包下载跳转不在正式 COS 允许范围内。')
  }
  const downloaded = await read(target, { maximum: artifact.size, digest: true })
  if (downloaded.size !== artifact.size || downloaded.sha512 !== artifact.sha512) throw new ReleaseError('正式 HTTPS 整包大小或 SHA-512 不一致。')
}

/** 非交互终端不自动批准，用户必须输入确切版本以确认正式切换。 */
export async function confirmRelease(release) {
  console.log(`即将上线版本：${release.version}\n安装包字节数：${release.artifact.size}\nSHA-512：${release.artifact.sha512}\n事务：${release.releaseId}`)
  console.log('确认后将切换正式版本并下载一份安装包校验，计入 COS 流量与发链预算。')
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new ReleaseError('上线确认需要交互终端，禁止自动批准。')
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try { return (await prompt.question('输入本次版本号确认上线，其余输入取消：')).trim() === release.version }
  finally { prompt.close() }
}

/** 进程级互斥；异常遗留锁由用户核对后清理，避免并发抢占旧锁的竞态。 */
export async function acquireLock(directory) {
  await mkdir(directory, { recursive: true })
  const path = join(directory, '.release.lock')
  const token = randomUUID()
  try {
    await writeFile(path, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new ReleaseError('发布锁已存在。确认没有发布进程后，按指南清理 release-runs/.release.lock，再用原事务恢复。')
  }
  return async () => { if ((await readJson(path, 1024)).token === token) await unlink(path) }
}

/** 默认配置放在用户的发布输入目录，不进入源码或构建制品。 */
export function defaultConfigPath() { return join(homedir(), 'PetDock-release-input', 'release.config.json') }

/** 验证上传工具返回值与冻结制品一致，不能仅凭进程退出码继续上线。 */
export function checkUpload(reply, release) {
  requireReply({ ...reply, schemaVersion: 1, releaseId: release.releaseId, artifact: { size: reply.size, sha512: reply.sha512 } }, release, ['uploaded', 'already_present'])
}

const UPLOAD_FAILURE_HINTS = Object.freeze({
  AccessDenied: 'COS 拒绝访问，请核对发布身份对 releases/* 的 GetObject/PutObject 权限，修正后使用原事务恢复。',
  NoSuchBucket: 'COS 目标存储桶不存在或不可访问，请核对广州桶配置。',
  NoSuchKey: 'COS 上传回读未找到制品，请核对上传结果后使用原事务恢复。',
  InvalidAccessKeyId: 'COS 发布凭据 SecretId 无效，请更新仓库外的上传凭据文件。',
  SignatureDoesNotMatch: 'COS 请求签名不匹配，请核对上传凭据及系统时间。',
  ExpiredToken: 'COS 临时凭据已过期，请更新仓库外的上传凭据文件后使用原事务恢复。',
  RequestTimeTooSkewed: '本机时间与 COS 时间偏差过大，请同步系统时间后使用原事务恢复。',
  InvalidToken: 'COS 临时令牌无效，请核对上传凭据的 securityToken 后使用原事务恢复。',
  upload_or_binding_error: 'COS 上传或本地制品绑定检查失败，请核对凭据格式、网络及冻结制品，再使用原事务恢复。'
})
const UNKNOWN_UPLOAD_FAILURE = 'COS 上传未完成，详细输出已隐藏；请核对上传配置、连接和冻结制品，再使用原事务恢复。'

/** 只把精确失败协议中的白名单类别映射为固定中文，任何底层正文都不进入日志。 */
function uploadFailureMessage(output) {
  try {
    if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_JSON) return UNKNOWN_UPLOAD_FAILURE
    const reply = JSON.parse(output)
    if (reply && typeof reply === 'object' && !Array.isArray(reply) &&
        Object.keys(reply).sort().join(',') === 'category,status' && reply.status === 'failed' &&
        typeof reply.category === 'string' && Object.hasOwn(UPLOAD_FAILURE_HINTS, reply.category)) {
      return UPLOAD_FAILURE_HINTS[reply.category]
    }
  } catch { /* 非协议输出保持隐藏，不能将 traceback 或 SDK 诊断转印到终端。 */ }
  return UNKNOWN_UPLOAD_FAILURE
}

/** 上传失败保持原事务的 signed 阶段；非零退出即使伪造成功回应也不能继续上线。 */
export async function uploadArtifact(config, bucket, release, manifestFile, execute = runProcess) {
  let output
  try {
    output = await execute(config.pythonExecutable, [join(config.cloudRepository, 'tools', 'desktop_cos_upload.py'),
      '--credentials-file', config.cosCredentialsFile, '--bucket', bucket,
      '--artifact', release.artifactPath, '--manifest', manifestFile], { timeout: 60 * 60 * 1000 })
  } catch (error) {
    if (error instanceof ProcessExitError) throw new ReleaseError(uploadFailureMessage(error.output))
    throw error
  }
  let reply
  try { reply = JSON.parse(output) } catch { throw new ReleaseError(UNKNOWN_UPLOAD_FAILURE) }
  if (reply?.status === 'failed') throw new ReleaseError(uploadFailureMessage(output))
  checkUpload(reply, release)
  return reply
}
