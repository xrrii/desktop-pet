export interface ScreenshotOverlayPayload {
  displayId: string
  displayLabel: string
  imageDataUrl: string
  imageWidth: number
  imageHeight: number
}

export interface ScreenshotSelectionInput {
  x: number
  y: number
  width: number
  height: number
}
