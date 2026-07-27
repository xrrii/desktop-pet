export type CommandTrigger = '~' | '$'

export interface AssistantCommandOption {
  id: string
  kind: 'command' | 'skill'
  label: string
  description: string
  inputPrefix: string
  searchText: string
  skillId?: string
}

export interface CommandPaletteState {
  trigger: CommandTrigger | null
  query: string
  tokenStart: number
  options: AssistantCommandOption[]
}

export const ASSISTANT_COMMAND_OPTIONS: AssistantCommandOption[] = [
  {
    id: 'open-website',
    kind: 'command',
    label: '打开网站',
    description: '输入网址后在默认浏览器中打开',
    inputPrefix: '打开网站 ',
    searchText: 'open website 打开网站 网页 url'
  },
  {
    id: 'open-app',
    kind: 'command',
    label: '打开应用',
    description: '输入应用名后打开白名单应用',
    inputPrefix: '打开应用 ',
    searchText: 'open app 打开应用 程序'
  }
]

/** 读取输入框末尾的命令触发符，只在独立 token 中触发菜单。 */
export function getCommandPaletteState(
  value: string,
  skillOptions: AssistantCommandOption[] = []
): CommandPaletteState {
  const match = /(^|\s)([~$])([^\s]*)$/.exec(value)
  if (!match) {
    return { trigger: null, query: '', tokenStart: -1, options: [] }
  }

  const trigger = match[2] as CommandTrigger
  const query = match[3].toLocaleLowerCase()
  const tokenStart = match.index + match[1].length
  const options =
    trigger === '~'
      ? ASSISTANT_COMMAND_OPTIONS.filter((option) =>
          `${option.id} ${option.label} ${option.searchText}`.toLocaleLowerCase().includes(query)
        )
      : skillOptions.filter((option) =>
          `${option.id} ${option.label} ${option.searchText}`.toLocaleLowerCase().includes(query)
        )

  return { trigger, query, tokenStart, options }
}
