import type { AssistantDockSide } from '../../shared/assistant'

export const ASSISTANT_MAX_WIDTH = 520
export const ASSISTANT_MIN_WIDTH = 300
export const ASSISTANT_HEIGHT = 430
export const PET_GAP = 8

export interface AssistantPlacement {
  side: AssistantDockSide
  windowBounds: Electron.Rectangle
  pet: Electron.Rectangle
  panel: Electron.Rectangle
}

export function calculateAssistantPlacement(
  petBounds: Electron.Rectangle,
  workArea: Electron.Rectangle
): AssistantPlacement {
  const leftSpace = petBounds.x - workArea.x - PET_GAP
  const rightSpace =
    workArea.x + workArea.width - (petBounds.x + petBounds.width) - PET_GAP
  const side: AssistantDockSide =
    leftSpace >= ASSISTANT_MIN_WIDTH || leftSpace >= rightSpace ? 'left' : 'right'
  const availableWidth = side === 'left' ? leftSpace : rightSpace
  const panelWidth = Math.max(1, Math.min(ASSISTANT_MAX_WIDTH, availableWidth))
  const availableHeightAbovePetBottom = petBounds.y + petBounds.height - workArea.y
  const height = Math.min(
    ASSISTANT_HEIGHT,
    Math.max(petBounds.height, availableHeightAbovePetBottom)
  )
  const windowX = side === 'left' ? petBounds.x - panelWidth - PET_GAP : petBounds.x
  const windowY = petBounds.y + petBounds.height - height
  const petX = side === 'left' ? panelWidth + PET_GAP : 0
  const panelX = side === 'left' ? 0 : petBounds.width + PET_GAP

  return {
    side,
    windowBounds: {
      x: Math.round(windowX),
      y: Math.round(windowY),
      width: Math.round(panelWidth + PET_GAP + petBounds.width),
      height: Math.round(height)
    },
    pet: {
      x: Math.round(petX),
      y: Math.round(height - petBounds.height),
      width: petBounds.width,
      height: petBounds.height
    },
    panel: {
      x: Math.round(panelX),
      y: 0,
      width: Math.round(panelWidth),
      height: Math.round(height)
    }
  }
}
