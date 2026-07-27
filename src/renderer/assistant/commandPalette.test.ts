import { describe, expect, it } from 'vitest'
import { getCommandPaletteState, type AssistantCommandOption } from './commandPalette'

const skills: AssistantCommandOption[] = [
  {
    id: 'weekly-report',
    kind: 'skill',
    label: 'weekly-report',
    description: '整理结构化周报',
    inputPrefix: '',
    searchText: 'weekly report 周报',
    skillId: 'weekly-report'
  }
]

describe('助手命令菜单', () => {
  it('继续支持波浪号内置命令', () => {
    const state = getCommandPaletteState('请帮我 ~网站')
    expect(state.trigger).toBe('~')
    expect(state.options[0]?.id).toBe('open-website')
  })

  it('美元符号只检索传入的已启用 Skill 元数据', () => {
    const state = getCommandPaletteState('$周报', skills)
    expect(state.trigger).toBe('$')
    expect(state.options).toHaveLength(1)
    expect(state.options[0]?.skillId).toBe('weekly-report')
  })
})
