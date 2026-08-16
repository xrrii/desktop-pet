import { describe, expect, it } from 'vitest'
import { resolveManagedEndpointPolicy } from './managedEndpointPolicy'

describe('resolveManagedEndpointPolicy', () => {
  it('生产端点固定且拒绝覆盖', () => {
    expect(resolveManagedEndpointPolicy('production', {}).issuer.href).toBe('https://account.petdock.site/')
    expect(() => resolveManagedEndpointPolicy('production', {
      PETDOCK_MANAGED_ISSUER: 'http://127.0.0.1:8080'
    })).toThrow()
  })

  it('开发环境只接受回环和私有网地址', () => {
    expect(resolveManagedEndpointPolicy('local-mock', {
      PETDOCK_MANAGED_ISSUER: 'http://127.0.0.1:18080',
      PETDOCK_MANAGED_CONTROL_PLANE_URL: 'http://192.168.1.20:18081'
    }).controlPlaneBaseUrl.hostname).toBe('192.168.1.20')
    expect(() => resolveManagedEndpointPolicy('local-mock', {
      PETDOCK_MANAGED_ISSUER: 'https://example.com',
      PETDOCK_MANAGED_CONTROL_PLANE_URL: 'https://example.com'
    })).toThrow()
  })
})
