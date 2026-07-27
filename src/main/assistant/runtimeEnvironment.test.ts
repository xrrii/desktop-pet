import { describe, expect, it } from 'vitest'
import { normalizeRuntimeEnvironment } from './runtimeEnvironment'

describe('normalizeRuntimeEnvironment', () => {
  it('Windows 环境只保留规范化 Path，同时保留 Runtime 覆盖项', () => {
    const environment = normalizeRuntimeEnvironment(
      { Path: 'C:\\Windows', PATH: 'C:\\broken', OTHER: 'base' },
      { PETDOCK_RUNTIME_TOKEN: 'token' },
      'win32'
    )

    expect(environment.Path).toBe('C:\\Windows')
    expect(environment).not.toHaveProperty('PATH')
    expect(environment.OTHER).toBe('base')
    expect(environment.PETDOCK_RUNTIME_TOKEN).toBe('token')
  })
})
