import { describe, expect, it } from 'vitest'
import { normalizePetManifest } from './petManifest'

describe('normalizePetManifest', () => {
  it('fills the default atlas and animation states', () => {
    const manifest = normalizePetManifest({}, 'test-pet')

    expect(manifest.id).toBe('test-pet')
    expect(manifest.spritesheetPath).toBe('spritesheet.webp')
    expect(manifest.atlas).toEqual({
      columns: 8,
      rows: 9,
      cellWidth: 192,
      cellHeight: 208,
      width: 1536,
      height: 1872
    })
    expect(manifest.states.idle).toEqual({ row: 0, frames: 6, fps: 6 })
  })

  it('preserves provided metadata and merges state overrides', () => {
    const manifest = normalizePetManifest(
      {
        displayName: 'Test Pet',
        states: {
          idle: { row: 2, frames: 3, fps: 4 }
        }
      },
      'test-pet'
    )

    expect(manifest.displayName).toBe('Test Pet')
    expect(manifest.states.idle).toEqual({ row: 2, frames: 3, fps: 4 })
    expect(manifest.states.jumping).toEqual({ row: 4, frames: 5, fps: 8 })
  })
})
