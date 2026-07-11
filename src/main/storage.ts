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

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
}

function windowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/** per-window-kind saved bounds: 'main', 'emotepicker', 'settings', 'usercard' … */
function readAllWindowStates(): Record<string, WindowState> {
  try {
    const p = windowStatePath()
    if (!existsSync(p)) return {}
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    // migrate the old single-window format ({x,y,width,height} at top level)
    if (raw && typeof raw.width === 'number') return { main: raw }
    return raw ?? {}
  } catch {
    return {}
  }
}

export function readWindowState(key = 'main'): WindowState | null {
  return readAllWindowStates()[key] ?? null
}

export function writeWindowState(state: WindowState, key = 'main'): void {
  try {
    const all = readAllWindowStates()
    all[key] = state
    writeFileSync(windowStatePath(), JSON.stringify(all), 'utf8')
  } catch {
    /* best-effort */
  }
}
