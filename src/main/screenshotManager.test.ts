import { describe, expect, it } from 'vitest'

import { normalizeScreenshotSelection } from './screenshotManager'

describe('normalizeScreenshotSelection', () => {
  it('会把选区限制在图片范围内', () => {
    expect(
      normalizeScreenshotSelection(
        { x: -20, y: 12, width: 260, height: 120 },
        { width: 200, height: 100 }
      )
    ).toEqual({ x: 0, y: 12, width: 200, height: 88 })
  })

  it('拒绝过小的选区', () => {
    expect(
      normalizeScreenshotSelection(
        { x: 10, y: 10, width: 6, height: 18 },
        { width: 300, height: 200 }
      )
    ).toBeNull()
  })

  it('拒绝非数字输入', () => {
    expect(
      normalizeScreenshotSelection(
        { x: Number.NaN, y: 10, width: 20, height: 20 },
        { width: 300, height: 200 }
      )
    ).toBeNull()
  })
})
