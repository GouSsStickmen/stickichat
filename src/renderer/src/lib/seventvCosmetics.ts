import type { CSSProperties } from 'react'
import { create } from 'zustand'

/**
 * Lazily-fetched 7TV cosmetic nick styling, keyed by twitch user id. 7TV exposes a user's
 * chosen solid color and/or gradient "paint" at /v3/users/twitch/<id>. A solid color renders
 * as-is; a paint renders as a CSS gradient clipped to the nick text (exactly what the user set
 * up on 7TV). We fetch once per user, cache in localStorage, and dedupe in-flight + negative
 * lookups. Only used when the "7TV nick colors" setting is on.
 */
export interface Cosmetic {
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
  /** the paint's name on 7TV ("Emerald Doppler"), shown on hover like 7TV does */
  paintName?: string
  /** 7TV badge image + tooltip, shown next to the Twitch badges */
  badgeUrl?: string
  badgeTooltip?: string
}

/**
 * A 7TV paint is a background clipped to the glyphs, so the text itself must be transparent.
 * Chromium does NOT re-clip when the background of a live element changes — the paint then
 * fills the whole box and you get a coloured bar where the nick should be. Callers therefore
 * give the element a `key` derived from the paint so it remounts on change.
 */
export function paintStyleOf(c?: Cosmetic, darkBg = true): CSSProperties | undefined {
  if (!c?.paint) return undefined
  // People pick their paint on 7TV, where chat is always dark, so plenty of paints run
  // through near-white. On a light theme those stops vanish and the nick reads with holes
  // in it ("PotatBotat" → "P⋯atB⋯at"). A hairline dark halo keeps every stop legible
  // without touching the paint's own colours — recolouring it would misrepresent the paint.
  const legible = darkBg ? '' : ' drop-shadow(0 0 0.6px rgba(0, 0, 0, 0.85)) drop-shadow(0 0 1.5px rgba(0, 0, 0, 0.45))'
  return {
    background: c.paint,
    backgroundSize: c.paintSize,
    backgroundRepeat: c.paintRepeat,
    backgroundClip: 'text',
    WebkitBackgroundClip: 'text',
    color: 'transparent',
    WebkitTextFillColor: 'transparent',
    filter: `${c.paintShadow ?? ''}${legible}`.trim() || undefined
  }
}

interface SevenTvState {
  cosmetics: Record<string, Cosmetic> // twitchUserId -> cosmetic
  /** twitchUserId -> when it was fetched, so a stale entry can be refreshed */
  fetchedAt: Record<string, number>
  setCosmetic: (id: string, c: Cosmetic) => void
}

/**
 * How long a cached cosmetic is trusted.
 *
 * This, not the EventAPI, is what actually notices a changed paint. Measured against
 * wss://events.7tv.io/v3 on a busy channel: subscribing to `entitlement.*` scoped to the
 * channel produced ONE entitlement dispatch in 75 seconds, and it was an EMOTE_SET, not a
 * paint. 7TV only dispatches a user's entitlements to a channel where that user has
 * PRESENCE, and presence is published by their own 7TV client — so for everyone without the
 * extension or Chatterino open, no event will ever arrive and this timer is the whole
 * mechanism. At ten minutes that meant someone could change their colour, keep talking, and
 * still show the old one for most of a stream.
 *
 * A cosmetic is only re-fetched when the user actually renders, so the cost tracks the
 * people on screen rather than the whole roster, and every fetch goes through the gate below.
 */
const COSMETIC_TTL = 2 * 60 * 1000

// v3: entries now carry a timestamp so they can expire (v2 had no TTL and went stale forever)
const CACHE_KEY = 'sticki:stvCosmetics:v3'

function loadCache(): Record<string, Cosmetic> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
  } catch {
    return {}
  }
}

export const useSevenTvColors = create<SevenTvState>()((set) => ({
  cosmetics: loadCache(),
  fetchedAt: {},
  setCosmetic: (id, c) =>
    set((s) => {
      const cosmetics = { ...s.cosmetics, [id]: c }
      const fetchedAt = { ...s.fetchedAt, [id]: Date.now() }
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cosmetics))
      } catch {
        /* quota — non-critical */
      }
      return { cosmetics, fetchedAt }
    })
}))

// in-flight fetches are stored as shared promises so both the sync `ensure` and the async
// `await` variant hook onto the same request (the overlay needs to await before it pushes)
const inFlight = new Map<string, Promise<Cosmetic | undefined>>()
const negative = new Set<string>()

