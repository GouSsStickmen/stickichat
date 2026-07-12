import { create } from 'zustand'
import { BadgeRef, ChatMessage } from '../types'
import { useSettingsStore } from './settings'

export type ConnState = 'connecting' | 'open' | 'closed'

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
  streamInfo: Record<string, { viewers: number; title: string; startedAt: string }>
  /** channel login -> has an unseen mention of one of my accounts */
  unreadMentions: Record<string, boolean>
  /** channel login -> has any unseen message at all (inactive tabs only) */
  unreadMessages: Record<string, boolean>
  /** channel login -> timestamp up to which the user has "seen" messages */
  lastReadAt: Record<string, number>
  /** "channel:userId" -> timeout info for MY accounts (until: -1 = permanent ban) */
  selfTimeouts: Record<string, { until: number; reason?: string }>
  appendMessages: (channel: string, msgs: ChatMessage[]) => void
  prependMessages: (channel: string, msgs: ChatMessage[]) => void
  markDeleted: (channel: string, messageId: string) => void
  /** retroactively collapse recent subgift lines under a mass-gift header */
  groupGifts: (channel: string, gifter: string, headerId: string, sinceTs: number) => void
  markUserMessagesDeleted: (channel: string, userId: string) => void
  clearChannel: (channel: string) => void
  dropChannel: (channel: string) => void
  setChannelId: (channel: string, id: string) => void
  setConnState: (s: ConnState) => void
  setLiveChannels: (live: Record<string, boolean>) => void
  setChannelNames: (names: Record<string, string>) => void
  setChannelAccents: (accents: Record<string, string>) => void
  setStreamInfo: (info: Record<string, { viewers: number; title: string; startedAt: string }>) => void
  setSelfTimeout: (channel: string, userId: string, until: number, reason?: string) => void
  setUnreadMention: (channel: string) => void
  clearUnreadMentions: (channels: string[]) => void
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

export const useChatStore = create<ChatState>()((set) => ({
  messages: {},
  channelIds: {},
  connState: 'connecting',
  liveChannels: {},
  channelNames: {},
  channelAccents: {},
  streamInfo: {},
  unreadMentions: {},
  unreadMessages: {},
  lastReadAt: {},
  selfTimeouts: {},
  appendMessages: (channel, msgs) =>
    set((s) => {
      const limit = useSettingsStore.getState().settings.messageLimit
      const cur = s.messages[channel] ?? []
      let next = [...cur, ...msgs]
      // trim in BATCHES, not every message: at steady-state (buffer full) trimming one item
      // per incoming message made the scroll nudge a few px on every send. Let it overshoot
      // by SLACK, then cut back to the limit — so a trim happens once per ~200 messages.
      const SLACK = 200
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
      return { lastReadAt }
    })
}))
