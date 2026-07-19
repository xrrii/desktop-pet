export const ASSISTANT_THEME_OPTIONS = [
  { id: 'quiet', label: '雾白实用' },
  { id: 'note', label: '墨线便笺' },
  { id: 'glass', label: '夜航玻璃' },
  { id: 'pixel', label: '像素伙伴' },
  { id: 'apple', label: '苹果毛玻璃' }
] as const

export type AssistantThemeId = (typeof ASSISTANT_THEME_OPTIONS)[number]['id']

export function isAssistantThemeId(value: unknown): value is AssistantThemeId {
  return ASSISTANT_THEME_OPTIONS.some((theme) => theme.id === value)
}
