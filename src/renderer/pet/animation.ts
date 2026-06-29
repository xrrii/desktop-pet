import type { PetManifest, PetStateName } from './petManifest'

interface PetAnimatorOptions {
  canvas: HTMLCanvasElement
  manifest: PetManifest
  spritesheet: HTMLImageElement
  scale?: number
  onLoopComplete?: (state: PetStateName) => void
}

export class PetAnimator {
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private readonly manifest: PetManifest
  private readonly spritesheet: HTMLImageElement
  private readonly onLoopComplete?: (state: PetStateName) => void
  private state: PetStateName = 'idle'
  private frameIndex = 0
  private lastFrameTime = 0
  private animationFrame = 0
  private pixelRatio = 1
  private readonly scale: number

  constructor(options: PetAnimatorOptions) {
    this.canvas = options.canvas
    this.manifest = options.manifest
    this.spritesheet = options.spritesheet
    this.onLoopComplete = options.onLoopComplete
    this.scale = options.scale && options.scale > 0 ? options.scale : 1

    const context = this.canvas.getContext('2d', { alpha: true })
    if (!context) {
      throw new Error('Canvas 2D context is unavailable.')
    }

    this.context = context
    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  start(): void {
    this.stop()
    this.lastFrameTime = performance.now()
    this.draw()
    this.animationFrame = requestAnimationFrame((time) => this.tick(time))
  }

  stop(): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame)
      this.animationFrame = 0
    }
  }

  setState(nextState: PetStateName): void {
    if (this.state === nextState) {
      return
    }

    this.state = nextState
    this.frameIndex = 0
    this.lastFrameTime = performance.now()
    this.draw()
  }

  private tick(time: number): void {
    const animation = this.manifest.states[this.state]
    const frameDuration = 1000 / animation.fps

    if (time - this.lastFrameTime >= frameDuration) {
      const framesToAdvance = Math.floor((time - this.lastFrameTime) / frameDuration)
      this.lastFrameTime += framesToAdvance * frameDuration
      const previousFrame = this.frameIndex
      this.frameIndex = (this.frameIndex + framesToAdvance) % animation.frames

      if (this.frameIndex <= previousFrame || framesToAdvance >= animation.frames) {
        this.onLoopComplete?.(this.state)
      }

      this.draw()
    }

    this.animationFrame = requestAnimationFrame((nextTime) => this.tick(nextTime))
  }

  private resize(): void {
    const width = this.manifest.atlas.cellWidth
    const height = this.manifest.atlas.cellHeight
    this.pixelRatio = Math.max(window.devicePixelRatio || 1, 1)
    this.canvas.width = Math.round(width * this.pixelRatio)
    this.canvas.height = Math.round(height * this.pixelRatio)
    this.canvas.style.width = `${Math.round(width * this.scale)}px`
    this.canvas.style.height = `${Math.round(height * this.scale)}px`
    this.context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0)
    this.context.imageSmoothingEnabled = true
    this.draw()
  }

  private draw(): void {
    const { cellWidth, cellHeight } = this.manifest.atlas
    const animation = this.manifest.states[this.state]
    const sx = this.frameIndex * cellWidth
    const sy = animation.row * cellHeight

    this.context.clearRect(0, 0, cellWidth, cellHeight)
    this.context.drawImage(
      this.spritesheet,
      sx,
      sy,
      cellWidth,
      cellHeight,
      0,
      0,
      cellWidth,
      cellHeight
    )
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Unable to load image: ${src}`))
    image.src = src
  })
}
