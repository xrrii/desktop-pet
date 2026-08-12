import type { AssistantThemeId } from './theme'

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

export type PetAction = PetStateName

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

export interface PetManifestInput extends Omit<Partial<PetManifest>, 'states'> {
  states?: Partial<Record<PetStateName, AnimationState>>
}

export interface PetSettings {
  settingsVersion: number
  petId: string
  position: WindowPosition | null
  scale: number
  alwaysOnTop: boolean
  clickThrough: boolean
  launchAtStartup: boolean
  assistantTheme: AssistantThemeId
  assistantKnowledgeLibraryIds: string[]
}

export interface AvailablePet {
  id: string
  displayName: string
  description: string
  source: 'builtin' | 'user'
}

export interface PetSpritesheetSelection {
  token: string
  fileName: string
}

export interface CreatePetInput {
  id: string
  displayName: string
  description: string
  spritesheetToken: string
  makeCurrent?: boolean
}

export interface WindowPosition {
  x: number
  y: number
}

export interface DragMoveResult extends WindowPosition {
  totalDx: number
  totalDy: number
  localX: number
  localY: number
}
