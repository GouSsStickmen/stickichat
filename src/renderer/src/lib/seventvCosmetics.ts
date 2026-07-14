import { create } from 'zustand'

/**
 * Lazily-fetched 7TV cosmetic nick styling, keyed by twitch user id. 7TV exposes a user's
 * chosen solid color and/or gradient "paint" at /v3/users/twitch/<id>. A solid color renders
 * as-is; a paint renders as a CSS gradient clipped to the nick text (exactly what the user set
 * up on 7TV). We fetch once per user, cache in localStorage, and dedupe in-flight + negative
 * lookups. Only used when the "7TV nick colors" setting is on.
 */
interface Cosmetic {
  /** solid nick color "#rrggbb" (present when the user has no paint) */
  color?: string
  /** a CSS `background` value for a gradient/image paint, clipped to the text */
  paint?: string
  /** a representative flat color for the paint (used where gradient text can't render) */
  paintColor?: string
}

interface SevenTvState {
  cosmetics: Record<string, Cosmetic> // twitchUserId -> cosmetic
  setCosmetic: (id: string, c: Cosmetic) => void
}

const CACHE_KEY = 'sticki:stvCosmetics:v1'

function loadCache(): Record<string, Cosmetic> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
  } catch {
    return {}
  }
}

export const useSevenTvColors = create<SevenTvState>()((set) => ({
  cosmetics: loadCache(),
  setCosmetic: (id, c) =>
    set((s) => {
      const cosmetics = { ...s.cosmetics, [id]: c }
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cosmetics))
      } catch {
        /* quota — non-critical */
      }
      return { cosmetics }
    })
}))

const inFlight = new Set<string>()
const negative = new Set<string>()

/** 7TV colors are signed 32-bit RGBA ints (0xRRGGBBAA) */
function intToRgba(c: number): string {
  const u = c >>> 0
  const r = (u >>> 24) & 0xff
  const g = (u >>> 16) & 0xff
  const b = (u >>> 8) & 0xff
  const a = (u & 0xff) / 255
  return `rgba(${r},${g},${b},${a})`
}
function intToHex(c: number): string {
  const u = c >>> 0
  return `#${[(u >>> 24) & 0xff, (u >>> 16) & 0xff, (u >>> 8) & 0xff]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')}`
}

interface Paint {
  function?: string // LINEAR_GRADIENT | RADIAL_GRADIENT | URL
  color?: number | null
  angle?: number
  shape?: string
  image_url?: string
  repeat?: boolean
  stops?: { at: number; color: number }[]
}

/** turn a 7TV paint definition into a CSS `background` value (clipped to text at the call site) */
function paintToCss(paint: Paint): string | undefined {
  const stops = (paint.stops ?? []).map((s) => `${intToRgba(s.color)} ${Math.round(s.at * 100)}%`)
  if (paint.function === 'URL' && paint.image_url) {
    return `url('${paint.image_url}')`
  }
  if (stops.length === 0) return undefined
  if (paint.function === 'RADIAL_GRADIENT') {
    return `radial-gradient(${paint.shape === 'circle' ? 'circle' : 'ellipse'}, ${stops.join(', ')})`
  }
  // default: linear gradient
  const angle = typeof paint.angle === 'number' ? paint.angle : 90
  return `linear-gradient(${angle}deg, ${stops.join(', ')})`
}

// v3 GQL to resolve a user's paint definition (the REST endpoint only gives the paint id)
async function fetchPaint(sevenTvUserId: string): Promise<Paint | null> {
  try {
    const res = await window.sticki.fetchJson('https://7tv.io/v3/gql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query:
          'query($id:ObjectID!){user(id:$id){style{paint{function color angle shape image_url repeat stops{at color}}}}}',
        variables: { id: sevenTvUserId }
      })
    })
    const j = res.json as { data?: { user?: { style?: { paint?: Paint | null } } } }
    return j?.data?.user?.style?.paint ?? null
  } catch {
    return null
  }
}

/**
 * Returns the cached 7TV cosmetic for a user, or undefined — triggering a background fetch that
 * updates the store (and re-renders subscribers) when it lands. Safe to call every render.
 */
export function ensureSevenTvCosmetic(twitchId?: string): Cosmetic | undefined {
  if (!twitchId) return undefined
  const cached = useSevenTvColors.getState().cosmetics[twitchId]
  if (cached) return cached
  if (inFlight.has(twitchId) || negative.has(twitchId)) return undefined
  inFlight.add(twitchId)
  // through the main process — a raw renderer fetch to 7tv.io is blocked by the app CSP
  window.sticki
    .fetchJson(`https://7tv.io/v3/users/twitch/${twitchId}`)
    .then(async (res) => {
      const j = res.json as {
        user?: { id?: string; style?: { color?: number; paint_id?: string | null } }
      } | null
      const style = j?.user?.style
      const color = style?.color && style.color !== 0 ? intToHex(style.color) : undefined
      let cosmetic: Cosmetic | undefined
      if (style?.paint_id && j?.user?.id) {
        const paint = await fetchPaint(j.user.id)
        if (paint) {
          const css = paintToCss(paint)
          cosmetic = {
            color,
            paint: css,
            paintColor: paint.color ? intToHex(paint.color) : (color ?? undefined)
          }
        }
      }
      if (!cosmetic && color) cosmetic = { color }
      if (cosmetic) useSevenTvColors.getState().setCosmetic(twitchId, cosmetic)
      else negative.add(twitchId)
    })
    .catch(() => {
      /* offline / rate-limited — try again next session */
    })
    .finally(() => inFlight.delete(twitchId))
  return undefined
}

/** back-compat solid-color helper (chat pane / overlay that only want a flat color) */
export function ensureSevenTvColor(twitchId?: string): string | undefined {
  const c = ensureSevenTvCosmetic(twitchId)
  return c?.color ?? c?.paintColor
}
