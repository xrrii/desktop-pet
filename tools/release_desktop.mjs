import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAndBuild, publishRelease, ReleaseError, requireVersion } from './desktop-release/core.mjs'
import {
  acquireLock, archiveBuild, callRemote, confirmRelease, defaultConfigPath, describeFile,
  forkAbortedRelease, loadConfig, loadPolicy, readJson, runNpm, runProcess, snapshotSource, updateVersion, uploadArtifact, verifyHttps, verifySigningKey, writeJson
} from './desktop-release/io.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runs = join(root, 'release-runs')
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** 参数不接受任意远程命令或关闭验签的开关。 */
function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!['--version', '--resume', '--status', '--abort', '--config'].includes(name) || values.has(name) || !value || value.startsWith('--')) {
      throw new ReleaseError('参数无效，请运行 npm run release:desktop -- --help 查看用法。')
    }
    values.set(name, value)
  }
  const modes = ['--version', '--resume', '--status', '--abort'].filter((name) => values.has(name))
  if (modes.length !== 1) throw new ReleaseError('需要且只能指定 version、resume、status、abort 中的一种。')
  const mode = modes[0].slice(2)
  const value = values.get(modes[0])
  if (mode === 'version') requireVersion(value)
  else if (!ID_PATTERN.test(value)) throw new ReleaseError('事务编号必须来自本命令输出的 UUID。')
  return { mode, value, config: values.get('--config') ?? defaultConfigPath() }
}

/** 冻结后的制品须重新验签、算摘要；恢复发布不重建同版本安装包。 */
async function loadRelease(directory, state, policy) {
  const envelope = await readJson(join(directory, 'manifest.json'))
  const verified = policy.verifySignedUpdateManifest(envelope, policy.DESKTOP_UPDATE_TRUST, state.version)
  const artifact = verified.manifest.artifact
  if (artifact.fileName !== `PetDock Setup ${state.version}.exe`) throw new ReleaseError('制品名称不符合当前 NSIS 构建规则。')
  const path = join(state.artifactReleaseId ? join(runs, state.artifactReleaseId) : directory, 'artifacts', artifact.fileName)
  const current = await describeFile(path)
  if (current.size !== artifact.size || current.sha512 !== artifact.sha512) throw new ReleaseError('冻结制品已改变，不允许继续发布。')
  return { releaseId: state.releaseId, version: state.version, artifact, envelope, artifactPath: path }
}

/** 对已有本地事务检查固定身份，避免读取任意目录作为恢复记录。 */
async function loadState(id) {
  const state = await readJson(join(runs, id, 'state.json'))
  if (state.schemaVersion !== 1 || state.releaseId !== id || !['created', 'built', 'signed', 'uploaded', 'prepared', 'active', 'committed', 'aborted'].includes(state.phase)) {
    throw new ReleaseError('本地发布记录无效。')
  }
  requireVersion(state.version)
  if (state.artifactReleaseId !== undefined && !ID_PATTERN.test(state.artifactReleaseId)) throw new ReleaseError('冻结制品来源编号无效。')
  return state
}

/** 新版本先检查和构建，再生成签名；不在缺少本机配置时改动版本。 */
async function prepareLocal(input) {
  if (input.mode !== 'version') return loadState(input.value)
  const releaseId = randomUUID()
  const directory = join(runs, releaseId)
  await mkdir(directory)
  const state = { schemaVersion: 1, releaseId, version: input.value, phase: 'created', createdAt: new Date().toISOString() }
  console.log(`发布事务：${releaseId}`)
  await writeJson(join(directory, 'state.json'), state)
  await updateVersion(root, state.version)
  console.log(`源码与锁文件版本已对齐：${state.version}`)
  // 工作区可以有用户修改，记录真实源码提交与差异摘要，不自动提交或切换分支。
  Object.assign(state, await snapshotSource(root))
  await writeJson(join(directory, 'state.json'), state)
  state.hashes = await checkAndBuild({
    check: async () => { console.log('开始源码检查；检查失败会停止发布。'); await runNpm(root, 'check') },
    dist: async () => { console.log('开始完整 Windows x64 打包。'); await runNpm(root, 'dist') },
    archive: () => archiveBuild(root, directory, state.version)
  })
  const after = await snapshotSource(root)
  if (state.sourceCommit !== after.sourceCommit || state.sourceDiffSha256 !== after.sourceDiffSha256) throw new ReleaseError('检查和构建期间 tracked 源码发生变化，停止签名和上传；请用稳定源码重新执行。')
  state.phase = 'built'
  await writeJson(join(directory, 'state.json'), state)
  return state
}

