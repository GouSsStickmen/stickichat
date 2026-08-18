import { create } from 'zustand'
import { host } from './platform'

/**
 * FrankerFaceZ badges. Like BetterTTV, FFZ publishes its whole roster as one small document
 * (`/v1/badges/ids`): a handful of badge definitions plus, per badge, the list of TWITCH user
 * ids that hold it. One request at startup covers everyone we will ever render.
 *
 * FFZ badges carry a background `color`, which is part of how they look on FFZ itself, so we
 * keep it and paint the chip behind the (usually white, transparent) artwork.
 */
export interface FfzBadge {
  url: string
  title: string
  /** badge background color, e.g. "#755000" */
  color?: string
}

interface FfzState {
  /** twitchUserId -> badges (a user can hold more than one) */
  badges: Record<string, FfzBadge[]>
  loaded: boolean
  setBadges: (b: Record<string, FfzBadge[]>) => void
}

export const useFfzBadges = create<FfzState>()((set) => ({
  badges: {},
  loaded: false,
  setBadges: (badges) => set({ badges, loaded: true })
}))

interface RawFfz {
  badges?: { id: number; title?: string; name?: string; color?: string; urls?: Record<string, string> }[]
  /** badgeId -> twitch user ids */
  users?: Record<string, (number | string)[]>
}

function abs(u: string): string {
  return u.startsWith('//') ? `https:${u}` : u
}

let started = false

/** fetch the roster once per session (idempotent, safe to call from any render) */
export function ensureFfzBadges(): void {
  if (started) return
  started = true
  // through the platform host: the desktop CSP blocks a raw renderer fetch, and on
  // Android a direct one is blocked by CORS — both need the native side
  host()
    .request('https://api.frankerfacez.com/v1/badges/ids')
    .then((res) => {
      const j = res.json as RawFfz | null
      if (!res.ok || !j?.badges) return
      const defs = new Map<string, FfzBadge>()
      for (const b of j.badges) {
        const urls = b.urls ?? {}
        const url = urls['4'] ?? urls['2'] ?? urls['1']
        if (!url) continue
        defs.set(String(b.id), {
          url: abs(url),
          title: b.title ?? b.name ?? 'FrankerFaceZ',
          color: b.color ?? undefined
        })
      }
      const map: Record<string, FfzBadge[]> = {}
      for (const [badgeId, users] of Object.entries(j.users ?? {})) {
        const def = defs.get(badgeId)
        if (!def) continue
        for (const uid of users) {
          const key = String(uid)
          ;(map[key] ??= []).push(def)
        }
      }
      useFfzBadges.getState().setBadges(map)
    })
    .catch(() => {
      /* offline — badges are cosmetic, retry next session */
    })
}
