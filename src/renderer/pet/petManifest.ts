import type {
  AnimationState,
  PetManifest,
  PetManifestInput,
  PetStateName
} from '../../shared/pet'

export type { AnimationState, PetManifest, PetManifestInput, PetStateName } from '../../shared/pet'

export async function loadPetManifest(petId = 'hammer-dude'): Promise<PetManifest> {
  const manifest = await window.desktopPet.loadPetManifest(petId)
  if (!manifest) {
    throw new Error(`Unable to load pet manifest: ${petId}`)
  }
  return normalizePetManifest(manifest, petId)
}

export async function loadPetSpritesheetUrl(manifest: PetManifest): Promise<string> {
  const spritesheetUrl = await window.desktopPet.loadPetSpritesheet(
    manifest.id,
    manifest.spritesheetPath
  )
  if (!spritesheetUrl) {
    throw new Error(`Unable to load pet spritesheet: ${manifest.id}/${manifest.spritesheetPath}`)
  }
  return spritesheetUrl
}

export function normalizePetManifest(
  manifest: PetManifestInput,
  fallbackId: string
): PetManifest {
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
