import { describe, expect, it } from 'vitest'
import type { AssistantEvent } from '../../shared/assistant'
import { consumeSseBuffer } from './runtimeClient'

describe('consumeSseBuffer', () => {
  it('parses complete events and keeps an incomplete remainder', () => {
    const events: AssistantEvent[] = []
    const complete = JSON.stringify({
      protocolVersion: 1,
      taskId: 'task-1',
      sequence: 1,
      type: 'message_delta',
      payload: { delta: 'hello' }
    })

    const remainder = consumeSseBuffer(
      `data: ${complete}\n\ndata: {"protocolVersion":1`,
      'task-1',
      (event) => events.push(event)
    )

    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ delta: 'hello' })
    expect(remainder).toBe('data: {"protocolVersion":1')
  })

  it('rejects events for another task', () => {
    const event = JSON.stringify({
      protocolVersion: 1,
      taskId: 'other-task',
      sequence: 1,
      type: 'done',
      payload: { finishReason: 'stop' }
    })

    expect(() => consumeSseBuffer(`data: ${event}\n\n`, 'task-1', () => undefined)).toThrow(
      'invalid assistant event'
    )
  })

  it('接受结构化网页来源事件', () => {
    const events: AssistantEvent[] = []
    const event = JSON.stringify({
      protocolVersion: 1,
      taskId: 'task-1',
      sequence: 2,
      type: 'web_sources',
      payload: { sources: [] }
    })

    expect(consumeSseBuffer(`data: ${event}\n\n`, 'task-1', (value) => events.push(value))).toBe('')
    expect(events[0].type).toBe('web_sources')
  })
})
