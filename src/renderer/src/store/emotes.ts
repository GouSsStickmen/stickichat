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
  ownerAvatars: {},
  globalBadges: {},
  channelBadges: {},
  cheermotes: {},
  version: 0,
  setGlobalEmotes: (m) => set((s) => ({ globalEmotes: m, version: s.version + 1 })),
  setChannelEmotes: (channel, m) =>
    set((s) => ({
      channelEmotes: { ...s.channelEmotes, [channel]: m },
      version: s.version + 1
    })),
  setTwitchEmotes: (accountId, list) =>
    set((s) => ({
      twitchByAccount: { ...s.twitchByAccount, [accountId]: list },
      version: s.version + 1
    })),
  setOwnerNames: (names) =>
    set((s) => ({ ownerNames: { ...s.ownerNames, ...names }, version: s.version + 1 })),
  setOwnerAvatars: (avatars) =>
    set((s) => ({ ownerAvatars: { ...s.ownerAvatars, ...avatars }, version: s.version + 1 })),
  setGlobalBadges: (b) => set((s) => ({ globalBadges: b, version: s.version + 1 })),
  setChannelBadges: (channel, b) =>
    set((s) => ({
      channelBadges: { ...s.channelBadges, [channel]: b },
      version: s.version + 1
    })),
  setCheermotes: (channel, list) =>
    set((s) => ({
      cheermotes: { ...s.cheermotes, [channel]: list },
      version: s.version + 1
    }))
}))

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
