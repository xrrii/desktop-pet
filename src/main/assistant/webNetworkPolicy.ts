import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export const MAX_WEB_URL_LENGTH = 4_096

export interface ResolvedWebTarget {
  url: URL
  address: string
  family: 4 | 6
}

export type WebDnsLookup = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home', '.lan']
const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src'
])

/** 校验网页 URL 的静态结构，不执行 DNS 或网络访问。 */
export function validateWebUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length < 8 || value.length > MAX_WEB_URL_LENGTH) {
    throw new Error('web_url_invalid')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('web_url_invalid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('web_protocol_denied')
  }
  if (url.username || url.password) {
    throw new Error('web_credentials_denied')
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new Error('web_port_denied')
  }
  const hostname = normalizedHostname(url.hostname)
  if (
    !hostname ||
    hostname === 'localhost' ||
    (!isIP(hostname) && !hostname.includes('.')) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error('web_host_denied')
  }
  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    throw new Error('web_address_denied')
  }
  url.hash = ''
  return url
}

/** 解析域名并要求所有返回地址均为公网地址，随后固定其中一个地址连接。 */
export async function resolvePublicWebTarget(
  value: unknown,
  lookup: WebDnsLookup = defaultDnsLookup
): Promise<ResolvedWebTarget> {
  const url = validateWebUrl(value)
  const hostname = normalizedHostname(url.hostname)
  if (isIP(hostname)) {
    return { url, address: hostname, family: isIP(hostname) as 4 | 6 }
  }
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(hostname)
  } catch {
    throw new Error('web_dns_failed')
  }
  if (
    addresses.length === 0 ||
    addresses.some(
      (item) => (item.family !== 4 && item.family !== 6) || !isPublicIpAddress(item.address)
    )
  ) {
    throw new Error('web_address_denied')
  }
  const selected = addresses[0]
  return { url, address: selected.address, family: selected.family as 4 | 6 }
}

/** 生成可持久化和展示的 URL，移除片段与常见跟踪参数。 */
export function canonicalizeWebUrl(value: string): string {
  const url = validateWebUrl(value)
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key)
    }
  }
  return url.toString()
}

/** 判断 IPv4/IPv6 是否属于允许访问的公网单播范围。 */
export function isPublicIpAddress(value: string): boolean {
  const address = normalizedHostname(value)
  const family = isIP(address)
  if (family === 4) {
    const number = ipv4Number(address)
    return number !== null && !BLOCKED_IPV4_RANGES.some(([base, prefix]) => inIpv4Cidr(number, base, prefix))
  }
  if (family !== 6) {
    return false
  }
  const lower = address.toLowerCase()
  const mapped = mappedIpv4(lower)
  if (mapped) {
    return isPublicIpAddress(mapped)
  }
  if (!/^[23][0-9a-f]*:/.test(lower)) {
    return false
  }
  return ![
    '2001:db8:',
    '2001:0:',
    '2001:2:',
    '2001:10:',
    '2002:',
    '3fff:'
  ].some((prefix) => lower.startsWith(prefix))
}

const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
  [ipv4Number('0.0.0.0')!, 8],
  [ipv4Number('10.0.0.0')!, 8],
  [ipv4Number('100.64.0.0')!, 10],
  [ipv4Number('127.0.0.0')!, 8],
  [ipv4Number('169.254.0.0')!, 16],
  [ipv4Number('172.16.0.0')!, 12],
  [ipv4Number('192.0.0.0')!, 24],
  [ipv4Number('192.0.2.0')!, 24],
  [ipv4Number('192.168.0.0')!, 16],
  [ipv4Number('198.18.0.0')!, 15],
  [ipv4Number('198.51.100.0')!, 24],
  [ipv4Number('203.0.113.0')!, 24],
  [ipv4Number('224.0.0.0')!, 4],
  [ipv4Number('240.0.0.0')!, 4]
]

async function defaultDnsLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function ipv4Number(value: string): number | null {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
}

function inIpv4Cidr(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) >>> 0 === (base & mask) >>> 0
}

function mappedIpv4(value: string): string | null {
  const dotted = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    return dotted[1]
  }
  const hexadecimal = value.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hexadecimal) {
    return null
  }
  const high = Number.parseInt(hexadecimal[1], 16)
  const low = Number.parseInt(hexadecimal[2], 16)
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`
}
