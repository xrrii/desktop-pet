import { generateKeyPairSync, createHash, verify, type KeyObject } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isUpdateArtifactName, verifySignedUpdateManifest, verifyUpdateArtifact } from './signedUpdateManifest'

const cli = resolve('tools/sign_desktop_update.mjs')
const issuedAt = '2026-10-01T00:00:00Z'
const expiresAt = '2026-10-31T00:00:00Z'

interface SyntheticEnvelope {
  schemaVersion: number
  keyId: string
  manifest: string
  signature: string
}

interface CliFixture {
  directory: string
  artifact: string
  privateKey: string
  output: string
  payload: Buffer
  publicKey: KeyObject
  args: string[]
}

/** 使用隔离目录即时生成合成密钥，始终清理密钥和不可执行的测试安装包。 */
async function withFixture(run: (fixture: CliFixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'petdock-sign-cli-'))
  try {
    const artifact = join(directory, 'PetDock-Setup-0.2.2.exe')
    const privateKey = join(directory, 'synthetic-private.pem')
    const output = join(directory, 'signed-update.json')
    const payload = Buffer.from('synthetic installer bytes; never execute', 'utf8')
    const pair = generateKeyPairSync('ed25519')
    await writeFile(artifact, payload)
    await writeFile(privateKey, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    await run({
      directory, artifact, privateKey, output, payload, publicKey: pair.publicKey,
      args: ['--artifact', artifact, '--version', '0.2.2', '--key-id', 'synthetic-key-v1',
        '--private-key', privateKey, '--issued-at', issuedAt, '--expires-at', expiresAt, '--output', output]
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** 修改单个参数以验证 CLI 边界，测试数据不包含任何实际发布凭据。 */
function replaceArgument(args: string[], name: string, value: string): string[] {
  const result = [...args]
  result[result.indexOf(name) + 1] = value
  return result
}

/** 使用真实 Node 子进程执行签名入口，限制测试执行时间且不启动安装器。 */
function invokeCli(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
}

describe('离线桌面更新签名 CLI', () => {
  it('生成严格清单、真实 Ed25519 签名和与安装包一致的摘要', async () => {
    await withFixture(async (fixture) => {
      const result = invokeCli(fixture.args)
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).not.toContain(fixture.directory)
      const bytes = await readFile(fixture.output)
      expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf])
      const envelope = JSON.parse(bytes.toString('utf8')) as SyntheticEnvelope
      expect(Object.keys(envelope).sort()).toEqual(['keyId', 'manifest', 'schemaVersion', 'signature'])
      const manifestBytes = Buffer.from(envelope.manifest, 'base64')
      const manifest = JSON.parse(manifestBytes.toString('utf8'))
      expect(manifest).toEqual({
        schemaVersion: 1, appId: 'com.local.petdock', version: '0.2.2', channel: 'stable', platform: 'win32', arch: 'x64',
        artifact: { kind: 'nsis', fileName: 'PetDock-Setup-0.2.2.exe', size: fixture.payload.length,
          sha512: createHash('sha512').update(fixture.payload).digest('base64') },
        issuedAt, expiresAt
      })
      const signedBytes = Buffer.concat([Buffer.from(`PetDock desktop update manifest v1\n${envelope.keyId}\n`, 'utf8'), manifestBytes])
      expect(verify(null, signedBytes, fixture.publicKey, Buffer.from(envelope.signature, 'base64'))).toBe(true)
      expect(Buffer.from(envelope.signature, 'base64')).toHaveLength(64)
      expect(bytes.toString('utf8')).not.toContain('PRIVATE KEY')
      expect(bytes.toString('utf8')).not.toContain(fixture.directory)
      const verified = verifySignedUpdateManifest(envelope, {
        keys: { 'synthetic-key-v1': fixture.publicKey.export({ format: 'pem', type: 'spki' }).toString() }, revokedKeyIds: []
      }, '0.2.2', Date.parse('2026-10-01T00:01:00Z'))
      expect(verified.manifest).toEqual(manifest)
      await expect(verifyUpdateArtifact(fixture.artifact, verified.manifest)).resolves.toBe(true)
      await writeFile(fixture.artifact, Buffer.alloc(fixture.payload.length, 'x'))
      await expect(verifyUpdateArtifact(fixture.artifact, verified.manifest)).resolves.toBe(false)
    })
  })

  it('拒绝覆盖已有清单，原文件内容保持不变', async () => {
    await withFixture(async (fixture) => {
      await writeFile(fixture.output, 'synthetic existing output', 'utf8')
      const result = invokeCli(fixture.args)
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain(fixture.directory)
      expect(await readFile(fixture.output, 'utf8')).toBe('synthetic existing output')
    })
  })

  it('兼容现有带内部 ASCII 空格的安装包名称', async () => {
    await withFixture(async (fixture) => {
      const artifact = join(fixture.directory, 'PetDock Setup 0.2.2.exe')
      await writeFile(artifact, fixture.payload)
      expect(invokeCli(replaceArgument(fixture.args, '--artifact', artifact)).status).toBe(0)
      const envelope = JSON.parse(await readFile(fixture.output, 'utf8')) as SyntheticEnvelope
      const manifest = JSON.parse(Buffer.from(envelope.manifest, 'base64').toString('utf8'))
      expect(manifest.artifact.fileName).toBe('PetDock Setup 0.2.2.exe')
      expect(isUpdateArtifactName(manifest.artifact.fileName)).toBe(true)
      const verified = verifySignedUpdateManifest(envelope, {
        keys: { 'synthetic-key-v1': fixture.publicKey.export({ format: 'pem', type: 'spki' }).toString() }, revokedKeyIds: []
      }, '0.2.2', Date.parse('2026-10-01T00:01:00Z'))
      await expect(verifyUpdateArtifact(artifact, verified.manifest)).resolves.toBe(true)
    })
  })

  it('错误密钥算法被拒绝，终端不泄露私钥与文件路径', async () => {
    await withFixture(async (fixture) => {
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const pem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' })
      await writeFile(fixture.privateKey, pem)
      const result = invokeCli(fixture.args)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Ed25519')
      expect(result.stderr).not.toContain(fixture.directory)
      expect(result.stderr).not.toContain(pem.toString())
    })
  })

  it.each([
    ['--version', '0.2.2-beta.1'], ['--version', '01.2.2'], ['--version', '9007199254740992.2.2'],
    ['--key-id', 'unsafe/key'], ['--key-id', 'unsafe\nkey'],
    ['--issued-at', '2026-02-30T00:00:00Z'], ['--issued-at', '2026-10-01T00:00:00.000Z'],
    ['--issued-at', '2026-10-01T08:00:00+08:00'],
    ['--expires-at', issuedAt], ['--expires-at', '2026-11-01T00:00:00Z']
  ])('拒绝非法参数 %s，输出保持脱敏', async (name, value) => {
    await withFixture(async (fixture) => {
      const result = invokeCli(replaceArgument(fixture.args, name, value))
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain(fixture.directory)
      expect(result.stderr).not.toContain(value)
    })
  })

  it('拒绝未知、重复或缺失参数', async () => {
    await withFixture(async (fixture) => {
      for (const args of [[...fixture.args, '--unexpected', 'value'], [...fixture.args, '--version', '0.2.3'], fixture.args.slice(0, -2)]) {
        expect(invokeCli(args).status).toBe(1)
      }
    })
  })

  it('拒绝空安装包与 Windows 设备文件名，不生成清单', async () => {
    await withFixture(async (fixture) => {
      await writeFile(fixture.artifact, Buffer.alloc(0))
      expect(invokeCli(fixture.args).status).toBe(1)
      const result = invokeCli(replaceArgument(fixture.args, '--artifact', join(fixture.directory, 'CON.exe')))
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('文件名')
    })
  })

  it.each(['PetDock..exe', 'PetDock .exe', 'CON .exe', 'NUL.update.exe', 'LPT9.foo.exe', 'PetDock-更新.exe'])('拒绝不安全安装包名称 %s', async (fileName) => {
    await withFixture(async (fixture) => {
      expect(isUpdateArtifactName(fileName)).toBe(false)
      const result = invokeCli(replaceArgument(fixture.args, '--artifact', join(fixture.directory, fileName)))
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('文件名')
      expect(result.stderr).not.toContain(fixture.directory)
    })
  })

  it('无效 PEM 仅输出固定中文提示，不输出 crypto 错误或文件内容', async () => {
    await withFixture(async (fixture) => {
      const invalid = 'synthetic invalid private key content'
      await writeFile(fixture.privateKey, invalid, 'utf8')
      const result = invokeCli(fixture.args)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('签名失败')
      expect(result.stderr).not.toContain(invalid)
      expect(result.stderr).not.toContain(fixture.directory)
      expect(result.stderr).not.toContain('ERR_OSSL')
    })
  })

  it('缺失密钥或输出父目录时返回中文脱敏错误', async () => {
    await withFixture(async (fixture) => {
      for (const args of [
        replaceArgument(fixture.args, '--private-key', join(fixture.directory, 'missing.pem')),
        replaceArgument(fixture.args, '--output', join(fixture.directory, 'missing-parent', 'signed.json'))
      ]) {
        const result = invokeCli(args)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('签名失败')
        expect(result.stderr).not.toContain(fixture.directory)
        expect(result.stderr).not.toContain('ENOENT')
      }
    })
  })

  it('不能直接用参数值传递私钥明文', async () => {
    await withFixture(async (fixture) => {
      const pem = await readFile(fixture.privateKey, 'utf8')
      const result = invokeCli(replaceArgument(fixture.args, '--private-key', pem))
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('PRIVATE KEY')
      expect(result.stderr).not.toContain(fixture.directory)
    })
  })
})
