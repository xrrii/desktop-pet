import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { app } from 'electron'
import type { AvailablePet, CreatePetInput } from '../shared/pet'
import { getAssetPath } from './window'

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
      description: manifest.description || '',
      source: petsRoot === getUserPetsRoot() ? 'user' : 'builtin'
    }
  } catch {
    return null
  }
}

/**
 * 使用 Main 选中的图集文件创建用户桌宠目录和最小 manifest。
 */
export function createUserPet(
  input: CreatePetInput,
  sourcePath: string,
  sourceFileName: string
): AvailablePet {
  const petId = input.id.trim()
  const displayName = input.displayName.trim()
  const description = input.description.trim()
  if (!isSafePathSegment(petId)) {
    throw new Error('桌宠 ID 只能使用字母、数字、点号、下划线和连字符。')
  }
  if (!displayName) {
    throw new Error('桌宠名称不能为空。')
  }
  if (isAvailablePet(petId)) {
    throw new Error('该桌宠 ID 已存在，请换一个。')
  }
  if (!existsSync(sourcePath)) {
    throw new Error('所选图集文件不存在，请重新选择。')
  }

  const extension = normalizeSpritesheetExtension(sourceFileName || sourcePath)
  const petRoot = join(ensureUserPetsRoot(), petId)
  const spritesheetPath = `spritesheet${extension}`
  mkdirSync(petRoot, { recursive: true })
  copyFileSync(sourcePath, join(petRoot, spritesheetPath))
  writeFileSync(
    join(petRoot, 'pet.json'),
    JSON.stringify(
      {
        id: petId,
        displayName,
        description,
        spritesheetPath
      },
      null,
      2
    ),
    'utf8'
  )

  return {
    id: petId,
    displayName,
    description,
    source: 'user'
  }
}

/**
 * 删除用户创建的桌宠目录，内置桌宠不允许通过管理页删除。
 */
export function deleteUserPet(petId: string): boolean {
  if (!isSafePathSegment(petId)) {
    return false
  }
  const pet = listAvailablePets().find((item) => item.id === petId)
  if (!pet || pet.source !== 'user') {
    return false
  }
  rmSync(join(getUserPetsRoot(), petId), { recursive: true, force: true })
  return true
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

/**
 * 仅允许当前渲染链路可加载的常见图片格式，目标文件名统一为 spritesheet。
 */
function normalizeSpritesheetExtension(filePath: string): '.png' | '.jpg' | '.jpeg' | '.webp' {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.webp') {
    return extension
  }
  throw new Error('图集文件只支持 png、jpg、jpeg 或 webp。')
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
