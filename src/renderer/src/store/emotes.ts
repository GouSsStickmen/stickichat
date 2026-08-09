import { create } from 'zustand'
import { Cheermote, CheermoteTier, EmoteMap } from '../types'
import type { TwitchUserEmote } from '../lib/helix'

export type BadgeMap = Record<string, string> // "setId/version" -> image url

interface EmotesState {
  /** merged global 3rd-party emotes */
  globalEmotes: EmoteMap
  /** channel login -> merged channel emotes (overrides global) */
  channelEmotes: Record<string, EmoteMap>
  /** account id -> twitch emotes usable by that account (incl. sub emotes) */
  twitchByAccount: Record<string, TwitchUserEmote[]>
  /** twitch user id -> display name, for labeling emote groups by channel */
  ownerNames: Record<string, string>
  /** twitch user id -> login, used to build the channel URL when an emote is clicked */
  ownerLogins: Record<string, string>
  /** twitch user id -> avatar url, for the emote-picker owner rail */
  ownerAvatars: Record<string, string>
  globalBadges: BadgeMap
  channelBadges: Record<string, BadgeMap>
  /** channel login -> cheermotes (bit icons), includes global ones */
  cheermotes: Record<string, Cheermote[]>
  /** bumped whenever any emote/badge set changes — used to invalidate render memos */
  version: number
  setGlobalEmotes: (m: EmoteMap) => void
  setChannelEmotes: (channel: string, m: EmoteMap) => void
  setTwitchEmotes: (accountId: string, list: TwitchUserEmote[]) => void
  setOwnerNames: (names: Record<string, string>) => void
  setOwnerLogins: (logins: Record<string, string>) => void
  setOwnerAvatars: (avatars: Record<string, string>) => void
  setGlobalBadges: (b: BadgeMap) => void
  setChannelBadges: (channel: string, b: BadgeMap) => void
  setCheermotes: (channel: string, list: Cheermote[]) => void
}

export const useEmotesStore = create<EmotesState>()((set) => ({
  globalEmotes: new Map(),
  channelEmotes: {},
  twitchByAccount: {},
  ownerNames: {},
  ownerLogins: {},
  ownerAvatars: {},
  globalBadges: {},
  channelBadges: {},
  cheermotes: {},
  version: 0,
  setGlobalEmotes: (m) => {
    set({ globalEmotes: m })
    bumpVersion()
  },
  setChannelEmotes: (channel, m) => {
    set((s) => ({ channelEmotes: { ...s.channelEmotes, [channel]: m } }))
    bumpVersion()
  },
  setTwitchEmotes: (accountId, list) => {
    set((s) => ({ twitchByAccount: { ...s.twitchByAccount, [accountId]: list } }))
    bumpVersion()
  },
  setOwnerNames: (names) => {
    set((s) => ({ ownerNames: { ...s.ownerNames, ...names } }))
    bumpVersion()
  },
  setOwnerLogins: (logins) => {
    set((s) => ({ ownerLogins: { ...s.ownerLogins, ...logins } }))
    bumpVersion()
  },
  setOwnerAvatars: (avatars) => {
    set((s) => ({ ownerAvatars: { ...s.ownerAvatars, ...avatars } }))
    bumpVersion()
  },
  setGlobalBadges: (b) => {
    set({ globalBadges: b })
    bumpVersion()
  },
  setChannelBadges: (channel, b) => {
    set((s) => ({ channelBadges: { ...s.channelBadges, [channel]: b } }))
    bumpVersion()
  },
  setCheermotes: (channel, list) => {
    set((s) => ({ cheermotes: { ...s.cheermotes, [channel]: list } }))
    bumpVersion()
  }
}))

/**
 * Announce "the emote tables changed" AT MOST ONCE PER FRAME.
 *
 * `version` is the signal every message watches, and it is far more expensive than it looks:
 * it is a prop on every rendered message (so it breaks their memo together), it is part of the
 * key of the tokenized-layout cache (so it throws the whole cache away), and it is part of the
 * chat list's layout key (so every row is measured again). One bump is a full re-render, a full
 * re-tokenize and a full re-measure of everything on screen.
 *
 * The data itself is written immediately — lookups always see the newest tables. Only the
 * announcement waits. That matters because opening thirty channels fires roughly a hundred and
 * fifty of these within the first minute: global emotes, then per channel a 7TV set, a BTTV
 * set, an FFZ set, a badge set, a cheermote list, owner names and owner avatars. Each one was
 * paying for the whole screen. Profiled: repeated 150-millisecond tasks with an almost empty
 * message buffer, which is what gave it away — the cost had nothing to do with the chat.
 */
let bumpQueued = false

function bumpVersion(): void {
  if (bumpQueued) return
  bumpQueued = true
  const flush = (): void => {
    bumpQueued = false
    useEmotesStore.setState((s) => ({ version: s.version + 1 }))
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush)
  else setTimeout(flush, 16)
}

/**
 * Resolve a cheermote word like "Cheer100" for a channel → its icon + amount + tier color.
 * Returns undefined for non-cheermote words.
 */
export function lookupCheermote(
  channel: string
): (word: string) => { bits: number; tier: CheermoteTier } | undefined {
  const list = useEmotesStore.getState().cheermotes[channel] ?? []
  return (word) => {
    const m = /^([a-z]+)(\d+)$/i.exec(word)
    if (!m) return undefined
    const prefix = m[1].toLowerCase()
    const bits = parseInt(m[2], 10)
    const cm = list.find((c) => c.prefix === prefix)
    if (!cm) return undefined
    const tier = cm.tiers.find((t) => bits >= t.min) ?? cm.tiers[cm.tiers.length - 1]
    return tier ? { bits, tier } : undefined
  }
}

/** resolve an emote by code for a channel (channel set wins over global) */
export function lookupEmote(channel: string): (code: string) => import('../types').Emote | undefined {
  const st = useEmotesStore.getState()
  const ch = st.channelEmotes[channel]
  const gl = st.globalEmotes
  return (code) => ch?.get(code) ?? gl.get(code)
}

export function lookupBadgeUrl(channel: string, setId: string, version: string): string | undefined {
  const st = useEmotesStore.getState()
  const key = `${setId}/${version}`
  return st.channelBadges[channel]?.[key] ?? st.globalBadges[key]
}

/** human-readable badge name (Helix `title`), e.g. "2-Year Subscriber" */
export function lookupBadgeTitle(channel: string, setId: string, version: string): string | undefined {
  const st = useEmotesStore.getState()
  const key = `${setId}/${version}:title`
  return st.channelBadges[channel]?.[key] ?? st.globalBadges[key]
}

/** the 4x badge art for the enlarged hover preview */
export function lookupBadge4x(channel: string, setId: string, version: string): string | undefined {
  const st = useEmotesStore.getState()
  const key = `${setId}/${version}:4x`
  return st.channelBadges[channel]?.[key] ?? st.globalBadges[key]
}

/**
 * Owner of a TWITCH emote, resolved by code across every account's emote list. Twitch gives
 * no public per-emote page, so a click opens the owning channel instead — for that we need
 * the owner's login, which only the user-emotes payload carries.
 */
export function lookupTwitchEmoteOwner(code: string): { login?: string; name?: string } | undefined {
  const st = useEmotesStore.getState()
  for (const list of Object.values(st.twitchByAccount)) {
    for (const e of list) {
      if (e.code === code && e.ownerId && e.ownerId !== '0') {
        return { login: st.ownerLogins[e.ownerId], name: st.ownerNames[e.ownerId] }
      }
    }
  }
  return undefined
}
