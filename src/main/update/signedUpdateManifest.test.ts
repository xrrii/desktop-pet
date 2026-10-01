import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  verifySignedUpdateManifest, verifyUpdateArtifact, type SignedUpdateEnvelope, type UpdateManifest
} from './signedUpdateManifest'

const now = Date.parse('2026-10-01T00:00:00Z')
const pair = generateKeyPairSync('ed25519')
const payload = Buffer.from('synthetic installer; never execute')
const base: UpdateManifest = {
  schemaVersion: 1, appId: 'com.local.petdock', version: '0.2.2', channel: 'stable', platform: 'win32', arch: 'x64',
  artifact: { kind: 'nsis', fileName: 'PetDock Setup 0.2.2.exe', size: payload.length, sha512: createHash('sha512').update(payload).digest('base64') },
  issuedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-31T00:00:00Z'
}
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const trust = { keys: { synthetic: publicKey, rotated: publicKey }, revokedKeyIds: [] }

/** 只用内存中即时生成的合成密钥签名，允许构造已签名但不符合产品边界的候选。 */
function envelope(data: unknown = base, keyId = 'synthetic'): SignedUpdateEnvelope {
  const bytes = Buffer.from(JSON.stringify(data))
  return {
    schemaVersion: 1, keyId, manifest: bytes.toString('base64'),
    signature: sign(null, Buffer.concat([Buffer.from(`PetDock desktop update manifest v1\n${keyId}\n`), bytes]), pair.privateKey).toString('base64')
  }
}

describe('独立签名清单信任边界', () => {
  it('验证真实 Ed25519、上下文和正式制品绑定，输出快照不可变', () => {
    const result = verifySignedUpdateManifest(envelope(), trust, '0.2.2', now)
    expect(result.manifest).toEqual(base)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.manifest.artifact)).toBe(true)
  })

  it('允许预先内置的轮换公钥，拒绝未知或已撤销的标识', () => {
    expect(verifySignedUpdateManifest(envelope(base, 'rotated'), trust, '0.2.2', now).keyId).toBe('rotated')
    expect(() => verifySignedUpdateManifest(envelope(base, 'unknown'), trust, '0.2.2', now)).toThrow('受信任')
    expect(() => verifySignedUpdateManifest(envelope(), { ...trust, revokedKeyIds: ['synthetic'] }, '0.2.2', now)).toThrow('受信任')
  })

  it('不能替换签名、签名算法或借用另一个 keyId 的上下文', () => {
    expect(() => verifySignedUpdateManifest({ ...envelope(), signature: Buffer.alloc(64).toString('base64') }, trust, '0.2.2', now)).toThrow()
    expect(() => verifySignedUpdateManifest({ ...envelope(), keyId: 'rotated' }, trust, '0.2.2', now)).toThrow()
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(() => verifySignedUpdateManifest(envelope(), { keys: { synthetic: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, revokedKeyIds: [] }, '0.2.2', now)).toThrow()
  })

  it.each([
    { ...base, schemaVersion: 2 }, { ...base, appId: 'other' }, { ...base, version: '0.2.3' },
    { ...base, version: '00.2.2' }, { ...base, channel: 'beta' }, { ...base, platform: 'linux' },
    { ...base, arch: 'arm64' }, { ...base, publicKey }, { ...base, url: 'https://evil.example' },
    { ...base, artifact: { ...base.artifact, kind: 'portable' } },
    { ...base, artifact: { ...base.artifact, fileName: '../other.exe' } },
    { ...base, artifact: { ...base.artifact, size: 0 } },
    { ...base, artifact: { ...base.artifact, size: 2_147_483_649 } },
    { ...base, artifact: { ...base.artifact, sha512: base.artifact.sha512 + '\n' } },
    { ...base, issuedAt: '2026-10-01T00:06:00Z' }, { ...base, expiresAt: '2026-10-01T00:00:00Z' },
    { ...base, expiresAt: '2026-11-01T00:00:00Z' }, { ...base, issuedAt: '2026-09-31T00:00:00Z' }
  ])('即便持有有效签名，非法清单仍拒绝：%j', (data) => {
    expect(() => verifySignedUpdateManifest(envelope(data), trust, '0.2.2', now)).toThrow('签名清单')
  })

  it('宽松 Base64、额外封套字段和超大清单均拒绝', () => {
    expect(() => verifySignedUpdateManifest({ ...envelope(), manifest: envelope().manifest + '\n' }, trust, '0.2.2', now)).toThrow()
    expect(() => verifySignedUpdateManifest({ ...envelope(), publicKey }, trust, '0.2.2', now)).toThrow()
    expect(() => verifySignedUpdateManifest(envelope({ ...base, extra: 'x'.repeat(40_000) }), trust, '0.2.2', now)).toThrow()
  })

  it('流式检查原始文件；缺失、目录、大小不符及同长篡改均失败', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'petdock-update-signature-'))
    try {
      const file = join(directory, 'synthetic.exe')
      await writeFile(file, payload)
      await expect(verifyUpdateArtifact(file, base)).resolves.toBe(true)
      await writeFile(file, Buffer.alloc(payload.length, 120))
      await expect(verifyUpdateArtifact(file, base)).resolves.toBe(false)
      await writeFile(file, Buffer.from('short'))
      await expect(verifyUpdateArtifact(file, base)).resolves.toBe(false)
      await expect(verifyUpdateArtifact(directory, base)).resolves.toBe(false)
      await expect(verifyUpdateArtifact(join(directory, 'missing.exe'), base)).resolves.toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
