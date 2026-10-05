/** 只输出固定中文诊断，不让底层异常带出凭据或带签名地址。 */
export class ReleaseError extends Error {}

/** 正式版本沿用客户端的安全整数边界。 */
export function requireVersion(value) {
  if (typeof value !== 'string' || value.length > 50 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ||
      value.split('.').some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new ReleaseError('版本必须是无前导零的正式三段整数。')
  }
  return value
}

/** 用整数段比较版本，避免字符串排序把 0.2.10 排到 0.2.9 前。 */
export function compareVersions(left, right) {
  const a = requireVersion(left).split('.').map(Number)
  const b = requireVersion(right).split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

/** 校验远端回应绑定同一事务、版本及制品；不相信仅有成功退出码。 */
export function requireReply(reply, release, statuses) {
  if (reply?.schemaVersion !== 1 || reply.releaseId !== release.releaseId ||
      reply.version !== release.version || !statuses.includes(reply.status) ||
      reply.artifact?.size !== release.artifact.size || reply.artifact?.sha512 !== release.artifact.sha512) {
    throw new ReleaseError('服务器回应与本次发布不一致，已停止发布。')
  }
  return reply
}

/** 检查、完整打包、归档严格串行，失败不会向后执行或进入上传。 */
export async function checkAndBuild({ check, dist, archive }) {
  await check()
  await dist()
  return archive()
}

/** 发布事务只在人工确认后激活，任何不确定失败都尝试恢复并暂停入口。 */
export async function publishRelease(release, dependencies) {
  const { remote, confirm, verifyHttps, save, log } = dependencies
  let touched = false
  let committed = false
  try {
    touched = true
    const prepared = requireReply(await remote('prepare', release), release, ['prepared', 'active', 'committed'])
    if (prepared.status === 'committed') {
      // 断线可能发生在服务器提交后，重新查验元数据即可，不重复签发整包链接。
      committed = true
      await verifyHttps(release, false)
      await save('committed')
      log('本次事务已在服务器提交，HTTPS 元数据复验通过。')
      return 'committed'
    }
    await save(prepared.status)
    if (!await confirm(release)) {
      const aborted = requireReply(await remote('abort', release), release, ['aborted'])
      touched = false
      await save('aborted')
      log(prepared.status === 'active' ? '已取消发布并恢复旧目录，入口保持暂停。' : '已取消发布，正式目录未切换。')
      if (aborted.rollbackVerified === false) log('旧目录已恢复但可用性复验失败，请在暂停态检查时效和权限后再恢复入口。')
      return 'aborted'
    }
    requireReply(await remote('activate', release), release, ['active'])
    await save('active')
    await verifyHttps(release, true)
    requireReply(await remote('commit', release), release, ['committed'])
    committed = true
    await save('committed')
    log('正式发布完成，HTTPS 整包大小与 SHA-512 校验通过。')
    return 'committed'
  } catch (error) {
    if (error?.prepareRejected) touched = false
    if (touched && !committed) {
      try {
        const aborted = requireReply(await remote('abort', release), release, ['aborted'])
        await save('aborted')
        log('发布失败，已恢复旧目录；若发生过切换，入口保持暂停。')
        if (aborted.rollbackVerified === false) log('旧目录可用性复验失败，请在暂停态检查时效和权限后再恢复入口。')
      } catch {
        throw new ReleaseError('发布状态不确定：请先在服务器执行暂停，再查询本次事务；不要开始另一次发布。')
      }
    }
    throw error instanceof ReleaseError ? error : new ReleaseError('发布未通过，请按记录核查后重试。')
  }
}
