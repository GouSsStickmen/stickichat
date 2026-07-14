import { create } from 'zustand'

/**
 * Lazily-fetched 7TV cosmetic nick colors, keyed by twitch user id. 7TV exposes a user's
 * chosen solid color at /v3/users/twitch/<id> (user.style.color, an RGBA int). We fetch it
 * once per user, cache it in localStorage forever, and dedupe in-flight + negative lookups so
 * a busy chat doesn't hammer the API. Only used when the "7TV nick colors" setting is on.
 */
interface SevenTvColorsState {
  colors: Record<string, string> // twitchUserId -> "#rrggbb"
  setColor: (id: string, color: string) => void
}

const CACHE_KEY = 'sticki:stvColors:v1'

function loadCache(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
  } catch {
    return {}
  }
}

export const useSevenTvColors = create<SevenTvColorsState>()((set) => ({
  colors: loadCache(),
  setColor: (id, color) =>
    set((s) => {
      const colors = { ...s.colors, [id]: color }
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(colors))
      } catch {
        /* quota — non-critical */
      }
      return { colors }
    })
}))

// users currently being fetched, and users we've confirmed have no 7TV color (don't refetch)
const inFlight = new Set<string>()
const negative = new Set<string>()

/** 7TV stores the color as a signed 32-bit RGBA int (0xRRGGBBAA) */
function intToHex(c: number): string {
  const u = c >>> 0
  const r = (u >>> 24) & 0xff
  const g = (u >>> 16) & 0xff
  const b = (u >>> 8) & 0xff
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Returns the cached 7TV color for a user, or undefined — triggering a background fetch that
 * updates the store (and re-renders subscribers) when it lands. Safe to call every render.
 */
export function ensureSevenTvColor(twitchId?: string): string | undefined {
  if (!twitchId) return undefined
  const cached = useSevenTvColors.getState().colors[twitchId]
  if (cached) return cached
  if (inFlight.has(twitchId) || negative.has(twitchId)) return undefined
  inFlight.add(twitchId)
  // go through the main process — a raw renderer fetch to 7tv.io is blocked by the app CSP
  window.sticki
    .fetchJson(`https://7tv.io/v3/users/twitch/${twitchId}`)
    .then((res) => {
      const j = res.json as { user?: { style?: { color?: number } } } | null
      const color = j?.user?.style?.color
      if (typeof color === 'number' && color !== 0) {
        useSevenTvColors.getState().setColor(twitchId, intToHex(color))
      } else {
        negative.add(twitchId)
      }
    })
    .catch(() => {
      /* offline / rate-limited — try again next session */
    })
    .finally(() => inFlight.delete(twitchId))
  return undefined
}
