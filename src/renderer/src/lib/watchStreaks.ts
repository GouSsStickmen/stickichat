/**
 * Watch-streak tracker. Twitch has NO public API for watch streaks — the only signal is the
 * `viewermilestone` usernotice a user triggers by sharing their streak in chat. We remember
 * the latest shared value per channel/user and surface it in the user card (best effort).
 */
const KEY = 'sticki:watchStreaks'

type StreakMap = Record<string, Record<string, { n: number; ts: number }>>

let cache: StreakMap | null = null

function load(): StreakMap {
  if (cache === null) {
    try {
      cache = JSON.parse(localStorage.getItem(KEY) ?? '{}') as StreakMap
    } catch {
      cache = {}
    }
  }
  return cache
}

let saveTimer: number | null = null
function scheduleSave(): void {
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    try {
      localStorage.setItem(KEY, JSON.stringify(cache ?? {}))
    } catch {
      /* quota — drop silently, this is best-effort data */
    }
  }, 1000)
}

export function recordWatchStreak(channel: string, login: string, n: number, ts = Date.now()): void {
  if (!channel || !login || !Number.isFinite(n) || n <= 0) return
  const m = load()
  const ch = (m[channel] ??= {})
  const key = login.toLowerCase()
  const prev = ch[key]
  // history replay may deliver an older milestone than the one we already know
  if (prev && prev.ts > ts) return
  ch[key] = { n, ts }
  const keys = Object.keys(ch)
  if (keys.length > 400) {
    keys.sort((a, b) => ch[a].ts - ch[b].ts)
    for (const k of keys.slice(0, keys.length - 400)) delete ch[k]
  }
  scheduleSave()
  // let live UI (the input-bar streak chip) refresh without polling
  window.dispatchEvent(new CustomEvent('sticki:streak'))
}

/** streak WITH the time it was last seen — the input chip needs the timestamp to tell
 *  whether the streak was already claimed during the current broadcast */
export function getWatchStreakInfo(channel: string, login: string): { n: number; ts: number } | null {
  const e = load()[channel]?.[login.toLowerCase()]
  return e && Date.now() - e.ts < 45 * 86_400_000 ? { n: e.n, ts: e.ts } : null
}

/** last KNOWN streak for a user in a channel; null when never seen or long stale */
export function getWatchStreak(channel: string, login: string): number | null {
  const e = load()[channel]?.[login.toLowerCase()]
  // milestones fire during a streak — after ~45 quiet days assume it broke
  return e && Date.now() - e.ts < 45 * 86_400_000 ? e.n : null
}
