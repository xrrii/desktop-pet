import type { BrowserWindow } from 'electron'
import { isAssistantThemeId, type AssistantThemeId } from '../shared/theme'
import { updateSettings } from './store'

/** 更新并广播助手主题，主题切换不需要重启 renderer。 */
export function setAssistantTheme(window: BrowserWindow, value: unknown): AssistantThemeId {
  if (!isAssistantThemeId(value)) {
    throw new TypeError('助手主题无效。')
  }
  updateSettings({ assistantTheme: value })
  window.webContents.send('assistant:theme', value)
  return value
}
