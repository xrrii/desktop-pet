import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfigPath, runProcess } from './io.mjs'
import { ReleaseError } from './core.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const taskName = 'PetDock-Desktop-Manifest-Renewal'

/** 所有参数是本机文件路径，不允许插入任务参数或 PowerShell 表达式。 */
function requirePath(value) {
  if (!isAbsolute(value) || /["\r\n\0]/.test(value)) throw new ReleaseError('任务路径必须为不含引号的绝对路径。')
  return value
}

/** 生成固定任务定义；只在当前用户登录时运行，不保存账号密码或私钥正文。 */
export function taskScript(action, config, node = process.execPath, repository = root) {
  if (!['install', 'status', 'remove'].includes(action)) throw new ReleaseError('任务操作无效。')
  const literal = (value) => `'${value.replaceAll("'", "''")}'`
  const runner = requirePath(join(repository, 'tools', 'desktop-release', 'renewal_task.mjs'))
  requirePath(config); requirePath(node); requirePath(repository)
  const prelude = `$ErrorActionPreference = 'Stop'\n$taskName = ${literal(taskName)}\n`
  if (action === 'status') return prelude + 'Get-ScheduledTask -TaskName $taskName -ErrorAction Stop | Get-ScheduledTaskInfo | Select-Object LastRunTime,LastTaskResult,NextRunTime | ConvertTo-Json -Compress\n'
  if (action === 'remove') return prelude + 'Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop\n'
  return prelude + `
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute ${literal(node)} -Argument ${literal(`"${runner}" --run --config "${config}"`)} -WorkingDirectory ${literal(repository)}
$daily = New-ScheduledTaskTrigger -Daily -At '10:00'
$logon = New-ScheduledTaskTrigger -AtLogOn -User $identity
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($daily, $logon) -Settings $settings -Principal $principal -Description 'PetDock：每日及登录后检查当前版清单，剩余不足14天时续签；保留人工暂停。' -Force | Out-Null
`
}

/** 只保留三十天维护日志；错误仅记录固定中文，不记录密钥、参数和服务器原始输出。 */
export async function runScheduled(config, execute = runProcess, repository = root) {
  const directory = join(repository, 'release-runs', 'maintenance-logs')
  await mkdir(directory, { recursive: true })
  const now = new Date()
  const file = join(directory, `${now.toISOString().slice(0, 10)}.log`)
  try {
    const output = await execute(process.execPath, [join(repository, 'tools', 'release_desktop.mjs'),
      '--renew', '--if-due', '--config', requirePath(config)], { cwd: repository, timeout: 240_000 })
    await appendFile(file, `${now.toISOString()} ${output.trim()}\n`, 'utf8')
  } catch (error) {
    // 子命令输出只提取固定格式的公开 UUID；底层错误和其他正文仍不进入维护日志。
    const releaseId = typeof error.output === 'string'
      ? error.output.match(/续签事务：([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})/)?.[1] : null
    const recovery = releaseId ? `事务 ${releaseId}，先用 --status 查询或 --resume 恢复。`
      : '请手动执行 --renew 查看诊断；中断时从 release-runs 最新事务目录核对编号。'
    await appendFile(file, `${now.toISOString()} 自动续签失败，${recovery}\n`, 'utf8')
    throw new ReleaseError('自动续签失败；请查看 release-runs/maintenance-logs，并核对任务计划程序的运行结果。')
  }
  for (const name of await readdir(directory)) {
    if (/^\d{4}-\d{2}-\d{2}\.log$/.test(name) && now.getTime() - Date.parse(name.slice(0, 10)) > 30 * 86_400_000) {
      await unlink(join(directory, name))
    }
  }
}

/** 安装动作只在用户明确运行 --install 时执行；--describe 仅输出定义供审阅。 */
async function main(args) {
  const action = args[0]
  if (args.length !== 1 && !(args.length === 3 && args[1] === '--config') ||
      !['--install', '--status', '--remove', '--describe', '--run'].includes(action)) {
    throw new ReleaseError('用法：node tools/desktop-release/renewal_task.mjs --install|--status|--remove|--describe [--config 仓库外配置路径]')
  }
  const config = requirePath(args[2] ?? defaultConfigPath())
  if (action === '--run') return runScheduled(config)
  const script = taskScript(action === '--describe' ? 'install' : action.slice(2), config)
  if (action === '--describe') { console.log(script); return }
  if (process.platform !== 'win32') throw new ReleaseError('定时任务仅支持 Windows。')
  // UTF-16LE 编码命令让 Windows PowerShell 5.1 正确读取中文，并避免 shell 拼接。
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = await runProcess(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
  console.log(action === '--status' ? output.trim() : action === '--install' ? '当前账号的每日续签任务已安装；请按指南检查首次运行结果。' : '续签任务已移除，历史日志保留。')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof ReleaseError ? error.message : '续签任务操作失败，请检查本机任务计划权限。'); process.exitCode = 1 }
}
