export type PetStateName =
  | 'idle'
  | 'runningRight'
  | 'runningLeft'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

export interface AnimationState {
  row: number
  frames: number
  fps: number
}

export interface PetManifest {
  id: string
  displayName: string
  description: string
  spritesheetPath: string
  atlas: {
    columns: number
    rows: number
    cellWidth: number
    cellHeight: number
    width: number
    height: number
  }
  states: Record<PetStateName, AnimationState>
}

export async function loadPetManifest(petId = 'hammer-dude'): Promise<PetManifest> {
  const response = await fetch(`./pets/${petId}/pet.json`)
  if (!response.ok) {
    throw new Error(`Unable to load pet manifest: ${response.status}`)
  }
  const manifest = (await response.json()) as Partial<PetManifest>
  return normalizePetManifest(manifest, petId)
}

export function getSpritesheetUrl(manifest: PetManifest): string {
  return `./pets/${manifest.id}/${manifest.spritesheetPath}`
}

function normalizePetManifest(manifest: Partial<PetManifest>, fallbackId: string): PetManifest {
  return {
    id: fallbackId,
    displayName: manifest.displayName ?? fallbackId,
    description: manifest.description ?? '',
    spritesheetPath: manifest.spritesheetPath ?? 'spritesheet.webp',
    atlas: manifest.atlas ?? {
      columns: 8,
      rows: 9,
      cellWidth: 192,
      cellHeight: 208,
      width: 1536,
      height: 1872
    },
    states: {
      ...defaultStates,
      ...manifest.states
    }
  }
}

const defaultStates: Record<PetStateName, AnimationState> = {
  idle: { row: 0, frames: 6, fps: 6 },
  runningRight: { row: 1, frames: 8, fps: 10 },
  runningLeft: { row: 2, frames: 8, fps: 10 },
  waving: { row: 3, frames: 4, fps: 6 },
  jumping: { row: 4, frames: 5, fps: 8 },
  failed: { row: 5, frames: 8, fps: 6 },
  waiting: { row: 6, frames: 6, fps: 5 },
  running: { row: 7, frames: 6, fps: 7 },
  review: { row: 8, frames: 6, fps: 6 }
}
