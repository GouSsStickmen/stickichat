import { create } from 'zustand'
import { BadgeRef, ChatMessage } from '../types'
import { useSettingsStore } from './settings'

export type ConnState = 'connecting' | 'open' | 'closed'

/**
 * The restrictions a channel currently has on. Every one of them is a reason a message you try
 * to send might be refused, and until now the only way to find that out was to be refused —
 * Twitch's own reply arrives as an English NOTICE after the fact. Numbers are minutes for
 * followers-only (0 = any follower) and seconds for slow mode; `null`/absent means off.
 */
export interface RoomModes {
  emoteOnly?: boolean
  subsOnly?: boolean
  /** unique-chat / R9K: no repeating what someone else just said */
  uniqueChat?: boolean
  /** minutes a viewer must have followed for; 0 means "any follower", -1/absent = off */
  followersOnly?: number
  /** seconds between messages */
  slow?: number
}

interface ChatState {
  /** channel login -> ring buffer of messages */
  messages: Record<string, ChatMessage[]>
  /** channel login -> twitch channel id (learned from IRC tags or Helix) */
  channelIds: Record<string, string>
  connState: ConnState
  /** channel login -> currently live */
  liveChannels: Record<string, boolean>
  /** channel login -> broadcaster's display name (proper capitalization) */
  channelNames: Record<string, string>
  /** channel login -> broadcaster's chat color (accent for PRIMARY announcements) */
  channelAccents: Record<string, string>
  /** channel login -> live stream info for the pane header */
  streamInfo: Record<string, { viewers: number; title: string; startedAt: string; game: string }>
  /** channel login -> has an unseen mention of one of my accounts */
  unreadMentions: Record<string, boolean>
  /** channel login -> the custom keyword/phrase that fired while the tab was inactive */
  unreadKeywords: Record<string, string>
  /** channel login -> has any unseen message at all (inactive tabs only) */
  unreadMessages: Record<string, boolean>
  /** channel login -> timestamp up to which the user has "seen" messages */
  lastReadAt: Record<string, number>
  /** "channel:userId" -> timeout info for MY accounts (until: -1 = permanent ban) */
  selfTimeouts: Record<string, { until: number; reason?: string }>
  /** channel login -> which restricted chat modes are currently on (from ROOMSTATE) */
  roomModes: Record<string, RoomModes>
  appendMessages: (channel: string, msgs: ChatMessage[]) => void
  prependMessages: (channel: string, msgs: ChatMessage[]) => void
  /** merge a message snapshot (e.g. handed over from another window on detach/reattach)
   *  into the channel, deduped by id and sorted by time — preserves live state, not "historical" */
  seedMessages: (channel: string, msgs: ChatMessage[]) => void
  markDeleted: (channel: string, messageId: string) => void
  /** retroactively collapse recent subgift lines under a mass-gift header */
  groupGifts: (channel: string, gifter: string, headerId: string, sinceTs: number) => void
  markUserMessagesDeleted: (channel: string, userId: string) => void
  clearChannel: (channel: string) => void
  dropChannel: (channel: string) => void
  setChannelId: (channel: string, id: string) => void
  /** merge a ROOMSTATE delta — Twitch sends only the tags that CHANGED after the first one */
  patchRoomModes: (channel: string, patch: RoomModes) => void
  setConnState: (s: ConnState) => void
  setLiveChannels: (live: Record<string, boolean>) => void
  setChannelNames: (names: Record<string, string>) => void
  setChannelAccents: (accents: Record<string, string>) => void
  setStreamInfo: (info: Record<string, { viewers: number; title: string; startedAt: string; game: string }>) => void
  setSelfTimeout: (channel: string, userId: string, until: number, reason?: string) => void
  setUnreadMention: (channel: string) => void
  clearUnreadMentions: (channels: string[]) => void
  setUnreadKeyword: (channel: string, word: string) => void
  clearUnreadKeywords: (channels: string[]) => void
  setUnreadMessage: (channel: string) => void
  clearUnreadMessages: (channels: string[]) => void
  markChannelsRead: (channels: string[]) => void
}

/** shallow record equality — skips store updates (and their re-renders) when nothing changed */
function sameRecord<T>(a: Record<string, T>, b: Record<string, T>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}

/** most recent known chat color for a login in a channel (for coloring @mentions) */
export function lookupUserColor(channel: string, login: string): string | undefined {
  const msgs = useChatStore.getState().messages[channel]
  if (!msgs) return undefined
  const lower = login.toLowerCase()
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].login === lower && msgs[i].color) return msgs[i].color
  }
  return undefined
}

