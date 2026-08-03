import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ToolCall, ToolRisk } from '../../shared/assistant'
import { validateWebUrl } from './webNetworkPolicy'

export type ToolPolicyAction = 'execute' | 'confirm' | 'deny'

export interface ToolPolicyResult {
  toolName: string
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
    return denied('工具参数必须是对象。', call.name)
  }

  if (call.name === 'open_url') {
    const url = readString(args.url, 4_096)
    if (!url) {
      return denied('网页地址无效。', call.name)
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return denied('只允许打开 http 或 https 网页。', call.name)
      }
    } catch {
      return denied('网页地址无效。', call.name)
    }
    return {
      toolName: call.name,
      action: 'execute',
      risk: 'safe',
      args: { url },
      preview: `打开网页：${url}`
    }
  }

  if (call.name === 'search_web') {
    const query = readString(args.query, 500)
    const maxResults = args.maxResults === undefined ? 5 : Number(args.maxResults)
    if (!query || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
      return denied('联网搜索参数无效。', call.name)
    }
    return {
      toolName: call.name,
      action: 'execute',
      risk: 'safe',
      args: { query, maxResults },
      preview: `联网搜索：${query}`
    }
  }

  if (call.name === 'fetch_web_page') {
    const url = readString(args.url, 4_096)
    if (!url) return denied('网页地址无效。', call.name)
    try {
      const validated = validateWebUrl(url)
      return {
        toolName: call.name,
        action: 'execute',
        risk: 'safe',
        args: { url: validated.toString() },
        preview: `读取网页：${validated.hostname}`
      }
    } catch {
      return denied('网页地址不符合联网安全策略。', call.name)
    }
  }

  if (call.name === 'open_app') {
    const appId = readString(args.appId, 128)?.toLowerCase()
    if (!appId || !SAFE_APP_IDS.has(appId)) {
      return denied('应用不在 PetDock 白名单中。', call.name)
    }
    return {
      toolName: call.name,
      action: 'confirm',
      risk: 'confirm',
      args: { appId },
      preview: `打开应用：${appId}`
    }
  }

  if (call.name === 'open_file_or_folder') {
    const path = readString(args.path, 4_096)
    if (!path) {
      return denied('文件或文件夹路径无效。', call.name)
    }
    const resolvedPath = resolve(path)
    if (!existsSync(resolvedPath)) {
      return denied('文件或文件夹不存在。', call.name)
    }
    let realPath: string
    try {
      realPath = realpathSync.native(resolvedPath)
    } catch {
      return denied('无法解析文件或文件夹路径。', call.name)
    }
    return {
      toolName: call.name,
      action: 'confirm',
      risk: 'confirm',
      args: { path: realPath },
      preview: `打开路径：${realPath}`
    }
  }

  return denied('工具未注册或当前版本不支持。', call.name)
}

function denied(error: string, toolName = 'unknown'): ToolPolicyResult {
  return { toolName, action: 'deny', risk: 'dangerous', args: {}, preview: '拒绝执行工具', error }
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
