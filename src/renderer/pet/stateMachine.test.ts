import { describe, expect, it } from 'vitest'
import { PetStateMachine } from './stateMachine'

describe('PetStateMachine', () => {
  it('plays a one-shot action and returns to idle after a loop', () => {
    const machine = new PetStateMachine()

    expect(machine.play('waving')).toBe('waving')
    expect(machine.completeLoop()).toBe('idle')
  })

  it('tracks drag direction and returns to idle when dragging stops', () => {
    const machine = new PetStateMachine()

    expect(machine.setDraggingState(10)).toBe('runningRight')
    expect(machine.setDraggingState(-10)).toBe('runningLeft')
    expect(machine.stopDragging()).toBe('idle')
  })

  it('keeps persistent actions active after a loop', () => {
    const machine = new PetStateMachine()

    expect(machine.play('waiting')).toBe('waiting')
    expect(machine.completeLoop()).toBe('waiting')
  })
})
