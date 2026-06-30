import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { app } from 'electron'
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

interface PetSource {
  root: string
  precedence: number
}

export function getBuiltinPetsRoot(): string {
  return getAssetPath('assets', 'pets')
}

export function getUserPetsRoot(): string {
  return join(app.getPath('userData'), 'pets')
}

export function getResourcesPetsRoot(): string | null {
  if (!app.isPackaged) {
    return null
  }
  return join(process.resourcesPath, 'assets', 'pets')
}

export function ensureUserPetsRoot(): string {
  const root = getUserPetsRoot()
  mkdirSync(root, { recursive: true })
  return root
}

export function listAvailablePets(): AvailablePet[] {
  const pets = new Map<string, AvailablePet>()
  for (const source of getPetSources()) {
    if (!existsSync(source.root)) {
      continue
    }

    for (const entry of readdirSync(source.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue
      }

      const pet = readPetPreview(source.root, entry.name)
      if (pet) {
        pets.set(pet.id, pet)
      }
    }
  }

  return [...pets.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export function isAvailablePet(petId: string): boolean {
  return listAvailablePets().some((pet) => pet.id === petId)
}

export function readPetManifest(petId: string): unknown | null {
  const manifestPath = getPetFilePath(petId, 'pet.json')
  if (!manifestPath) {
    return null
  }

  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

export function readPetSpritesheetDataUrl(petId: string, spritesheetPath: string): string | null {
  const imagePath = getPetFilePath(petId, spritesheetPath)
  if (!imagePath) {
    return null
  }

  try {
    const image = readFileSync(imagePath)
    return `data:${getMimeType(imagePath)};base64,${image.toString('base64')}`
  } catch {
    return null
  }
}

function getPetSources(): PetSource[] {
  const resourcesPetsRoot = getResourcesPetsRoot()
  const sources = [
    { root: getBuiltinPetsRoot(), precedence: 0 },
    { root: ensureUserPetsRoot(), precedence: 2 }
  ]

  if (resourcesPetsRoot) {
    sources.push({ root: resourcesPetsRoot, precedence: 1 })
  }

  return sources.sort((a, b) => a.precedence - b.precedence)
}

function readPetPreview(petsRoot: string, folderName: string): AvailablePet | null {
  const manifestPath = join(petsRoot, folderName, 'pet.json')
  if (!existsSync(manifestPath)) {
    return null
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PetManifestPreview
    const spritesheetPath = manifest.spritesheetPath ?? 'spritesheet.webp'
    if (!getSafeFilePath(petsRoot, folderName, spritesheetPath)) {
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

function getPetFilePath(petId: string, relativePath: string): string | null {
  if (!isSafePathSegment(petId)) {
    return null
  }

  for (const source of [...getPetSources()].reverse()) {
    const filePath = getSafeFilePath(source.root, petId, relativePath)
    if (filePath) {
      return filePath
    }
  }

  return null
}

function getSafeFilePath(petsRoot: string, petId: string, relativePath: string): string | null {
  if (!isSafePathSegment(petId) || !isSafeRelativePath(relativePath)) {
    return null
  }

  const petRoot = resolve(petsRoot, petId)
  const filePath = resolve(petRoot, relativePath)
  if (!isPathInside(filePath, petRoot) || !existsSync(filePath)) {
    return null
  }

  return filePath
}

function isSafePathSegment(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value)
}

function isSafeRelativePath(value: string): boolean {
  const normalized = normalize(value)
  return (
    value.length > 0 &&
    !normalized.startsWith('..') &&
    !normalized.startsWith('\\') &&
    !normalized.includes(`..\\`) &&
    !normalized.includes(':')
  )
}

function isPathInside(filePath: string, root: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedPath = resolve(filePath)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`)
}

function getMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}