/**
 * A global gate on how many cosmetic requests may be in flight at once.
 *
 * Every fetch here fans out into a REST call plus a GQL call, so an unbounded burst saturates
 * the network, gets rate-limited (which used to wipe cached colours) and pegs the CPU hard
 * enough to stutter audio in other apps. Chat drips users in one at a time, but a list that
 * mounts hundreds of rows at once — the highlights panel restoring saved history — does not,
 * so the limit lives on the fetch itself rather than on any one caller.
 */
const MAX_PARALLEL = 4
let running = 0
const waiting: (() => void)[] = []

function acquire(): Promise<void> {
  if (running < MAX_PARALLEL) {
    running++
    return Promise.resolve()
  }
  return new Promise((r) => waiting.push(r))
}
function release(): void {
  const next = waiting.shift()
  if (next) next()
  else running--
}

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
  name?: string
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
          'query($id:ObjectID!){user(id:$id){style{paint{name function color angle shape image_url repeat stops{at color} shadows{x_offset y_offset radius color}} badge{id name tooltip host{url files{name}}}}}}',
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

/** resolve true once a paint's background image has really decoded (false on error/timeout) */
function imageLoads(cssUrl: string): Promise<boolean> {
  const m = /url\('([^']+)'\)/.exec(cssUrl)
  if (!m) return Promise.resolve(true)
  return new Promise((resolve) => {
    const img = new Image()
    const done = (ok: boolean): void => {
      img.onload = img.onerror = null
      resolve(ok)
    }
    img.onload = () => done(true)
    img.onerror = () => done(false)
    img.src = m[1]
    window.setTimeout(() => done(false), 8000)
  })
}

/** does the actual REST (+GQL) fetch once, caches the result, and resolves with the cosmetic */
function fetchCosmetic(twitchId: string, force = false): Promise<Cosmetic | undefined> {
  const st = useSevenTvColors.getState()
  const cached = st.cosmetics[twitchId]
  const fresh = Date.now() - (st.fetchedAt[twitchId] ?? 0) < COSMETIC_TTL
  if (cached && fresh && !force) return Promise.resolve(cached)
  if (negative.has(twitchId) && !force) return Promise.resolve(undefined)
  const existing = inFlight.get(twitchId)
  if (existing) return existing
  // through the main process — a raw renderer fetch to 7tv.io is blocked by the app CSP
  const p = acquire()
    .then(() => window.sticki.fetchJson(`https://7tv.io/v3/users/twitch/${twitchId}`))
    .then(async (res) => {
      // A failed/rate-limited request has no body. Treating that as "this user has no
      // cosmetic" is what erased real colours during a refresh burst — bail out and keep
      // whatever we already had.
      if (!res.ok || !res.json) return useSevenTvColors.getState().cosmetics[twitchId]
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
            paintName: paint?.name,
            badgeUrl,
            badgeTooltip: badge?.tooltip ?? badge?.name ?? undefined
          }
        }
      }
      if (!cosmetic && color) cosmetic = { color }
      if (cosmetic) {
        // a URL paint makes the nick text transparent so the image shows through it. If that
        // image never loads the nick is invisible and only its box shows — the "rectangle
        // instead of a nick" report. Commit the paint only once the image is really there.
        if (cosmetic.paint?.startsWith('url(')) {
          const ok = await imageLoads(cosmetic.paint)
          if (!ok) {
            const { paint, paintSize, paintRepeat, paintShadow, ...rest } = cosmetic
            void paint, paintSize, paintRepeat, paintShadow
            cosmetic = rest
          }
        }
        useSevenTvColors.getState().setCosmetic(twitchId, cosmetic)
      } else {
        // the response was fine and the user genuinely has no cosmetic — clear ours
        useSevenTvColors.getState().setCosmetic(twitchId, {})
        negative.add(twitchId)
      }
      return cosmetic
    })
    .catch(() => {
      /* offline / rate-limited — try again next session */
      return undefined
    })
    .finally(() => {
      inFlight.delete(twitchId)
      release()
    })
  inFlight.set(twitchId, p)
  return p
}

/**
 * Returns the cached 7TV cosmetic for a user, or undefined — triggering a background fetch that
 * updates the store (and re-renders subscribers) when it lands. Safe to call every render.
 */
export function ensureSevenTvCosmetic(twitchId?: string): Cosmetic | undefined {
  if (!twitchId) return undefined
  const st = useSevenTvColors.getState()
  const cached = st.cosmetics[twitchId]
  const stale = Date.now() - (st.fetchedAt[twitchId] ?? 0) >= COSMETIC_TTL
  // keep showing what we have while a stale entry refreshes in the background, so a changed
  // paint appears on its own instead of waiting for a restart
  if (stale) void fetchCosmetic(twitchId)
  if (cached) return cached
  if (negative.has(twitchId)) return undefined
  return undefined
}

