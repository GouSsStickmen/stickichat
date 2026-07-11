import { create } from 'zustand'
import { BadgeRef, ChatMessage } from '../types'
import { useSettingsStore } from './settings'

export type ConnState = 'connecting' | 'open' | 'closed'

/** large base so prepended history can subtract from it without going negative */
const FIRST_INDEX_BASE = 1e9

interface ChatState {
  /** channel login -> ring buffer of messages */
  messages: Record<string, ChatMessage[]>
  /**
   * channel login -> Virtuoso firstItemIndex. Bumped up when the ring buffer trims from the
   * front and down when history is prepended, so the list's scroll position stays put instead
   * of jumping when messages are added/removed at the edges under load.
   */
  firstIndex: Record<string, number>
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
  appendMessages: (channel: string, msgs: ChatMessage[]) => void
  prependMessages: (channel: string, msgs: ChatMessage[]) => void
  markDeleted: (channel: string, messageId: string) => void
  markUserMessagesDeleted: (channel: string, userId: string) => void
  clearChannel: (channel: string) => void
  dropChannel: (channel: string) => void
  setChannelId: (channel: string, id: string) => void
  setConnState: (s: ConnState) => void
  setLiveChannels: (live: Record<string, boolean>) => void
  setChannelNames: (names: Record<string, string>) => void
  setChannelAccents: (accents: Record<string, string>) => void
  setStreamInfo: (info: Record<string, { viewers: number; title: string; startedAt: string }>) => void
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
  firstIndex: {},
  channelIds: {},
  connState: 'connecting',
  liveChannels: {},
  channelNames: {},
  channelAccents: {},
  streamInfo: {},
  unreadMentions: {},
  unreadMessages: {},
  lastReadAt: {},
  appendMessages: (channel, msgs) =>
    set((s) => {
      const limit = useSettingsStore.getState().settings.messageLimit
      const cur = s.messages[channel] ?? []
      let next = [...cur, ...msgs]
      let removed = 0
      // trim in BATCHES, not every message: at steady-state (buffer full) trimming one item
      // per incoming message bumps firstItemIndex constantly, which makes Virtuoso nudge the
      // scroll a few px on every send. Let it overshoot by SLACK, then cut back to the limit.
      const SLACK = 200
      if (next.length > limit + SLACK) {
        removed = next.length - limit
        next = next.slice(removed)
      }
      const base = s.firstIndex[channel] ?? FIRST_INDEX_BASE
      return {
        messages: { ...s.messages, [channel]: next },
        // trimming from the front shifts every item's absolute index up by `removed`
        firstIndex: removed ? { ...s.firstIndex, [channel]: base + removed } : s.firstIndex
      }
    }),
  prependMessages: (channel, msgs) =>
    set((s) => {
      const cur = s.messages[channel] ?? []
      // history arrives after live messages may have started; dedupe by id
      const seen = new Set(cur.map((m) => m.id))
      const add = msgs.filter((m) => !seen.has(m.id))
      if (add.length === 0) return s
      const base = s.firstIndex[channel] ?? FIRST_INDEX_BASE
      return {
        messages: { ...s.messages, [channel]: [...add, ...cur] },
        // prepending pushes the first item's absolute index down by however many we added
        firstIndex: { ...s.firstIndex, [channel]: base - add.length }
      }
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
      const firstIndex = { ...s.firstIndex }
      delete firstIndex[channel]
      return { messages, firstIndex }
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
