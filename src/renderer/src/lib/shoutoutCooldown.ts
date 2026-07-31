import { create } from 'zustand'

/**
 * Twitch rate-limits shoutouts twice over: one every 2 minutes per channel, and the same
 * target no more than once an hour. The API just answers 429 with no hint of when you may
 * try again, so we time it locally from our own successful sends and show a countdown —
 * otherwise giving several shoutouts in a row is pure guesswork.
 */
const CHANNEL_COOLDOWN_MS = 2 * 60 * 1000
const TARGET_COOLDOWN_MS = 60 * 60 * 1000

interface ShoutoutState {
  /** broadcaster id -> timestamp of our last shoutout in that channel */
  lastPerChannel: Record<string, number>
  /** "channelId:targetId" -> timestamp of the last shoutout for that target */
  lastPerTarget: Record<string, number>
  record: (channelId: string, targetId: string) => void
  /** ticks once a second while any cooldown is running, so components re-render */
  tick: number
}

export const useShoutoutCooldown = create<ShoutoutState>()((set) => ({
  lastPerChannel: {},
  lastPerTarget: {},
  tick: 0,
  record: (channelId, targetId) =>
    set((s) => ({
      lastPerChannel: { ...s.lastPerChannel, [channelId]: Date.now() },
      lastPerTarget: { ...s.lastPerTarget, [`${channelId}:${targetId}`]: Date.now() }
    }))
}))

let timer: number | null = null
/** keep the countdown moving only while something is actually on cooldown */
function ensureTicking(): void {
  if (timer !== null) return
  timer = window.setInterval(() => {
    const s = useShoutoutCooldown.getState()
    const busy =
      Object.values(s.lastPerChannel).some((t) => Date.now() - t < CHANNEL_COOLDOWN_MS) ||
      Object.values(s.lastPerTarget).some((t) => Date.now() - t < TARGET_COOLDOWN_MS)
    if (!busy) {
      if (timer !== null) window.clearInterval(timer)
      timer = null
      return
    }
    useShoutoutCooldown.setState((cur) => ({ tick: cur.tick + 1 }))
  }, 1000)
}

/** call after a shoutout actually went through */
export function recordShoutout(channelId: string, targetId: string): void {
  useShoutoutCooldown.getState().record(channelId, targetId)
  ensureTicking()
}

export interface ShoutoutStatus {
  /** seconds until ANY shoutout may be given in this channel (0 = ready) */
  channelLeft: number
  /** seconds until THIS target may be shouted out again (0 = ready) */
  targetLeft: number
  /** the blocking wait, in seconds (0 = go ahead) */
  left: number
}

export function shoutoutStatus(channelId: string, targetId?: string): ShoutoutStatus {
  const s = useShoutoutCooldown.getState()
  const now = Date.now()
  const chanAt = s.lastPerChannel[channelId] ?? 0
  const channelLeft = Math.max(0, Math.ceil((CHANNEL_COOLDOWN_MS - (now - chanAt)) / 1000))
  const tgtAt = targetId ? (s.lastPerTarget[`${channelId}:${targetId}`] ?? 0) : 0
  const targetLeft = targetId ? Math.max(0, Math.ceil((TARGET_COOLDOWN_MS - (now - tgtAt)) / 1000)) : 0
  return { channelLeft, targetLeft, left: Math.max(channelLeft, targetLeft) }
}

/** "1:59" / "45с" style compact countdown */
export function formatCooldown(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60)
    return `${m}:${String(seconds % 60).padStart(2, '0')}`
  }
  return `${seconds}`
}
