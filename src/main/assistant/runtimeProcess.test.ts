import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd()
  }
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: mocks.spawn }
})

import { AssistantRuntimeClient } from './runtimeClient'
import { AssistantRuntimeProcess } from './runtimeProcess'

/** 构造 RuntimeProcess 所需的最小子进程替身，并保留可控的退出行为。 */
function createRuntimeChild(): EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  kill: ReturnType<typeof vi.fn>
} {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn()
  })
  child.kill.mockImplementation(() => {
    child.exitCode = 0
    child.emit('exit', 0, null)
    return true
  })
  return child
}

describe('AssistantRuntimeProcess', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    mocks.spawn.mockReset()
  })

  it('开发模式下等待 Runtime 就绪最多三十秒', async () => {
    vi.useFakeTimers()
    const child = createRuntimeChild()
    mocks.spawn.mockReturnValue(child)
    const statuses: string[] = []
    const runtime = new AssistantRuntimeProcess((status) => statuses.push(status.state))

    const starting = runtime.start()
    const rejection = expect(starting).rejects.toThrow('Assistant Runtime startup timed out.')

    await vi.advanceTimersByTimeAsync(29_999)
    expect(child.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await rejection

    expect(child.kill).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toBe('failed')
  })

  it('冷启动期间停止时等待 client 就绪并执行优雅关闭', async () => {
    const child = createRuntimeChild()
    mocks.spawn.mockReturnValue(child)
    vi.spyOn(AssistantRuntimeClient.prototype, 'health').mockResolvedValue()
    const shutdown = vi.spyOn(AssistantRuntimeClient.prototype, 'shutdown').mockImplementation(async () => {
      child.exitCode = 0
      child.emit('exit', 0, null)
    })
    const statuses: string[] = []
    const runtime = new AssistantRuntimeProcess((status) => statuses.push(status.state))

    const starting = runtime.start()
    const stopping = runtime.stop()
    child.stdout.write(`${JSON.stringify({
      type: 'ready',
      protocolVersion: 1,
      port: 3210,
      pid: 1234,
      backend: 'mock'
    })}\n`)

    await expect(starting).resolves.toBeInstanceOf(AssistantRuntimeClient)
    await stopping

    expect(shutdown).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
    expect(statuses.at(-1)).toBe('stopped')
  })
})
