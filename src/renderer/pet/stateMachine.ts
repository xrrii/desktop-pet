import type { PetStateName } from './petManifest'

const oneShotStates = new Set<PetStateName>(['waving', 'jumping'])
const dragDirectionThreshold = 1

export class PetStateMachine {
  private currentState: PetStateName = 'idle'
  private lockedState: PetStateName | null = null
  private dragging = false

  get state(): PetStateName {
    return this.currentState
  }

  setDraggingState(dx: number): PetStateName {
    this.dragging = true
    this.lockedState = null
    if (dx > dragDirectionThreshold) {
      return this.setState('runningRight')
    }
    if (dx < -dragDirectionThreshold) {
      return this.setState('runningLeft')
    }
    return this.currentState
  }

  stopDragging(): PetStateName {
    this.dragging = false
    if (!this.lockedState) {
      return this.setState('idle')
    }
    return this.currentState
  }

  play(state: PetStateName): PetStateName {
    this.dragging = false
    this.lockedState = oneShotStates.has(state) ? state : null
    return this.setState(state)
  }

  completeLoop(): PetStateName {
    if (this.lockedState && this.currentState === this.lockedState) {
      this.lockedState = null
      return this.setState('idle')
    }
    if (this.dragging) {
      return this.currentState
    }
    return this.currentState
  }

  private setState(state: PetStateName): PetStateName {
    this.currentState = state
    return this.currentState
  }
}
