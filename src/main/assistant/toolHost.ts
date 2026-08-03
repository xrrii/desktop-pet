import { shell } from 'electron'
import { spawn } from 'node:child_process'
import type { ToolCall } from '../../shared/assistant'
import { evaluateToolCall, type ToolPolicyResult } from './toolPolicy'
import type { WebSearchService } from './webSearchService'

export interface ToolExecutionResult {
  ok: boolean
  result?: unknown
  error?: string
}

/** 执行已经通过策略检查的系统工具，不接受任意 shell 命令。 */
export class AssistantToolHost {
  constructor(private readonly webSearch: WebSearchService) {}

  evaluate(call: ToolCall): ToolPolicyResult {
    return evaluateToolCall(call)
  }

  async execute(policy: ToolPolicyResult, taskId: string): Promise<ToolExecutionResult> {
    if (policy.action === 'deny') {
      return { ok: false, error: policy.error || '工具被策略拒绝。' }
    }

    try {
      if (policy.toolName === 'search_web') {
        return {
          ok: true,
          result: await this.webSearch.search(
            taskId,
            String(policy.args.query),
            Number(policy.args.maxResults)
          )
        }
      }

      if (policy.toolName === 'fetch_web_page') {
        return {
          ok: true,
          result: await this.webSearch.fetch(taskId, String(policy.args.url))
        }
      }

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
      return { ok: false, error: webToolErrorMessage(error) }
    }
  }
}

export function webToolErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  const messages: Record<string, string> = {
    web_search_disabled: '联网搜索未启用。',
    web_search_not_configured: '联网搜索尚未配置 API Key。',
    web_search_limit_reached: '本轮搜索次数已达到上限。',
    web_fetch_limit_reached: '本轮网页读取数量已达到上限。',
    web_url_not_authorized: '只能读取本轮搜索结果或用户明确提供的网页。',
    web_request_cancelled: '网页请求已取消。',
    web_timeout: '网页请求超时。',
    web_dns_failed: '网页域名解析失败。',
    web_response_too_large: '网页响应超过大小限制。',
    web_mime_denied: '网页内容类型不受支持。',
    web_encoding_denied: '网页响应使用了不受支持的压缩编码。',
    web_content_empty: '网页没有可读取的正文。',
    web_address_denied: '网页地址指向受限网络。',
    web_redirect_denied: '网页重定向不符合安全策略。',
    web_provider_response_invalid: '搜索服务返回了无效响应。',
    web_provider_not_supported: '当前搜索服务暂不受支持。',
    web_provider_request_invalid: '搜索服务拒绝了当前查询参数。',
    web_provider_not_enabled: '当前火山引擎账号尚未开通豆包搜索服务。',
    web_provider_quota_exhausted: '豆包搜索调用额度已用尽。',
    web_provider_key_mode_invalid: '豆包搜索 API Key 与当前计费模式不匹配。',
    web_provider_rate_limited: '豆包搜索请求过于频繁，请稍后重试。',
    web_provider_failed: '搜索服务返回了错误，请检查服务配置。',
    web_http_401: '搜索 API Key 无效或已失效。',
    web_http_403: '搜索服务拒绝了当前 API Key。',
    web_http_429: '搜索请求额度已用尽或请求过于频繁。'
  }
  if (messages[code]) return messages[code]
  if (/^web_http_\d+$/.test(code)) return `网页请求失败（${code.slice(9)}）。`
  if (code.startsWith('web_')) return '联网请求失败，请稍后重试。'
  return code
}

const APP_COMMANDS: Record<string, string> = {
  notepad: 'notepad.exe',
  explorer: 'explorer.exe',
  calculator: 'calc.exe'
}
