import { shell } from 'electron'
import { spawn } from 'node:child_process'
import type { ToolCall } from '../../shared/assistant'
import { evaluateToolCall, type ToolPolicyResult } from './toolPolicy'

export interface ToolExecutionResult {
  ok: boolean
  result?: unknown
  error?: string
}

/** 执行已经通过策略检查的系统工具，不接受任意 shell 命令。 */
export class AssistantToolHost {
  evaluate(call: ToolCall): ToolPolicyResult {
    return evaluateToolCall(call)
  }

  async execute(policy: ToolPolicyResult): Promise<ToolExecutionResult> {
    if (policy.action === 'deny') {
      return { ok: false, error: policy.error || '工具被策略拒绝。' }
    }

    try {
      if (policy.args.url && typeof policy.args.url === 'string') {
        await shell.openExternal(policy.args.url)
        return { ok: true, result: { opened: policy.args.url } }
      }

      if (policy.args.appId && typeof policy.args.appId === 'string') {
        const command = APP_COMMANDS[policy.args.appId]
        if (!command) {
          return { ok: false, error: '应用不在白名单中。' }
        }
        const child = spawn(command, [], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        return { ok: true, result: { launched: policy.args.appId } }
      }

      if (policy.args.path && typeof policy.args.path === 'string') {
        const error = await shell.openPath(policy.args.path)
        return error ? { ok: false, error } : { ok: true, result: { opened: policy.args.path } }
      }

      return { ok: false, error: '工具参数无法执行。' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

const APP_COMMANDS: Record<string, string> = {
  notepad: 'notepad.exe',
  explorer: 'explorer.exe',
  calculator: 'calc.exe'
}
