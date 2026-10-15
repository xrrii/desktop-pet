import { ReleaseError, requireVersion } from './core.mjs'

export const RELEASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** 发布与续签模式互斥；自动维护不能同时执行旧目录迁移。 */
export function parseArguments(args, defaultConfig) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const values = new Map()
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (values.has(name)) throw new ReleaseError('参数重复。')
    if (['--renew', '--if-due', '--migrate-current'].includes(name)) values.set(name, true)
    else if (['--version', '--resume', '--status', '--abort', '--config'].includes(name)) {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new ReleaseError('参数缺少值。')
      values.set(name, value)
    } else throw new ReleaseError('参数无效，请运行 npm run release:desktop -- --help 查看用法。')
  }
  const modes = ['--version', '--resume', '--status', '--abort', '--renew'].filter((name) => values.has(name))
  if (modes.length !== 1) throw new ReleaseError('必须且只能指定一种发布或续签操作。')
  const mode = modes[0].slice(2)
  if ((values.has('--if-due') || values.has('--migrate-current')) && mode !== 'renew' ||
      values.has('--if-due') && values.has('--migrate-current')) throw new ReleaseError('自动续签和交互迁移参数不能混用。')
  const value = values.get(modes[0])
  if (mode === 'version') requireVersion(value)
  else if (mode !== 'renew' && !RELEASE_ID_PATTERN.test(value)) throw new ReleaseError('事务编号必须来自本命令输出的 UUID。')
  return { mode, value, config: values.get('--config') ?? defaultConfig,
    ifDue: values.has('--if-due'), migration: values.has('--migrate-current') }
}
