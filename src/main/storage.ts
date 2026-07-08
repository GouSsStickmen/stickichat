import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'

function configPath(): string {
  return join(app.getPath('userData'), 'stickichat-config.json')
}

export function readConfig(): unknown {
  try {
    const p = configPath()
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function writeConfig(cfg: unknown): boolean {
  try {
    const p = configPath()
    const tmp = p + '.tmp'
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
    renameSync(tmp, p)
    return true
  } catch {
    return false
  }
}
