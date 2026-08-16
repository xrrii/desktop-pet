import { describe, expect, it } from 'vitest'
import { ManagedOAuthLoopbackSession } from './managedOAuthLoopback'

describe('ManagedOAuthLoopbackSession', () => {
  it('绑定 127.0.0.1 随机端口并一次性消费合法回调', async () => {
    const session = await ManagedOAuthLoopbackSession.listen(2_000)
    expect(session.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)
    session.setExpectedState('state-1')

    const callback = fetch(`${session.redirectUri}?code=code-1&state=state-1`)
    await expect(callback).resolves.toMatchObject({ status: 200 })
    await expect(session.waitForCallback()).resolves.toMatchObject({
      pathname: '/oauth/callback'
    })
  })

  it('拒绝错误路径和 state，并在失败后关闭监听器', async () => {
    const session = await ManagedOAuthLoopbackSession.listen(2_000)
    session.setExpectedState('expected')
    const pending = session.waitForCallback()
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'invalid_callback' })
    await expect(fetch(`${session.redirectUri.replace('/oauth/callback', '/wrong')}?code=x&state=expected`))
      .resolves.toMatchObject({ status: 400 })
    await rejection

    const stateSession = await ManagedOAuthLoopbackSession.listen(2_000)
    stateSession.setExpectedState('expected')
    const statePending = stateSession.waitForCallback()
    const stateRejection = expect(statePending).rejects.toMatchObject({ reason: 'invalid_callback' })
    await expect(fetch(`${stateSession.redirectUri}?code=x&state=wrong`)).resolves.toMatchObject({ status: 400 })
    await stateRejection
  })

  it('支持超时和取消且不会留下等待中的 Promise', async () => {
    const timedOut = await ManagedOAuthLoopbackSession.listen(10)
    await expect(timedOut.waitForCallback()).rejects.toMatchObject({ reason: 'timed_out' })

    const cancelled = await ManagedOAuthLoopbackSession.listen(2_000)
    const pending = cancelled.waitForCallback()
    cancelled.cancel()
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
  })
})
