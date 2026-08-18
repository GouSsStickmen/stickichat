import { create } from 'zustand'
import { host } from './platform'

/**
 * BetterTTV badges. BTTV publishes its whole badge roster as one small document
 * (~165 entries: developers, supporters, staff), keyed by the holder's TWITCH user id — so a
 * single request at startup covers every user we will ever render, and there is nothing to
 * fetch per message.
 *
 * NB: BTTV has no nick-paint/nick-color API — badges are the only cosmetic it exposes.
 * Animated nick colors come from 7TV (see seventvCosmetics).
 */
export interface BttvBadge {
  /** badge artwork (SVG) */
  url: string
  /** hover text, e.g. "NightDev Developer" */
  description: string
}

interface BttvState {
  /** twitchUserId -> badge */
  badges: Record<string, BttvBadge>
  loaded: boolean
  setBadges: (b: Record<string, BttvBadge>) => void
}

export const useBttvBadges = create<BttvState>()((set) => ({
  badges: {},
  loaded: false,
  setBadges: (badges) => set({ badges, loaded: true })
}))

interface RawBadge {
  providerId?: string
  badge?: { description?: string; svg?: string }
}

let started = false

/** fetch the roster once per session (idempotent, safe to call from any render) */
export function ensureBttvBadges(): void {
  if (started) return
  started = true
  // through the platform host: the desktop CSP blocks a raw renderer fetch, and on
  // Android a direct one is blocked by CORS — both need the native side
  host()
    .request('https://api.betterttv.net/3/cached/badges')
    .then((res) => {
      const list = res.json as RawBadge[] | null
      if (!res.ok || !Array.isArray(list)) return
      const map: Record<string, BttvBadge> = {}
      for (const b of list) {
        if (!b.providerId || !b.badge?.svg) continue
        map[b.providerId] = { url: b.badge.svg, description: b.badge.description ?? 'BetterTTV' }
      }
      useBttvBadges.getState().setBadges(map)
    })
    .catch(() => {
      /* offline — badges are cosmetic, retry next session */
    })
}
