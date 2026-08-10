import './styles.css'

import type { ScreenshotOverlayPayload } from '../../shared/screenshot'
import {
  clampSelectionRect,
  createSelectionRect,
  hasSelectionArea,
  scaleSelectionRect,
  type PointerPoint,
  type SelectionRect
} from './selection'

const image = requireElement<HTMLImageElement>('#screenshot-image')
const label = requireElement<HTMLElement>('#screenshot-label')
const status = requireElement<HTMLElement>('#screenshot-status')
const selectionBox = requireElement<HTMLElement>('#selection-box')

let overlay: ScreenshotOverlayPayload | null = null
let dragging = false
let submitting = false
let pointerStart: PointerPoint | null = null
let currentSelection: SelectionRect | null = null

void bootstrap()

/** 初始化截图覆盖层内容，并绑定输入事件。 */
async function bootstrap(): Promise<void> {
  overlay = await window.desktopPet.getScreenshotOverlay()
  image.src = overlay.imageDataUrl
  label.textContent = `${overlay.displayLabel} · 拖拽选择区域`
  status.textContent = 'Enter 确认，Esc 取消'

  window.addEventListener('pointerdown', handlePointerDown)
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('contextmenu', (event) => event.preventDefault())
}

/** 记录框选起点，并清空上一轮选区。 */
function handlePointerDown(event: PointerEvent): void {
  if (submitting || event.button !== 0) {
    return
  }
  dragging = true
  pointerStart = { x: event.clientX, y: event.clientY }
  currentSelection = null
  renderSelection(null)
}

/** 在拖拽过程中持续更新当前选区。 */
function handlePointerMove(event: PointerEvent): void {
  if (!dragging || !pointerStart) {
    return
  }
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  currentSelection = clampSelectionRect(
    createSelectionRect(pointerStart, { x: event.clientX, y: event.clientY }),
    viewport
  )
  renderSelection(currentSelection)
}

/** 在鼠标松开时结束拖拽，并提示可确认。 */
function handlePointerUp(event: PointerEvent): void {
  if (!dragging || event.button !== 0) {
    return
  }
  dragging = false
  if (hasSelectionArea(currentSelection)) {
    status.textContent = '已选择区域，按 Enter 确认，Esc 取消'
  } else {
    status.textContent = '拖拽选择区域，按 Esc 取消'
  }
}

/** 处理确认与取消快捷键。 */
function handleKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    void cancelSelection()
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    void confirmSelection()
  }
}

/** 把当前选区同步到可视化蒙层。 */
function renderSelection(selection: SelectionRect | null): void {
  if (!hasSelectionArea(selection)) {
    selectionBox.hidden = true
    return
  }
  selectionBox.hidden = false
  selectionBox.style.left = `${selection.x}px`
  selectionBox.style.top = `${selection.y}px`
  selectionBox.style.width = `${selection.width}px`
  selectionBox.style.height = `${selection.height}px`
}

/** 将视口选区映射成图片像素坐标并提交给主进程。 */
async function confirmSelection(): Promise<void> {
  if (!overlay || !hasSelectionArea(currentSelection) || submitting) {
    return
  }
  submitting = true
  status.textContent = '正在生成截图附件...'
  try {
    const selection = scaleSelectionRect(
      currentSelection,
      { width: window.innerWidth, height: window.innerHeight },
      { width: overlay.imageWidth, height: overlay.imageHeight }
    )
    await window.desktopPet.confirmScreenshotSelection(selection)
  } catch (error) {
    submitting = false
    status.textContent = error instanceof Error ? error.message : String(error)
  }
}

/** 取消当前截图操作。 */
async function cancelSelection(): Promise<void> {
  if (submitting) {
    return
  }
  await window.desktopPet.cancelScreenshotSelection()
}

/** 获取页面中的必需元素。 */
function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Screenshot DOM is missing ${selector}.`)
  }
  return element
}
