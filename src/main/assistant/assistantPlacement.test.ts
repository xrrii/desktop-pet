import { describe, expect, it } from 'vitest'
import { calculateAssistantPlacement } from './assistantPlacement'

const workArea = { x: 0, y: 0, width: 1920, height: 1040 }

describe('calculateAssistantPlacement', () => {
  it('places the assistant on the left when the pet has left-side space', () => {
    const placement = calculateAssistantPlacement(
      { x: 1680, y: 820, width: 164, height: 177 },
      workArea
    )

    expect(placement.side).toBe('left')
    expect(placement.windowBounds.x).toBe(1152)
    expect(placement.windowBounds.x + placement.pet.x).toBe(1680)
    expect(placement.panel.width).toBe(520)
  })

  it('places the assistant on the right when the pet is near the left edge', () => {
    const placement = calculateAssistantPlacement(
      { x: 24, y: 820, width: 164, height: 177 },
      workArea
    )

    expect(placement.side).toBe('right')
    expect(placement.windowBounds.x).toBe(24)
    expect(placement.panel.x).toBe(172)
    expect(placement.panel.width).toBe(520)
  })

  it('shrinks upward growth near the work-area top while preserving the pet position', () => {
    const placement = calculateAssistantPlacement(
      { x: 900, y: 20, width: 164, height: 177 },
      workArea
    )

    expect(placement.windowBounds.y).toBe(0)
    expect(placement.windowBounds.height).toBe(197)
    expect(placement.windowBounds.y + placement.pet.y).toBe(20)
  })
})