/**
 * Has this login written in the channel? Used to colorize nicks typed WITHOUT a leading "@":
 * only words that belong to a real chatter get treated as a mention, so ordinary words are
 * never painted by accident.
 */
export function isKnownChatter(channel: string, login: string): boolean {
  const lower = login.toLowerCase()
  // the broadcaster counts even if they never type in their own chat — their name is the
  // single most common thing people write without an "@"
  if (lower === channel.toLowerCase()) return true
  const msgs = useChatStore.getState().messages[channel]
  if (!msgs) return false
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.login === lower) return true
    // someone who was replied to / raided in is a real user here too, even with no message
    if (m.replyParent?.login === lower) return true
  }
  return false
}

/** twitch user id for a login seen in this channel's buffer (for cosmetic lookups) */
export function lookupUserId(channel: string, login: string): string | undefined {
  const msgs = useChatStore.getState().messages[channel]
  if (!msgs) return undefined
  const lower = login.toLowerCase()
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].login === lower && msgs[i].userId) return msgs[i].userId
  }
  return undefined
}

/** most recent known badges for a login in a channel (best-effort, from the local buffer) */
export function lookupUserBadges(channel: string, login: string): BadgeRef[] | undefined {
  const msgs = useChatStore.getState().messages[channel]
  if (!msgs) return undefined
  const lower = login.toLowerCase()
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].login === lower && !msgs[i].system) return msgs[i].badges
  }
  return undefined
}

/**
 * How far the buffer may overshoot its limit before the head is cut. Zero: cut it as soon as
 * it is over, so only what actually overflowed goes.
 *
 * Batching was a workaround for the old virtualized list, where trimming on every message
 * nudged the scroll a few pixels on every send. That list is gone, and batching turned out to
 * cost more than it saved: cutting twenty rows at once moves everything below them by six
 * hundred pixels in a single commit, and any imprecision in that step is a visible flicker,
 * while cutting one row moves thirty and nothing is noticeable even if it is imperfect.
 *
 * It is also simply how Chatterino behaves — old messages disappearing one at a time rather
 * than in blocks — and that is not a coincidence, it is the same reasoning.
 */
const SLACK = 0

