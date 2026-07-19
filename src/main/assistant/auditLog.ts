import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ToolAuditEntry {
  taskId: string
  toolCallId: string
  toolName: string
  args: unknown
  risk: string
  policyDecision: string
  userDecision?: string
  ok?: boolean
  error?: string
  durationMs?: number
}

/** 将工具执行过程写入单独审计日志，便于排查且不影响主流程。 */
export function writeToolAudit(entry: ToolAuditEntry): void {
  try {
    const path = join(app.getPath('userData'), 'logs', 'tools.log')
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(
      path,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry }, replacer)}\n`,
      'utf8'
    )
  } catch {
    // 审计日志失败不能阻断工具执行流程。
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (_key === 'path' && typeof value === 'string') {
    return `[路径已隐藏]\\${value.split(/[\\/]/).pop() || ''}`
  }
  if (_key === 'url' && typeof value === 'string') {
    try {
      const url = new URL(value)
      return `${url.origin}${url.pathname}`
    } catch {
      return '[无效 URL]'
    }
  }
  if (typeof value === 'string' && value.length > 1_000) {
    return `${value.slice(0, 1_000)}...[truncated]`
  }
  return value
}
