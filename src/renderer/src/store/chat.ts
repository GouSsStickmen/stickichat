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

/**
 * Who has spoken in a channel, and what we know about them — kept as a map instead of found
 * by walking the buffer.
 *
 * Every one of the lookups below used to scan the whole ring buffer backwards. That is fine
 * once; it is not fine where they are actually called from. `isKnownChatter` is handed to the
 * tokenizer and asked about EVERY WORD of every message, to decide whether a bare word is
 * somebody's nick — so laying out one forty-word message walked three and a half thousand
 * messages forty times. Scrolling into a screenful of unseen history did that for thirty rows
 * at once, and the profiler caught the result: single tasks of 150 to 180 milliseconds, and one
 * of 2.3 seconds, in the middle of a scroll.
 *
 * The map is built from the same messages as they arrive, which is work proportional to what
 * arrived rather than to what is already there. Nothing else about the buffer changes.
 */
interface ChatterInfo {
  color?: string
  userId?: string
  badges?: BadgeRef[]
}

const chatterIndex = new Map<string, Map<string, ChatterInfo>>()

function indexOf(channel: string): Map<string, ChatterInfo> {
  let m = chatterIndex.get(channel)
  if (!m) {
    m = new Map()
    chatterIndex.set(channel, m)
  }
  return m
}

/** fold a batch of messages into the channel's chatter map (newest wins) */
function indexMessages(channel: string, msgs: ChatMessage[]): void {
  const m = indexOf(channel)
  for (const msg of msgs) {
    if (msg.login) {
      const cur = m.get(msg.login)
      const next: ChatterInfo = cur ? { ...cur } : {}
      if (msg.color) next.color = msg.color
      if (msg.userId) next.userId = msg.userId
      if (!msg.system && msg.badges) next.badges = msg.badges
      m.set(msg.login, next)
    }
    // someone who was replied to is a real user here even if we never saw them type
    const parent = msg.replyParent?.login
    if (parent && !m.has(parent)) m.set(parent, {})
  }
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
  return chatterIndex.get(channel)?.get(login.toLowerCase())?.color
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
  return chatterIndex.get(channel)?.has(lower) ?? false
}

/** twitch user id for a login seen in this channel's buffer (for cosmetic lookups) */
export function lookupUserId(channel: string, login: string): string | undefined {
  return chatterIndex.get(channel)?.get(login.toLowerCase())?.userId
}

/** most recent known badges for a login in a channel (best-effort, from the local buffer) */
export function lookupUserBadges(channel: string, login: string): BadgeRef[] | undefined {
  return chatterIndex.get(channel)?.get(login.toLowerCase())?.badges
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

/**
 * Is this id already in the buffer? Answered by looking at the END of it, not all of it.
 *
 * The old version built a Set of every id in the channel on every batch of messages. At three
 * and a half thousand messages that is three and a half thousand string hashes plus a throwaway
 * array of the same size — per channel, per flush. With thirty-odd channels open it was the
 * single longest thing the renderer did: measured at 178ms in one task, which is a fifth of a
 * second in which nothing moves, and it landed in the middle of scrolling as often as anywhere
 * else. That is the "it stops and then carries on" people were describing.
 *
 * A duplicate can only ever be a RECENT message: they come from a reader replaying after a
 * reconnect, or from a second connection briefly delivering the same lines. Nothing produces a
 * duplicate of something that scrolled past twenty minutes ago. So the check looks at the last
 * few hundred, which is bounded work no matter how long the buffer grows.
 */
const DEDUPE_WINDOW = 400

function recentlySeen(buf: ChatMessage[], id: string, end: 'tail' | 'head' = 'tail'): boolean {
  if (end === 'head') {
    const stop = Math.min(buf.length, DEDUPE_WINDOW)
    for (let i = 0; i < stop; i++) if (buf[i].id === id) return true
    return false
  }
  const start = Math.max(0, buf.length - DEDUPE_WINDOW)
  for (let i = buf.length - 1; i >= start; i--) if (buf[i].id === id) return true
  return false
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
      const add = msgs.filter((m) => !recentlySeen(cur, m.id))
      if (add.length === 0) return s
      indexMessages(channel, add)
      let next = [...cur, ...add]
      if (next.length > limit + SLACK) next = next.slice(next.length - limit)
      return { messages: { ...s.messages, [channel]: next } }
    }),
  prependMessages: (channel, msgs) =>
    set((s) => {
      const cur = s.messages[channel] ?? []
      // history arrives after live messages may have started; dedupe by id. History lands at
      // the FRONT, so the window that can collide with it is the front of the buffer.
      const add = msgs.filter((m) => !recentlySeen(cur, m.id, 'head'))
      if (add.length === 0) return s
      indexMessages(channel, add)
      return { messages: { ...s.messages, [channel]: [...add, ...cur] } }
    }),
  seedMessages: (channel, msgs) =>
    set((s) => {
      if (msgs.length === 0) return s
      const limit = useSettingsStore.getState().settings.messageLimit
      const cur = s.messages[channel] ?? []
      // a handover merges two whole buffers, so this one really does need to look at all of it
      const seen = new Set<string>()
      for (const m of cur) seen.add(m.id)
      const fresh = msgs.filter((m) => !seen.has(m.id))
      indexMessages(channel, fresh)
      const merged = [...cur, ...fresh].sort((a, b) => a.timestamp - b.timestamp)
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
      // the chatter map is keyed by channel too, and a closed tab should not keep paying for it
      chatterIndex.delete(channel)
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
