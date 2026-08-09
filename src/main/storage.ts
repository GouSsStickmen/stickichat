import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { externaliseAssets, sweepAssets } from './assets'

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
    // pictures, sounds and fonts become files here; the config keeps a short reference. Doing it
    // on the way to disk means no caller has to know, and nothing can slip through
    const lean = externaliseAssets(cfg)
    writeFileSync(tmp, JSON.stringify(lean, null, 2), 'utf8')
    renameSync(tmp, p)
    return true
  } catch {
    return false
  }
}

/**
 * Move whatever the config is still carrying inline out to files, once, at startup.
 *
 * Without this the shrink would wait for the next settings change — and until then every save
 * still pays the old price. Reads the file, externalises, writes back only when something
 * actually moved, then drops asset files nothing points at any more.
 */
export function compactConfig(): void {
  try {
    const raw = readConfig()
    if (!raw) return
    const before = JSON.stringify(raw)
    const lean = externaliseAssets(raw)
    const after = JSON.stringify(lean)
    if (after.length < before.length) {
      const p = configPath()
      const tmp = p + '.tmp'
      writeFileSync(tmp, JSON.stringify(lean, null, 2), 'utf8')
      renameSync(tmp, p)
    }
    sweepAssets(lean)
  } catch {
    /* best-effort: a config that will not compact still works, it is just fat */
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
