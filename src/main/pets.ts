import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAssetPath } from './window'

export interface AvailablePet {
  id: string
  displayName: string
  description: string
}

interface PetManifestPreview {
  id?: string
  displayName?: string
  description?: string
  spritesheetPath?: string
}

export function listAvailablePets(): AvailablePet[] {
  const petsRoot = getAssetPath('assets', 'pets')
  if (!existsSync(petsRoot)) {
    return []
  }

  return readdirSync(petsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readPetPreview(petsRoot, entry.name))
    .filter((pet): pet is AvailablePet => pet !== null)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export function isAvailablePet(petId: string): boolean {
  return listAvailablePets().some((pet) => pet.id === petId)
}

function readPetPreview(petsRoot: string, folderName: string): AvailablePet | null {
  const manifestPath = join(petsRoot, folderName, 'pet.json')
  if (!existsSync(manifestPath)) {
    return null
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PetManifestPreview
    const spritesheetPath = manifest.spritesheetPath ?? 'spritesheet.webp'
    if (!existsSync(join(petsRoot, folderName, spritesheetPath))) {
      return null
    }

    return {
      id: folderName,
      displayName: manifest.displayName || manifest.id || folderName,
      description: manifest.description || ''
    }
  } catch {
    return null
  }
}
