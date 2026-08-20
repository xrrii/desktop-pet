import { describe, expect, it } from 'vitest'
import { isManagedPortalTarget, resolveManagedPortalUrl } from './managedPortalRoutes'

describe('managedPortalRoutes', () => {
  it('生产环境固定官网业务路由并拒绝覆盖', () => {
    expect(resolveManagedPortalUrl('devices', 'production', {}).href).toBe('https://petdock.site/account/devices')
    expect(() => resolveManagedPortalUrl('overview', 'production', {
      PETDOCK_MANAGED_PORTAL_URL: 'http://127.0.0.1:3000'
    })).toThrow('生产官网管理入口禁止运行时覆盖')
  })

  it('开发环境允许受控主机覆盖并保留固定业务路径', () => {
    expect(resolveManagedPortalUrl('usage', 'local-mock', {
      PETDOCK_MANAGED_PORTAL_URL: 'http://127.0.0.1:3000'
    }).href).toBe('http://127.0.0.1:3000/account/usage')
  })

  it('拒绝不安全的开发环境主机或额外查询参数', () => {
    expect(() => resolveManagedPortalUrl('plans', 'shared-dev', {
      PETDOCK_MANAGED_PORTAL_URL: 'https://example.com'
    })).toThrow('官网管理入口地址不在开发允许范围内')
    expect(() => resolveManagedPortalUrl('billing', 'shared-dev', {
      PETDOCK_MANAGED_PORTAL_URL: 'http://127.0.0.1:3000?next=https://evil.example'
    })).toThrow('官网管理入口地址不在开发允许范围内')
  })

  it('只接受固定目标白名单', () => {
    expect(isManagedPortalTarget('overview')).toBe(true)
    expect(isManagedPortalTarget('devices')).toBe(true)
    expect(isManagedPortalTarget('profile')).toBe(false)
    expect(isManagedPortalTarget(null)).toBe(false)
  })
})
