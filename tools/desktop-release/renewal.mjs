import { createPrivateKey, randomUUID, sign } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ReleaseError, requireReply, requireVersion } from './core.mjs'
import { RELEASE_ID_PATTERN } from './arguments.mjs'
import { verifySigningKey, writeJson } from './io.mjs'

export const RENEWAL_DAYS = 29
export const RENEWAL_THRESHOLD_DAYS = 14
const DAY = 86_400_000

/** 历史时间只用于维护时核对原签名；正常客户端和新清单仍严格检查当前时间。 */
export function verifySnapshot(snapshot, releaseId, policy, now = Date.now()) {
  if (snapshot?.schemaVersion !== 1 || snapshot.releaseId !== releaseId || snapshot.status !== 'snapshot' ||
      typeof snapshot.paused !== 'boolean' || !Number.isInteger(snapshot.versionCount) ||
      snapshot.versionCount < 1 || snapshot.versionCount > 16 ||
      !snapshot.baseline || Object.keys(snapshot.baseline).sort().join(',') !== 'catalogHash,controlHash,trustHash' ||
      Object.values(snapshot.baseline).some((value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
    throw new ReleaseError('服务器续签快照无效。')
  }
  requireVersion(snapshot.version)
  try {
    const issued = Date.parse(JSON.parse(Buffer.from(snapshot.manifest.manifest, 'base64').toString('utf8')).issuedAt)
    if (!Number.isFinite(now) || !Number.isFinite(issued) || issued > now + 300_000) throw new Error()
    return policy.verifySignedUpdateManifest(snapshot.manifest, policy.DESKTOP_UPDATE_TRUST, snapshot.version, issued).manifest
  } catch { throw new ReleaseError('当前版原清单验签失败，不能续签或迁移。') }
}

/** 仅重新签署时间字段；不依赖安装包、COS 凭据或版本文件。 */
export async function createRenewal(snapshot, releaseId, config, policy, now = Date.now()) {
  const original = verifySnapshot(snapshot, releaseId, policy, now)
  if (snapshot.manifest.keyId !== config.signing.keyId) throw new ReleaseError('续签不能更换签名身份。')
  await verifySigningKey(config, policy)
  const utc = (time) => new Date(time).toISOString().replace('.000Z', 'Z')
  const issued = Math.floor(now / 1000) * 1000
  const bytes = Buffer.from(JSON.stringify({ ...original, issuedAt: utc(issued), expiresAt: utc(issued + RENEWAL_DAYS * DAY) }))
  const key = createPrivateKey(await readFile(config.signing.privateKeyFile))
  const keyId = config.signing.keyId
  const envelope = { schemaVersion: 1, keyId, manifest: bytes.toString('base64'),
    signature: sign(null, Buffer.concat([Buffer.from(`PetDock desktop update manifest v1\n${keyId}\n`), bytes]), key).toString('base64') }
  policy.verifySignedUpdateManifest(envelope, policy.DESKTOP_UPDATE_TRUST, snapshot.version, now)
  return envelope
}

/** 恢复时复用已冻结请求；断线后同一编号重试，不产生另一份清单。 */
export async function resumeRenewal(state, policy, dependencies) {
  const { remote, save, verifyHttps, log } = dependencies
  if (state.operation !== 'renew' || !RELEASE_ID_PATTERN.test(state.releaseId) ||
      !['signed', 'committed'].includes(state.phase) || typeof state.migration !== 'boolean') throw new ReleaseError('续签恢复记录无效。')
  const original = verifySnapshot(state.snapshot, state.releaseId, policy)
  const verified = policy.verifySignedUpdateManifest(state.envelope, policy.DESKTOP_UPDATE_TRUST, state.version)
  const withoutTime = ({ issuedAt: _issued, expiresAt: _expires, ...binding }) => binding
  if (state.version !== state.snapshot.version || state.envelope.keyId !== state.snapshot.manifest.keyId ||
      JSON.stringify(withoutTime(original)) !== JSON.stringify(withoutTime(verified.manifest)) ||
      JSON.stringify(state.baseline) !== JSON.stringify(state.snapshot.baseline)) throw new ReleaseError('续签记录的原版本或制品绑定发生变化。')
  const release = { ...state, artifact: verified.manifest.artifact }
  const reply = requireReply(await remote('renew', release), release, ['committed'])
  if (reply.operation !== 'renew' || reply.paused !== state.snapshot.paused ||
      reply.expiresAt !== verified.manifest.expiresAt) throw new ReleaseError('服务器续签结果与本次请求不一致。')
  state.phase = 'committed'
  await save(state)
  if (reply.paused) {
    log(`当前版 ${state.version} 已续签至 ${reply.expiresAt}，入口保留暂停；恢复后仍需 HTTPS 验收。`)
  } else {
    await verifyHttps(release, false)
    log(`当前版 ${state.version} 已续签至 ${reply.expiresAt}，HTTPS 元数据复验通过。`)
  }
  return state
}

/** 先取得当前版快照，临期才签名；迁移必须单独交互批准，不供定时任务使用。 */
export async function startRenewal(input, config, policy, runs, dependencies) {
  const { remote, confirmMigration, log } = dependencies
  const releaseId = randomUUID()
  const snapshot = await remote('snapshot', { releaseId, version: '0.0.0' })
  const original = verifySnapshot(snapshot, releaseId, policy)
  if (snapshot.versionCount > 1 && !input.migration) throw new ReleaseError('正式目录尚有历史版本，请先交互执行 --renew --migrate-current。')
  if (input.migration && !await confirmMigration(snapshot)) { log('已取消迁移，服务器未改变。'); return }
  // 人工确认可能耗时数分钟，签发时间取确认后的真实时刻，并与协议秒精度对齐。
  const now = Math.floor(Date.now() / 1000) * 1000
  const remaining = Date.parse(original.expiresAt) - now
  if (input.migration && remaining >= RENEWAL_DAYS * DAY) {
    throw new ReleaseError('原清单剩余有效期已满29天，请在剩余不足29天后重新迁移，不能缩短原有效期。')
  }
  if (input.ifDue && remaining > RENEWAL_THRESHOLD_DAYS * DAY || remaining >= RENEWAL_DAYS * DAY && !input.migration) {
    log(`当前版 ${snapshot.version} 尚未到续签窗口，到期 ${original.expiresAt}。`)
    return
  }
  const envelope = await createRenewal(snapshot, releaseId, config, policy, now)
  const state = { schemaVersion: 1, operation: 'renew', releaseId, version: snapshot.version,
    phase: 'signed', createdAt: new Date().toISOString(), snapshot, envelope,
    baseline: snapshot.baseline, migration: input.migration }
  const directory = join(runs, releaseId)
  await mkdir(directory)
  const save = (value) => writeJson(join(directory, 'state.json'), value)
  await save(state)
  log(`续签事务：${releaseId}；中断后用 --status ${releaseId} 查询，或 --resume ${releaseId} 重试同一冻结请求。`)
  return resumeRenewal(state, policy, { ...dependencies, save })
}
