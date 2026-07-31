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
  /** `background-size` / `background-repeat` that go with `paint` (URL paints need them) */
  paintSize?: string
  paintRepeat?: string
  /** a CSS `filter` chain reproducing the paint's drop shadows */
  paintShadow?: string
  /** a representative flat color for the paint (used where gradient text can't render) */
  paintColor?: string
  /** 7TV badge image + tooltip, shown next to the Twitch badges */
  badgeUrl?: string
  badgeTooltip?: string
}

interface SevenTvState {
  cosmetics: Record<string, Cosmetic> // twitchUserId -> cosmetic
  setCosmetic: (id: string, c: Cosmetic) => void
}

// v2: the paint CSS builder changed (repeat/shadows/sizing + badges), so old
// entries would keep rendering the broken look forever
const CACHE_KEY = 'sticki:stvCosmetics:v2'

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

// in-flight fetches are stored as shared promises so both the sync `ensure` and the async
// `await` variant hook onto the same request (the overlay needs to await before it pushes)
const inFlight = new Map<string, Promise<Cosmetic | undefined>>()
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
  shadows?: { x_offset: number; y_offset: number; radius: number; color: number }[]
}

interface PaintCss {
  background: string
  size?: string
  repeat?: string
  shadow?: string
}

/**
 * Turn a 7TV paint definition into CSS (clipped to the nick text at the call site).
 *
 * Two things used to be dropped on the floor and made paints render wrong:
 *  - `repeat: true` means a REPEATING gradient (e.g. "Candy Cane" defines one stripe cycle
 *    over 0…0.3 and tiles it). Rendered as a plain gradient, that cycle was stretched across
 *    the whole nick — the wrong picture entirely, and 619 of ~1000 paints are gradients.
 *  - URL paints ship a small tile with no sizing, so it covered a corner of the nick instead
 *    of the text; they also need an explicit no-repeat and the highest-res layer available.
 */
function paintToCss(paint: Paint): PaintCss | undefined {
  const shadow = (paint.shadows ?? [])
    .map((sh) => `drop-shadow(${sh.x_offset}px ${sh.y_offset}px ${sh.radius}px ${intToRgba(sh.color)})`)
    .join(' ')

  if (paint.function === 'URL' && paint.image_url) {
    // 7TV hands out the 1x layer; the same path serves 2x/3x/4x — take the sharpest
    const url = paint.image_url.replace(/\/1x\.(webp|png|gif|avif)$/i, '/4x.$1')
    return {
      background: `url('${url}')`,
      size: paint.repeat ? 'auto' : '100% 100%',
      repeat: paint.repeat ? 'repeat' : 'no-repeat',
      shadow: shadow || undefined
    }
  }

  const stops = (paint.stops ?? []).map((s) => `${intToRgba(s.color)} ${(s.at * 100).toFixed(2)}%`)
  if (stops.length === 0) return undefined
  const rep = paint.repeat ? 'repeating-' : ''
  if (paint.function === 'RADIAL_GRADIENT') {
    return {
      background: `${rep}radial-gradient(${paint.shape === 'circle' ? 'circle' : 'ellipse'}, ${stops.join(', ')})`,
      shadow: shadow || undefined
    }
  }
  const angle = typeof paint.angle === 'number' ? paint.angle : 90
  return {
    background: `${rep}linear-gradient(${angle}deg, ${stops.join(', ')})`,
    shadow: shadow || undefined
  }
}

interface StvBadge {
  id?: string
  name?: string
  tooltip?: string
  host?: { url?: string; files?: { name?: string }[] }
}

/**
 * v3 GQL resolves the user's paint AND badge (the REST endpoint only hands back ids).
 * `shadows` is fetched too — most paints define them and they carry a lot of the look.
 */
async function fetchStyle(sevenTvUserId: string): Promise<{ paint: Paint | null; badge: StvBadge | null }> {
  try {
    const res = await window.sticki.fetchJson('https://7tv.io/v3/gql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query:
          'query($id:ObjectID!){user(id:$id){style{paint{function color angle shape image_url repeat stops{at color} shadows{x_offset y_offset radius color}} badge{id name tooltip host{url files{name}}}}}}',
        variables: { id: sevenTvUserId }
      })
    })
    const j = res.json as {
      data?: { user?: { style?: { paint?: Paint | null; badge?: StvBadge | null } } }
    }
    const style = j?.data?.user?.style
    return { paint: style?.paint ?? null, badge: style?.badge ?? null }
  } catch {
    return { paint: null, badge: null }
  }
}

