import { create } from 'zustand'
import { EmoteMap } from '../types'
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
  globalBadges: BadgeMap
  channelBadges: Record<string, BadgeMap>
  /** bumped whenever any emote/badge set changes — used to invalidate render memos */
  version: number
  setGlobalEmotes: (m: EmoteMap) => void
  setChannelEmotes: (channel: string, m: EmoteMap) => void
  setTwitchEmotes: (accountId: string, list: TwitchUserEmote[]) => void
  setOwnerNames: (names: Record<string, string>) => void
  setGlobalBadges: (b: BadgeMap) => void
  setChannelBadges: (channel: string, b: BadgeMap) => void
}

export const useEmotesStore = create<EmotesState>()((set) => ({
  globalEmotes: new Map(),
  channelEmotes: {},
  twitchByAccount: {},
  ownerNames: {},
  globalBadges: {},
  channelBadges: {},
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
  setGlobalBadges: (b) => set((s) => ({ globalBadges: b, version: s.version + 1 })),
  setChannelBadges: (channel, b) =>
    set((s) => ({
      channelBadges: { ...s.channelBadges, [channel]: b },
      version: s.version + 1
    }))
}))

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