/** 复用已有离线签名工具并立即使用正式客户端公钥验签。 */
async function ensureSigned(directory, state, config, policy) {
  if (state.phase === 'created') throw new ReleaseError('本次构建尚未成功归档，请修复后创建新的发布事务。')
  if (state.phase === 'aborted') throw new ReleaseError('本次事务已取消，请先核对服务器入口和失败原因。')
  if (state.phase === 'built') {
    const output = join(directory, 'manifest.json')
    // 签名成功后进程可能在写记录前中断，存在的清单必须验证后复用，不能覆盖重签。
    const exists = await stat(output).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
    if (!exists) {
      const now = Math.floor(Date.now() / 1000) * 1000
      const utc = (time) => new Date(time).toISOString().replace('.000Z', 'Z')
      await runProcess(process.execPath, [join(root, 'tools', 'sign_desktop_update.mjs'),
        '--artifact', join(directory, 'artifacts', `PetDock Setup ${state.version}.exe`), '--version', state.version,
        '--key-id', config.signing.keyId, '--private-key', config.signing.privateKeyFile,
        '--issued-at', utc(now), '--expires-at', utc(now + 29 * 86400 * 1000), '--output', output], { timeout: 120_000 })
    }
    await loadRelease(directory, state, policy)
    state.phase = 'signed'
    await writeJson(join(directory, 'state.json'), state)
    console.log('清单签名与客户端内置信任校验通过。')
  }
  return loadRelease(directory, state, policy)
}

/** 本地编排入口；真实服务器行为只由用户主动执行本命令触发。 */
async function main(args) {
  const input = parseArguments(args)
  if (input.help) {
    console.log('用法：npm run release:desktop -- --version 0.2.5 [--config 仓库外配置文件]\n' +
      '恢复：npm run release:desktop -- --resume 事务UUID\n查询：npm run release:desktop -- --status 事务UUID\n取消/恢复旧目录并暂停：npm run release:desktop -- --abort 事务UUID\n' +
      '默认配置：用户目录/PetDock-release-input/release.config.json\n首次配置见 docs/guides/DESKTOP_RELEASE_AUTOMATION.md。')
    return
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new ReleaseError('本发布命令仅支持可信 Windows x64 构建机。')
  if (input.mode === 'version' && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new ReleaseError('正式发布需要交互终端，禁止自动批准。')
  const config = await loadConfig(input.config, root)
  const policy = await loadPolicy(root)
  if (input.mode === 'version') {
    await verifySigningKey(config, policy)
    await runProcess(config.pythonExecutable, ['-c', 'import qcloud_cos, cryptography, requests'])
  }
  const unlock = await acquireLock(runs)
  try {
    if (['status', 'abort'].includes(input.mode)) {
      const state = await loadState(input.value)
      const response = await callRemote(config, input.mode, state)
      // 只显示协议允许的公开摘要，不直接转印 SSH 的完整输出。
      if (response.schemaVersion !== 1 || response.releaseId !== state.releaseId || response.version !== state.version) throw new ReleaseError('服务器回应身份不一致。')
      console.log(JSON.stringify({ releaseId: state.releaseId, version: state.version, status: response.status,
        artifact: { size: response.artifact?.size, sha512: response.artifact?.sha512 }, rollbackVerified: response.rollbackVerified }))
      if (input.mode === 'abort') {
        if (response.status !== 'aborted') throw new ReleaseError('取消事务尚未确认成功。')
        state.phase = 'aborted'
        await writeJson(join(runs, state.releaseId, 'state.json'), state)
      }
      return
    }
    let state = await prepareLocal(input)
    if (input.mode === 'resume' && state.phase === 'aborted') {
      await loadRelease(join(runs, state.releaseId), state, policy)
      state = await forkAbortedRelease(runs, state)
      console.log(`已复用冻结制品，新发布事务：${state.releaseId}`)
    }
    const directory = join(runs, state.releaseId)
    const release = await ensureSigned(directory, state, config, policy)
    if (state.phase === 'signed') {
      console.log('开始上传冻结制品；同版本不同内容会拒绝覆盖。')
      const bucket = policy.DESKTOP_UPDATE_RELEASE.bucketHost.split('.cos.')[0]
      await uploadArtifact(config, bucket, release, join(directory, 'manifest.json'))
      state.phase = 'uploaded'
      await writeJson(join(directory, 'state.json'), state)
    }
    await publishRelease(release, {
      remote: (action, value) => callRemote(config, action, value),
      confirm: confirmRelease,
      verifyHttps: (value, full) => verifyHttps(policy, value, full),
      save: async (phase) => { state.phase = phase; await writeJson(join(directory, 'state.json'), state) },
      log: (message) => console.log(message)
    })
  } finally { await unlock() }
}

try { await main(process.argv.slice(2)) }
catch (error) {
  console.error(error instanceof ReleaseError ? error.message : '桌面发布失败，请核对本机配置、依赖和本次记录；底层输出已隐藏。')
  console.error('冻结制品与记录保存在 release-runs，恢复时使用本次事务 UUID；不重新构建或覆盖正式同版本对象。')
  process.exitCode = 1
}