export const useChatStore = create<ChatState>()((set) => ({
  messages: {},
  channelIds: {},
  connState: 'connecting',
  liveChannels: {},
  channelNames: {},
  channelAccents: {},
  streamInfo: {},
  unreadMentions: {},
  unreadKeywords: {},
  unreadMessages: {},
  lastReadAt: {},
  selfTimeouts: {},
  roomModes: {},
  appendMessages: (channel, msgs) =>
    set((s) => {
      const limit = useSettingsStore.getState().settings.messageLimit
      const cur = s.messages[channel] ?? []
      // dedupe by id: a message id must be unique in the buffer, otherwise the virtualized
      // list (keyed on id) renders duplicates and breaks scrolling. This guards against any
      // double-delivery (e.g. a reconnecting reader replaying, or a stray second connection).
      const seen = new Set(cur.map((m) => m.id))
      const add = msgs.filter((m) => !seen.has(m.id))
      if (add.length === 0) return s
      let next = [...cur, ...add]
      if (next.length > limit + SLACK) next = next.slice(next.length - limit)
      return { messages: { ...s.messages, [channel]: next } }
    }),
  prependMessages: (channel, msgs) =>
    set((s) => {
      const cur = s.messages[channel] ?? []
      // history arrives after live messages may have started; dedupe by id
      const seen = new Set(cur.map((m) => m.id))
      const add = msgs.filter((m) => !seen.has(m.id))
      if (add.length === 0) return s
      return { messages: { ...s.messages, [channel]: [...add, ...cur] } }
    }),
  seedMessages: (channel, msgs) =>
    set((s) => {
      if (msgs.length === 0) return s
      const limit = useSettingsStore.getState().settings.messageLimit
      const cur = s.messages[channel] ?? []
      const seen = new Set(cur.map((m) => m.id))
      const merged = [...cur, ...msgs.filter((m) => !seen.has(m.id))].sort(
        (a, b) => a.timestamp - b.timestamp
      )
      const next = merged.length > limit ? merged.slice(merged.length - limit) : merged
      return { messages: { ...s.messages, [channel]: next } }
    }),
  groupGifts: (channel, gifter, headerId, sinceTs) =>
    set((s) => {
      const cur = s.messages[channel]
      if (!cur) return s
      let changed = false
      const next = cur.map((m) => {
        if (m.giftFrom === gifter && !m.groupedUnder && m.id !== headerId && m.timestamp >= sinceTs) {
          changed = true
          return { ...m, groupedUnder: headerId }
        }
        return m
      })
      return changed ? { messages: { ...s.messages, [channel]: next } } : s
    }),
  markDeleted: (channel, messageId) =>
    set((s) => {
      const cur = s.messages[channel]
      if (!cur) return s
      return {
        messages: {
          ...s.messages,
          [channel]: cur.map((m) => (m.id === messageId ? { ...m, deleted: true } : m))
        }
      }
    }),
  markUserMessagesDeleted: (channel, userId) =>
    set((s) => {
      const cur = s.messages[channel]
      if (!cur) return s
      return {
        messages: {
          ...s.messages,
          [channel]: cur.map((m) => (m.userId === userId && !m.system ? { ...m, deleted: true } : m))
        }
      }
    }),
  clearChannel: (channel) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [channel]: (s.messages[channel] ?? []).map((m) => (m.system ? m : { ...m, deleted: true }))
      }
    })),
  dropChannel: (channel) =>
    set((s) => {
      const messages = { ...s.messages }
      delete messages[channel]
      return { messages }
    }),
  patchRoomModes: (channel, patch) =>
    set((s) => ({ roomModes: { ...s.roomModes, [channel]: { ...s.roomModes[channel], ...patch } } })),
  setChannelId: (channel, id) =>
    set((s) =>
      s.channelIds[channel] === id ? s : { channelIds: { ...s.channelIds, [channel]: id } }
    ),
  setConnState: (connState) => set({ connState }),
  // polled once a minute — bail out when the live set is unchanged so tab/pane subscribers
  // don't re-render (and re-tokenize) needlessly
  setLiveChannels: (liveChannels) =>
    set((s) => (sameRecord(s.liveChannels, liveChannels) ? s : { liveChannels })),
  setChannelNames: (names) =>
    set((s) => {
      const merged = { ...s.channelNames, ...names }
      return sameRecord(s.channelNames, merged) ? s : { channelNames: merged }
    }),
  setChannelAccents: (accents) =>
    set((s) => ({ channelAccents: { ...s.channelAccents, ...accents } })),
  setStreamInfo: (streamInfo) => set({ streamInfo }),
  setSelfTimeout: (channel, userId, until, reason) =>
    set((s) => {
      const key = `${channel}:${userId}`
      // don't let a reason-less IRC CLEARCHAT wipe the reason the mod feed already gave us
      const kept = reason ?? s.selfTimeouts[key]?.reason
      return { selfTimeouts: { ...s.selfTimeouts, [key]: { until, reason: kept } } }
    }),
  setUnreadMention: (channel) =>
    set((s) =>
      s.unreadMentions[channel] ? s : { unreadMentions: { ...s.unreadMentions, [channel]: true } }
    ),
  clearUnreadMentions: (channels) =>
    set((s) => {
      if (!channels.some((c) => s.unreadMentions[c])) return s
      const unreadMentions = { ...s.unreadMentions }
      for (const c of channels) delete unreadMentions[c]
      return { unreadMentions }
    }),
  setUnreadKeyword: (channel, word) =>
    set((s) =>
      s.unreadKeywords[channel] ? s : { unreadKeywords: { ...s.unreadKeywords, [channel]: word } }
    ),
  clearUnreadKeywords: (channels) =>
    set((s) => {
      if (!channels.some((c) => s.unreadKeywords[c])) return s
      const unreadKeywords = { ...s.unreadKeywords }
      for (const c of channels) delete unreadKeywords[c]
      return { unreadKeywords }
    }),
  setUnreadMessage: (channel) =>
    set((s) =>
      s.unreadMessages[channel] ? s : { unreadMessages: { ...s.unreadMessages, [channel]: true } }
    ),
  clearUnreadMessages: (channels) =>
    set((s) => {
      if (!channels.some((c) => s.unreadMessages[c])) return s
      const unreadMessages = { ...s.unreadMessages }
      for (const c of channels) delete unreadMessages[c]
      return { unreadMessages }
    }),
  markChannelsRead: (channels) =>
    set((s) => {
      const now = Date.now()
      const lastReadAt = { ...s.lastReadAt }
      for (const c of channels) lastReadAt[c] = now
      const unreadKeywords = { ...s.unreadKeywords }
      for (const c of channels) delete unreadKeywords[c]
      return { lastReadAt, unreadKeywords }
    })
}))
