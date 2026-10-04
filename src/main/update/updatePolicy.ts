import type { UpdatePackageKind } from './updateManager'

/** 正式配置随引导版内置；运行时不接受环境变量或远程业务配置覆盖。 */
export const DESKTOP_UPDATE_RELEASE = Object.freeze({
  feedUrl: 'https://download.petdock.site/',
  bucketHost: 'petdock-1467993618.cos.ap-guangzhou.myqcloud.com',
  portableDownloadUrl: 'https://download.petdock.site/download',
  trustReady: true
})

/** 识别构建形态；未知打包目录保持关闭，不把 isPackaged 直接当成 NSIS 安装版。 */
export function detectUpdatePackageKind(input: {
  platform: string
  packaged: boolean
  portable: boolean
  nsisInstalled: boolean
}): UpdatePackageKind {
  if (!input.packaged) return 'development'
  if (input.platform !== 'win32') return 'unsupported'
  if (input.portable) return 'portable'
  return input.nsisInstalled ? 'nsis' : 'unpacked'
}

/** 校验正式静态源只允许已确定的 HTTPS 主机；不支持环境变量或 Renderer 覆盖。 */
export function requireOfficialUpdateUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'download.petdock.site' || url.port ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('桌面更新地址不在官方允许范围内。')
  }
  return url
}
