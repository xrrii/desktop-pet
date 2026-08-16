import { describe, expect, it } from 'vitest'
import { ManagedServerClock, managedMaximumTrustedClockOffsetMs } from './managedServerClock'

describe('ManagedServerClock', () => {
  it('使用请求往返中点校正服务端快时钟', () => {
    const clock = new ManagedServerClock(() => Date.parse('2026-08-16T00:00:10Z'))

    clock.observe(
      'Sun, 16 Aug 2026 00:00:15 GMT',
      Date.parse('2026-08-16T00:00:09Z'),
      Date.parse('2026-08-16T00:00:11Z')
    )

    expect(clock.getSnapshot()).toEqual({ offsetMs: 5_000, trusted: true })
    expect(clock.now()).toBe(Date.parse('2026-08-16T00:00:15Z'))
  })

  it('服务端慢时不延长 Token 有效期', () => {
    const localTime = Date.parse('2026-08-16T00:00:10Z')
    const clock = new ManagedServerClock(() => localTime)

    clock.observe(
      'Sun, 16 Aug 2026 00:00:05 GMT',
      Date.parse('2026-08-16T00:00:09Z'),
      Date.parse('2026-08-16T00:00:11Z')
    )

    expect(clock.getSnapshot()).toEqual({ offsetMs: -5_000, trusted: true })
    expect(clock.now()).toBe(localTime)
  })

  it('超过六十秒的偏差只保留诊断状态', () => {
    const localTime = Date.parse('2026-08-16T00:00:00Z')
    const clock = new ManagedServerClock(() => localTime)

    clock.observe(
      'Sun, 16 Aug 2026 00:02:00 GMT',
      localTime,
      localTime
    )

    expect(clock.getSnapshot()).toEqual({
      offsetMs: 2 * managedMaximumTrustedClockOffsetMs,
      trusted: false
    })
    expect(clock.now()).toBe(localTime)
  })
})
