import type { PetStateName } from './petManifest'

interface DragControllerOptions {
  target: HTMLElement
  onDragMove: (dx: number) => PetStateName
  onDragEnd: () => PetStateName
  onStateChange: (state: PetStateName) => void
  onClick: () => void
  onDoubleClick: () => void
  onContextMenu: () => void
}

interface Point {
  x: number
  y: number
}

const clickDistance = 4

export function attachDragController(options: DragControllerOptions): void {
  let dragging = false
  let pointerId: number | null = null
  let startMouse: Point = { x: 0, y: 0 }
  let grabOffset: Point = { x: 0, y: 0 }
  let dragStarted = false
  let startingDrag = false
  let movingDrag = false
  let moved = false
  let releasingPointerCapture = false
  let clickTimer: number | null = null

  options.target.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    options.onContextMenu()
  })

  options.target.addEventListener('pointerdown', async (event) => {
    if (event.button !== 0) {
      return
    }

    dragging = true
    pointerId = event.pointerId
    dragStarted = false
    startingDrag = false
    movingDrag = false
    moved = false
    grabOffset = { x: event.clientX, y: event.clientY }
    startMouse = { x: event.screenX, y: event.screenY }
    options.target.classList.add('dragging')
    options.target.setPointerCapture(event.pointerId)
  })

  options.target.addEventListener('pointermove', async (event) => {
    if (!dragging || pointerId !== event.pointerId) {
      return
    }

    if ((event.buttons & 1) !== 1) {
      const didDrag = await finishDrag()
      if (didDrag) {
        resetPetPlacement(options.target)
        options.onStateChange(options.onDragEnd())
      }
      return
    }

    const pointerDx = event.screenX - startMouse.x
    const pointerDy = event.screenY - startMouse.y

    if (Math.abs(pointerDx) > clickDistance || Math.abs(pointerDy) > clickDistance) {
      moved = true
    }

    if (moved && !dragStarted && !startingDrag) {
      startingDrag = true
      const position = await window.desktopPet.beginDragAt(grabOffset.x, grabOffset.y)
      startingDrag = false
      if (!dragging || pointerId !== event.pointerId) {
        if (position) {
          void window.desktopPet.endDrag()
        }
        return
      }
      if (!position) {
        await finishDrag()
        options.onStateChange(options.onDragEnd())
        return
      }
      dragStarted = true
    }

    if (!dragStarted) {
      return
    }

    if (movingDrag) {
      return
    }

    movingDrag = true
    const dragResult = await window.desktopPet.dragWindow()
    movingDrag = false
    if (!dragging || pointerId !== event.pointerId) {
      return
    }
    if (dragResult) {
      options.onStateChange(options.onDragMove(dragResult.totalDx))
    }
  })

  options.target.addEventListener('pointerup', async (event) => {
    if (!dragging || pointerId !== event.pointerId) {
      return
    }

    const didDrag = await finishDrag(event)
    if (moved) {
      if (didDrag) {
        resetPetPlacement(options.target)
        options.onStateChange(options.onDragEnd())
      }
      return
    }

    if (clickTimer) {
      window.clearTimeout(clickTimer)
      clickTimer = null
      options.onDoubleClick()
      return
    }

    clickTimer = window.setTimeout(() => {
      clickTimer = null
      options.onClick()
    }, 220)
  })

  options.target.addEventListener('pointercancel', async (event) => {
    if (!dragging || pointerId !== event.pointerId) {
      return
    }
    const didDrag = await finishDrag(event)
    if (didDrag) {
      resetPetPlacement(options.target)
      options.onStateChange(options.onDragEnd())
    }
  })

  options.target.addEventListener('lostpointercapture', async () => {
    if (releasingPointerCapture) {
      releasingPointerCapture = false
      return
    }

    if (!dragging) {
      return
    }
    const didDrag = await finishDrag()
    if (didDrag) {
      resetPetPlacement(options.target)
      options.onStateChange(options.onDragEnd())
    }
  })

  window.addEventListener('pointerup', async () => {
    if (!dragging) {
      return
    }
    const didDrag = await finishDrag()
    if (didDrag) {
      resetPetPlacement(options.target)
      options.onStateChange(options.onDragEnd())
    }
  })

  window.addEventListener('mouseup', async () => {
    if (!dragging) {
      return
    }
    const didDrag = await finishDrag()
    if (didDrag) {
      resetPetPlacement(options.target)
      options.onStateChange(options.onDragEnd())
    }
  })

  window.addEventListener('blur', async () => {
    if (!dragging) {
      return
    }
    const didDrag = await finishDrag()
    if (didDrag) {
      resetPetPlacement(options.target)
      options.onStateChange(options.onDragEnd())
    }
  })

  async function finishDrag(event?: PointerEvent): Promise<boolean> {
    const currentPointerId = pointerId
    const didDrag = dragStarted
    dragging = false
    pointerId = null
    dragStarted = false
    startingDrag = false
    movingDrag = false
    options.target.classList.remove('dragging')
    if (didDrag) {
      await window.desktopPet.endDrag()
    }
    const pointerToRelease = event?.pointerId ?? currentPointerId
    if (pointerToRelease !== null && options.target.hasPointerCapture(pointerToRelease)) {
      releasingPointerCapture = true
      options.target.releasePointerCapture(pointerToRelease)
    }
    return didDrag
  }
}

function resetPetPlacement(target: HTMLElement): void {
  target.style.transform = ''
}
