import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inspect } from 'node:util'

function getLogPath(): string {
  return join(app.getPath('userData'), 'logs', 'main.log')
}

export function logInfo(message: string, details?: unknown): void {
  writeLog('info', message, details)
}

export function logError(message: string, details?: unknown): void {
  writeLog('error', message, details)
}

function writeLog(level: 'info' | 'error', message: string, details?: unknown): void {
  try {
    const path = getLogPath()
    mkdirSync(dirname(path), { recursive: true })
    const suffix = details === undefined ? '' : ` ${inspect(details, { depth: 4 })}`
    appendFileSync(path, `[${new Date().toISOString()}] ${level}: ${message}${suffix}\n`, 'utf8')
  } catch {
    // Logging should never take down the app.
  }
}
