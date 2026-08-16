import type { ManagedEndpointPolicy, ManagedEnvironment } from './managedOAuthTypes'

const OFFICIAL_ISSUER = 'https://account.petdock.site'
const OFFICIAL_CONTROL_PLANE = 'https://api.petdock.site'
const OVERRIDE_KEYS = ['PETDOCK_MANAGED_ISSUER', 'PETDOCK_MANAGED_CONTROL_PLANE_URL'] as const

/**
 * 解析 Main 专用的 Managed Service 端点策略。
 * 生产和预发布只使用内置官方端点；本地联调必须显式注入未提交的端点变量。
 */
export function resolveManagedEndpointPolicy(
  environmentValue = process.env.PETDOCK_MANAGED_ENVIRONMENT,
  environment = process.env
): ManagedEndpointPolicy {
  const selected = (environmentValue?.trim() || 'production') as ManagedEnvironment
  if (!['local-mock', 'shared-dev', 'staging', 'production'].includes(selected)) {
    throw new Error('Managed Service 环境配置无效。')
  }

  const overridesPresent = OVERRIDE_KEYS.some((key) => Boolean(environment[key]?.trim()))
  if (selected === 'production' || selected === 'staging') {
    if (overridesPresent) {
      throw new Error('生产 Managed Service 端点禁止运行时覆盖。')
    }
    return {
      environment: selected,
      issuer: new URL(OFFICIAL_ISSUER),
      controlPlaneBaseUrl: new URL(OFFICIAL_CONTROL_PLANE)
    }
  }

  const issuer = parseEndpoint(environment.PETDOCK_MANAGED_ISSUER, 'Issuer', selected)
  const controlPlaneBaseUrl = parseEndpoint(
    environment.PETDOCK_MANAGED_CONTROL_PLANE_URL,
    '控制面',
    selected
  )
  return { environment: selected, issuer, controlPlaneBaseUrl }
}

/** 校验开发端点只能指向回环或私有网地址，且不能携带凭据和查询参数。 */
function parseEndpoint(value: string | undefined, label: string, environment: ManagedEnvironment): URL {
  if (!value?.trim()) {
    throw new Error(`${environment} 必须显式配置 Managed Service ${label}。`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Managed Service ${label} 地址无效。`)
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname ||
    !isAllowedDevelopmentHost(url.hostname)
  ) {
    throw new Error(`Managed Service ${label} 地址不在开发允许范围内。`)
  }
  return url
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

/** 供生产构建扫描器复用的官方端点常量。 */
export const managedOfficialEndpoints = {
  issuer: OFFICIAL_ISSUER,
  controlPlane: OFFICIAL_CONTROL_PLANE
} as const