/**
 * Forget every cached cosmetic and re-read them, a few at a time.
 *
 * Firing one request per cached user at once (and each of those spawns a second GQL call)
 * saturated the network and pegged the CPU hard enough to stutter audio in other apps, and
 * the resulting rate-limiting then wiped colours. Refreshing is a background chore, so it
 * runs with a small concurrency limit and yields between batches.
 */
const REFRESH_CONCURRENCY = 3

export async function refreshAllSevenTvCosmetics(): Promise<void> {
  const ids = Object.keys(useSevenTvColors.getState().cosmetics)
  negative.clear()
  useSevenTvColors.setState({ fetchedAt: {} })
  for (let i = 0; i < ids.length; i += REFRESH_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + REFRESH_CONCURRENCY).map((id) => fetchCosmetic(id, true)))
    // let the UI (and everything else on the machine) breathe between batches
    await new Promise((r) => setTimeout(r, 120))
  }
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

// ---------------------------------------------------------------------------
// LIVE cosmetics (7TV EventAPI)
//
// Polling could never feel instant: a paint change only showed up when a cache entry
// happened to expire. The EventAPI pushes the same two things Chatterino listens for —
// `cosmetic.create` (what a paint/badge looks like) and `entitlement.create/delete`
// (who is wearing it) — scoped to a channel, so nick colours update within seconds.
// ---------------------------------------------------------------------------

/** cosmetic id -> its rendered form, remembered until a grant references it */
const paintDefs = new Map<string, PaintCss & { color?: string; name?: string }>()
const badgeDefs = new Map<string, { url: string; tooltip: string }>()

/** feed one EventAPI cosmetic message into the store */
export function applyLiveCosmetic(e: {
  kind: 'definition' | 'grant' | 'revoke'
  type: string
  id: string
  data?: Record<string, unknown>
  twitchId?: string
}): void {
  if (e.kind === 'definition') {
    if (e.type === 'PAINT') {
      const paint = e.data as unknown as Paint
      const css = paintToCss(paint)
      if (css) paintDefs.set(e.id, { ...css, color: paint.color ? intToHex(paint.color) : undefined, name: paint.name })
    } else {
      const b = e.data as unknown as StvBadge
      const url = badgeImage(b)
      if (url) badgeDefs.set(e.id, { url, tooltip: b.tooltip ?? b.name ?? '7TV' })
    }
    return
  }

  const id = e.twitchId
  if (!id) return
  const store = useSevenTvColors.getState()
  const cur = store.cosmetics[id] ?? {}

  if (e.kind === 'revoke') {
    const next: Cosmetic = { ...cur }
    if (e.type === 'PAINT') {
      delete next.paint
      delete next.paintSize
      delete next.paintRepeat
      delete next.paintShadow
      delete next.paintColor
    } else {
      delete next.badgeUrl
      delete next.badgeTooltip
    }
    negative.delete(id)
    store.setCosmetic(id, next)
    return
  }

  if (e.type === 'PAINT') {
    const def = paintDefs.get(e.id)
    // The grant names a paint whose `cosmetic.create` we never saw — it was broadcast before
    // we subscribed, or on a connection we have since lost. Dropping it wasted the one live
    // signal we get, so ask 7TV for this user directly instead; the fetch carries the full
    // paint with it.
    if (!def) {
      negative.delete(id)
      void fetchCosmetic(id, true)
      return
    }
    negative.delete(id)
    const commit = (withImage: boolean): void =>
      store.setCosmetic(id, {
        ...cur,
        paint: withImage ? def.background : undefined,
        paintSize: withImage ? def.size : undefined,
        paintRepeat: withImage ? def.repeat : undefined,
        paintShadow: withImage ? def.shadow : undefined,
        paintColor: def.color ?? cur.paintColor,
        paintName: def.name ?? cur.paintName
      })
    // same guard as the fetch path: never make the nick transparent for an image that
    // hasn't loaded, or the user sees an empty rectangle where their name should be
    if (def.background.startsWith('url(')) void imageLoads(def.background).then(commit)
    else commit(true)
  } else {
    const def = badgeDefs.get(e.id)
    if (!def) {
      negative.delete(id)
      void fetchCosmetic(id, true)
      return
    }
    negative.delete(id)
    store.setCosmetic(id, { ...cur, badgeUrl: def.url, badgeTooltip: def.tooltip })
  }
}