/** pick the sharpest file the badge host offers (4x → 1x) and make the // URL absolute */
function badgeImage(badge: StvBadge | null): string | undefined {
  const host = badge?.host
  if (!host?.url) return undefined
  const names = (host.files ?? []).map((f) => f.name).filter((n): n is string => !!n)
  const best =
    ['4x.webp', '3x.webp', '2x.webp', '1x.webp'].find((n) => names.includes(n)) ?? names[names.length - 1] ?? '3x.webp'
  const base = host.url.startsWith('//') ? `https:${host.url}` : host.url
  return `${base}/${best}`
}

/** does the actual REST (+GQL) fetch once, caches the result, and resolves with the cosmetic */
function fetchCosmetic(twitchId: string): Promise<Cosmetic | undefined> {
  const cached = useSevenTvColors.getState().cosmetics[twitchId]
  if (cached) return Promise.resolve(cached)
  if (negative.has(twitchId)) return Promise.resolve(undefined)
  const existing = inFlight.get(twitchId)
  if (existing) return existing
  // through the main process — a raw renderer fetch to 7tv.io is blocked by the app CSP
  const p = window.sticki
    .fetchJson(`https://7tv.io/v3/users/twitch/${twitchId}`)
    .then(async (res) => {
      const j = res.json as {
        user?: { id?: string; style?: { color?: number; paint_id?: string | null; badge_id?: string | null } }
      } | null
      const style = j?.user?.style
      const color = style?.color && style.color !== 0 ? intToHex(style.color) : undefined
      let cosmetic: Cosmetic | undefined
      if ((style?.paint_id || style?.badge_id) && j?.user?.id) {
        const { paint, badge } = await fetchStyle(j.user.id)
        const css = paint ? paintToCss(paint) : undefined
        const badgeUrl = badgeImage(badge)
        if (css || badgeUrl) {
          cosmetic = {
            color,
            paint: css?.background,
            paintSize: css?.size,
            paintRepeat: css?.repeat,
            paintShadow: css?.shadow,
            paintColor: paint?.color ? intToHex(paint.color) : (color ?? undefined),
            badgeUrl,
            badgeTooltip: badge?.tooltip ?? badge?.name ?? undefined
          }
        }
      }
      if (!cosmetic && color) cosmetic = { color }
      if (cosmetic) useSevenTvColors.getState().setCosmetic(twitchId, cosmetic)
      else negative.add(twitchId)
      return cosmetic
    })
    .catch(() => {
      /* offline / rate-limited — try again next session */
      return undefined
    })
    .finally(() => inFlight.delete(twitchId))
  inFlight.set(twitchId, p)
  return p
}

/**
 * Returns the cached 7TV cosmetic for a user, or undefined — triggering a background fetch that
 * updates the store (and re-renders subscribers) when it lands. Safe to call every render.
 */
export function ensureSevenTvCosmetic(twitchId?: string): Cosmetic | undefined {
  if (!twitchId) return undefined
  const cached = useSevenTvColors.getState().cosmetics[twitchId]
  if (cached) return cached
  if (negative.has(twitchId)) return undefined
  void fetchCosmetic(twitchId)
  return undefined
}

/**
 * Async variant: resolves with the cosmetic (from cache or a completed fetch). The OBS overlay
 * renders each line exactly once — it has no store subscription to re-render on a late fetch —
 * so it must await this before generating the HTML, otherwise 7TV colors never appear there.
 */
export async function awaitSevenTvCosmetic(twitchId?: string): Promise<Cosmetic | undefined> {
  if (!twitchId) return undefined
  return fetchCosmetic(twitchId)
}

/** back-compat solid-color helper (chat pane / overlay that only want a flat color) */
export function ensureSevenTvColor(twitchId?: string): string | undefined {
  const c = ensureSevenTvCosmetic(twitchId)
  return c?.color ?? c?.paintColor
}
