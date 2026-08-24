import { describe, expect, it } from 'vitest'
import {
  canonicalizeWebUrl,
  isPublicIpAddress,
  resolvePublicWebTarget,
  validateWebUrl
} from './webNetworkPolicy'

describe('webNetworkPolicy', () => {
  it('接受标准公开 HTTP(S) URL 并清理跟踪参数', () => {
    expect(validateWebUrl('https://example.com/news?q=pet#section').hostname).toBe('example.com')
    expect(canonicalizeWebUrl('https://example.com/news?utm_source=x&q=pet#section')).toBe(
      'https://example.com/news?q=pet'
    )
  })

  it.each([
    'file:///C:/secret.txt',
    'https://user:pass@example.com/',
    'http://localhost/',
    'http://service.local/',
    'https://example.com:8443/',
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://[::1]/'
  ])('拒绝危险 URL：%s', (url) => {
    expect(() => validateWebUrl(url)).toThrow()
  })

  it.each([
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['10.0.0.1', false],
    ['172.20.1.1', false],
    ['192.168.1.1', false],
    ['198.51.100.2', false],
    ['2606:4700:4700::1111', true],
    ['2001:db8::1', false],
    ['::ffff:127.0.0.1', false]
  ])('判断公网地址 %s', (address, expected) => {
    expect(isPublicIpAddress(address)).toBe(expected)
  })

  it('拒绝 DNS 返回结果中混入私网地址', async () => {
    await expect(
      resolvePublicWebTarget('https://example.com/', async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 }
      ])
    ).rejects.toThrow('web_address_denied')
  })

  it('返回经过校验并可固定连接的 DNS 地址', async () => {
    await expect(
      resolvePublicWebTarget('https://example.com/', async () => [
        { address: '93.184.216.34', family: 4 }
      ])
    ).resolves.toMatchObject({ address: '93.184.216.34', family: 4 })
  })

  it('系统 DNS 统一使用 Fake-IP 时允许域名交给本机代理接管', async () => {
    const lookup = async (hostname: string): Promise<Array<{ address: string; family: number }>> => {
      if (hostname === 'news.example.test') return [{ address: '198.18.0.88', family: 4 }]
      if (hostname === 'example.com') return [{ address: '198.18.0.90', family: 4 }]
      return []
    }
    await expect(
      resolvePublicWebTarget('https://news.example.test/article', lookup)
    ).resolves.toMatchObject({ address: '198.18.0.88', family: 4 })
  })

  it('没有系统级 Fake-IP 证据时仍拒绝保留网段解析结果', async () => {
    const lookup = async (hostname: string): Promise<Array<{ address: string; family: number }>> => {
      if (hostname === 'news.example.test') return [{ address: '198.18.0.88', family: 4 }]
      if (hostname === 'example.com') return [{ address: '93.184.216.34', family: 4 }]
      return []
    }
    await expect(
      resolvePublicWebTarget('https://news.example.test/article', lookup)
    ).rejects.toThrow('web_address_denied')
  })

  it('Fake-IP 模式下仍拒绝直接地址和其他私网解析结果', async () => {
    const lookup = async (hostname: string): Promise<Array<{ address: string; family: number }>> => {
      if (hostname === 'private.example.test') return [{ address: '192.168.1.20', family: 4 }]
      if (hostname === 'example.com') return [{ address: '198.18.0.90', family: 4 }]
      return []
    }
    expect(() => validateWebUrl('https://198.18.0.88/article')).toThrow('web_address_denied')
    await expect(
      resolvePublicWebTarget('https://private.example.test/article', lookup)
    ).rejects.toThrow('web_address_denied')
  })
})
