import test from 'node:test'
import assert from 'node:assert/strict'
import { checkAndBuild, compareVersions, publishRelease, requireVersion } from './core.mjs'

const release = { releaseId: 'ce7f963a-c616-419d-a60b-d1656ba38d0b', version: '0.2.5', artifact: { size: 123, sha512: 'synthetic' } }

for (const failure of ['check', 'dist']) {
  test(`${failure}失败时不执行后续构建或归档`, async () => {
    const calls = []
    const step = (name) => async () => { calls.push(name); if (failure === name) throw new Error('synthetic') }
    await assert.rejects(checkAndBuild({ check: step('check'), dist: step('dist'), archive: step('archive') }))
    assert.deepEqual(calls, failure === 'check' ? ['check'] : ['check', 'dist'])
  })
}

/** 合成服务器记录各动作，不启动 SSH、不改正式目录。 */
function scenario({ initial = 'prepared', accepted = true, failAction, failHttps = false, failAbort = false, mismatch = false } = {}) {
  const calls = []
  return { calls, dependencies: {
    remote: async (action) => {
      calls.push(action)
      if (failAction === action || action === 'abort' && failAbort) throw new Error('synthetic')
      return { schemaVersion: 1, ...release, status: { prepare: initial, activate: 'active', commit: 'committed', abort: 'aborted' }[action],
        ...(mismatch && action === 'prepare' ? { version: '0.2.6' } : {}) }
    },
    confirm: async () => { calls.push('confirm'); return accepted },
    verifyHttps: async (_, full) => { calls.push(full ? 'https-full' : 'https-metadata'); if (failHttps) throw new Error('synthetic') },
    save: async (phase) => { calls.push(`save:${phase}`) }, log: () => {}
  } }
}

test('先人工确认，再激活、整包校验和提交', async () => {
  const flow = scenario()
  assert.equal(await publishRelease(release, flow.dependencies), 'committed')
  assert.deepEqual(flow.calls, ['prepare', 'save:prepared', 'confirm', 'activate', 'save:active', 'https-full', 'commit', 'save:committed'])
})

test('人工取消准备态只终止事务，不激活或发链', async () => {
  const flow = scenario({ accepted: false })
  assert.equal(await publishRelease(release, flow.dependencies), 'aborted')
  assert.deepEqual(flow.calls, ['prepare', 'save:prepared', 'confirm', 'abort', 'save:aborted'])
})

for (const action of ['prepare', 'activate', 'commit']) {
  test(`${action}断线后尝试恢复并暂停，不宣称发布成功`, async () => {
    const flow = scenario({ failAction: action })
    await assert.rejects(publishRelease(release, flow.dependencies))
    assert.ok(flow.calls.includes('abort'))
    assert.ok(!flow.calls.includes('save:committed'))
  })
}

test('完整HTTPS摘要失败会恢复并暂停，不提交', async () => {
  const flow = scenario({ failHttps: true })
  await assert.rejects(publishRelease(release, flow.dependencies))
  assert.deepEqual(flow.calls.slice(-2), ['abort', 'save:aborted'])
  assert.ok(!flow.calls.includes('commit'))
})

test('准备阶段明确拒绝不误报需要回退或修改运维暂停', async () => {
  const flow = scenario()
  flow.dependencies.remote = async () => { throw Object.assign(new Error('synthetic rejection'), { prepareRejected: true }) }
  await assert.rejects(publishRelease(release, flow.dependencies))
  assert.deepEqual(flow.calls, [])
})

test('恢复请求也断线时明确要求服务器暂停和查事务', async () => {
  const flow = scenario({ failHttps: true, failAbort: true })
  await assert.rejects(publishRelease(release, flow.dependencies), /状态不确定/)
  assert.ok(!flow.calls.includes('save:aborted'))
})

test('响应绑定错误版本时终止并恢复', async () => {
  const flow = scenario({ mismatch: true })
  await assert.rejects(publishRelease(release, flow.dependencies), /不一致/)
  assert.ok(!flow.calls.includes('confirm'))
})

test('激活后断线的恢复要重新确认并完整验收', async () => {
  const flow = scenario({ initial: 'active' })
  assert.equal(await publishRelease(release, flow.dependencies), 'committed')
  assert.ok(flow.calls.includes('confirm'))
  assert.ok(flow.calls.includes('https-full'))
})

test('服务器已提交的恢复不再签发安装包链接', async () => {
  const flow = scenario({ initial: 'committed' })
  assert.equal(await publishRelease(release, flow.dependencies), 'committed')
  assert.deepEqual(flow.calls, ['prepare', 'https-metadata', 'save:committed'])
})

test('已提交事务复验失败不错误回退已完成发布', async () => {
  const flow = scenario({ initial: 'committed', failHttps: true })
  await assert.rejects(publishRelease(release, flow.dependencies))
  assert.ok(!flow.calls.includes('abort'))
})

test('版本按三段整数比较并拒绝预发布、前导零、超大整数', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1)
  assert.equal(compareVersions('1.0.0', '0.9.99'), 1)
  assert.equal(compareVersions('0.2.4', '0.2.4'), 0)
  for (const value of ['0.02.5', '0.2.5-beta', '0.2', '9007199254740992.0.0', null]) assert.throws(() => requireVersion(value))
})
