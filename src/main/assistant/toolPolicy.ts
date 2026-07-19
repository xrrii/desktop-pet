import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ToolCall, ToolRisk } from '../../shared/assistant'

export type ToolPolicyAction = 'execute' | 'confirm' | 'deny'

export interface ToolPolicyResult {
  action: ToolPolicyAction
  risk: ToolRisk
  args: Record<string, unknown>
  preview: string
  error?: string
}

export const SAFE_APP_IDS = new Set(['notepad', 'explorer', 'calculator'])

/** 对 Runtime 的工具请求重新校验，Runtime 提供的 risk 字段不参与权限判断。 */
export function evaluateToolCall(call: ToolCall): ToolPolicyResult {
  const args = asRecord(call.args)
  if (!args) {
    return denied('工具参数必须是对象。')
  }

  if (call.name === 'open_url') {
    const url = readString(args.url, 4_096)
    if (!url) {
      return denied('网页地址无效。')
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return denied('只允许打开 http 或 https 网页。')
      }
    } catch {
      return denied('网页地址无效。')
    }
    return {
      action: 'execute',
      risk: 'safe',
      args: { url },
      preview: `打开网页：${url}`
    }
  }

  if (call.name === 'open_app') {
    const appId = readString(args.appId, 128)?.toLowerCase()
    if (!appId || !SAFE_APP_IDS.has(appId)) {
      return denied('应用不在 PetDock 白名单中。')
    }
    return {
      action: 'confirm',
      risk: 'confirm',
      args: { appId },
      preview: `打开应用：${appId}`
    }
  }

  if (call.name === 'open_file_or_folder') {
    const path = readString(args.path, 4_096)
    if (!path) {
      return denied('文件或文件夹路径无效。')
    }
    const resolvedPath = resolve(path)
    if (!existsSync(resolvedPath)) {
      return denied('文件或文件夹不存在。')
    }
    let realPath: string
    try {
      realPath = realpathSync.native(resolvedPath)
    } catch {
      return denied('无法解析文件或文件夹路径。')
    }
    return {
      action: 'confirm',
      risk: 'confirm',
      args: { path: realPath },
      preview: `打开路径：${realPath}`
    }
  }

  return denied('工具未注册或当前版本不支持。')
}

function denied(error: string): ToolPolicyResult {
  return { action: 'deny', risk: 'dangerous', args: {}, preview: '拒绝执行工具', error }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function readString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maxLength ? trimmed : null
}
