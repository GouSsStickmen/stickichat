import { CustomTheme } from '../types'
import { DEFAULT_TOKENS, deriveTokens, THEMES } from './themes'

/**
 * Portable import/export of themes, deliberately shaped like the overlay share format so the
 * two feel the same in the UI and in a file manager.
 *
 * An import is always re-derived rather than trusted: a file written by an older build (or by
 * hand) still gains whatever the current `deriveTokens` produces, and a file that tries to
 * smuggle in an unknown token name is dropped instead of writing a stray custom property.
 */
const MARK = 'stickichat-theme'
const VERSION = 1

const KNOWN = new Set(Object.keys(DEFAULT_TOKENS))

export function exportThemeJson(themes: CustomTheme | CustomTheme[]): string {
  const list = Array.isArray(themes) ? themes : [themes]
  return JSON.stringify({ _app: MARK, _version: VERSION, themes: list }, null, 2)
}

/** unique id; a re-import of a theme you already have becomes a second copy rather than
 *  silently overwriting the one you may have since edited */
function freshId(existing: CustomTheme[]): string {
  let n = 1
  while (existing.some((t) => t.id === `custom-${n}`)) n++
  return `custom-${n}`
}

/** unique display name, so two imports don't both read "Nord (копія)" */
function freshName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  let n = 2
  while (taken.has(`${name} ${n}`)) n++
  return `${name} ${n}`
}

/**
 * Parse an exported theme file. Returns themes with fresh ids, or null when the text isn't a
 * StickiChat theme export.
 */
export function parseThemeImport(text: string, existing: CustomTheme[]): CustomTheme[] | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const d = data as { _app?: string; themes?: unknown; theme?: unknown }
  if (!d || d._app !== MARK) return null
  const raw = Array.isArray(d.themes) ? d.themes : d.theme ? [d.theme] : []
  const out: CustomTheme[] = []
  const pool = [...existing]
  const names = new Set([...existing.map((t) => t.name), ...THEMES.map((t) => t.name)])
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const src = item as Partial<CustomTheme>
    const tokens: Record<string, string> = {}
    for (const [k, v] of Object.entries(src.tokens ?? {})) {
      if (KNOWN.has(k) && typeof v === 'string') tokens[k] = v
    }
    if (!Object.keys(tokens).length) continue
    const dark = src.dark !== false
    const theme: CustomTheme = {
      id: freshId(pool),
      name: freshName(String(src.name || 'Theme').slice(0, 40), names),
      dark,
      tokens: deriveTokens(tokens, dark)
    }
    pool.push(theme)
    names.add(theme.name)
    out.push(theme)
  }
  return out.length ? out : null
}

export { freshId as nextThemeId, freshName as uniqueThemeName }
