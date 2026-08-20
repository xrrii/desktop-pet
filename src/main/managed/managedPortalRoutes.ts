import type { ManagedPortalTarget } from '../../shared/managed'
import type { ManagedEnvironment } from './managedOAuthTypes'

const OFFICIAL_PORTAL_BASE_URL = 'https://petdock.site'
const PORTAL_OVERRIDE_KEY = 'PETDOCK_MANAGED_PORTAL_URL'

const MANAGED_PORTAL_ROUTE_MAP: Record<ManagedPortalTarget, string> = {
  overview: '/account/plan',
  plans: '/account/plan',
  devices: '/account/devices',
  usage: '/account/usage',
  billing: '/account/orders'
}

/**
 * 解析桌面端“前往官网管理”的受控业务地址。
 * 生产和预发布固定官方主机；开发环境只允许通过未提交环境变量覆盖到回环或私有网地址。
 */
export function resolveManagedPortalUrl(
  target: ManagedPortalTarget,
  environmentValue = process.env.PETDOCK_MANAGED_ENVIRONMENT,
  environment = process.env,
  packagedBuild = false
): URL {
  if (packagedBuild && environmentValue?.trim() && environmentValue.trim() !== 'production') {
    throw new Error('已打包 Desktop 禁止覆盖官网管理入口环境。')
  }
  const selected = (packagedBuild ? 'production' : (environmentValue?.trim() || 'production')) as ManagedEnvironment
  if (!['local-mock', 'shared-dev', 'staging', 'production'].includes(selected)) {
    throw new Error('官网管理入口环境配置无效。')
  }
  const baseUrl = resolveManagedPortalBaseUrl(selected, environment)
  const route = MANAGED_PORTAL_ROUTE_MAP[target]
  return new URL(route, ensureTrailingSlash(baseUrl))
}

/** 供 IPC 校验器与测试共享的固定目标白名单。 */
export function isManagedPortalTarget(value: unknown): value is ManagedPortalTarget {
  return typeof value === 'string' && value in MANAGED_PORTAL_ROUTE_MAP
}

/** 生产与预发布固定官方主机；开发环境仅允许显式覆盖到受控地址。 */
function resolveManagedPortalBaseUrl(
  environment: ManagedEnvironment,
  variables: NodeJS.ProcessEnv
): URL {
  const overrideValue = variables[PORTAL_OVERRIDE_KEY]?.trim()
  if (environment === 'production' || environment === 'staging') {
    if (overrideValue) {
      throw new Error('生产官网管理入口禁止运行时覆盖。')
    }
    return new URL(OFFICIAL_PORTAL_BASE_URL)
  }
  if (!overrideValue) {
    return new URL(OFFICIAL_PORTAL_BASE_URL)
  }
  return parseDevelopmentPortalBaseUrl(overrideValue)
}

/** 校验开发环境官网入口只能指向 HTTP(S) 回环或私有网主机，且不能携带额外路径与凭据。 */
function parseDevelopmentPortalBaseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('官网管理入口地址无效。')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname ||
    !isAllowedDevelopmentHost(url.hostname) ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('官网管理入口地址不在开发允许范围内。')
  }
  return url
}

/** 为 new URL(route, base) 统一补齐尾部斜杠，避免路径解析歧义。 */
function ensureTrailingSlash(url: URL): URL {
  const value = new URL(url.href)
  if (!value.pathname.endsWith('/')) {
    value.pathname = `${value.pathname}/`
  }
  return value
}

/** 仅允许 IPv4 loopback、私有网段和 IPv6 loopback。 */
function isAllowedDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1') {
    return true
  }
  const parts = normalized.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false
  }
  const octets = parts.map(Number)
  if (octets.some((part) => part < 0 || part > 255)) {
    return false
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 127 && octets[1] >= 0 && octets[1] <= 255)
  )
}

/** 供生产制品检查和日志诊断复用的官方官网主机常量。 */
export const managedOfficialPortalBaseUrl = OFFICIAL_PORTAL_BASE_URL
