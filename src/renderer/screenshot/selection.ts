export interface PointerPoint {
  x: number
  y: number
}

export interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

/** 把起止坐标转换成从左上角开始的矩形。 */
export function createSelectionRect(start: PointerPoint, end: PointerPoint): SelectionRect {
  const left = Math.min(start.x, end.x)
  const top = Math.min(start.y, end.y)
  const right = Math.max(start.x, end.x)
  const bottom = Math.max(start.y, end.y)
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  }
}

/** 把选区限制在当前截图窗口内，避免出现负值或越界。 */
export function clampSelectionRect(
  rect: SelectionRect,
  viewport: { width: number; height: number }
): SelectionRect {
  const x = clamp(rect.x, 0, viewport.width)
  const y = clamp(rect.y, 0, viewport.height)
  const right = clamp(rect.x + rect.width, x, viewport.width)
  const bottom = clamp(rect.y + rect.height, y, viewport.height)
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  }
}

/** 按图片与视口的缩放关系，把 CSS 像素选区映射成图片像素坐标。 */
export function scaleSelectionRect(
  rect: SelectionRect,
  viewport: { width: number; height: number },
  image: { width: number; height: number }
): SelectionRect {
  const scaleX = image.width / Math.max(1, viewport.width)
  const scaleY = image.height / Math.max(1, viewport.height)
  return {
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.round(rect.width * scaleX),
    height: Math.round(rect.height * scaleY)
  }
}

/** 只在存在正面积时认为用户已经完成了有效框选。 */
export function hasSelectionArea(rect: SelectionRect | null): rect is SelectionRect {
  return !!rect && rect.width > 0 && rect.height > 0
}

/** 把任意坐标约束在视口范围内。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
