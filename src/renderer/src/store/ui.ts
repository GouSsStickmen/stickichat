import { create } from 'zustand'
import { BadgeRef } from '../types'
import { useSettingsStore } from './settings'

export interface UserCardTarget {
  channel: string
  channelId: string
  userId: string
  login: string
  displayName: string
  color?: string
  badges: BadgeRef[]
  /** pane account used for mod actions from the card */
  accountId: string | null
  x: number
  y: number
}

export interface Toast {
  id: number
  text: string
  kind: 'ok' | 'error'
  /** stable key for "don't show again" — the message text with volatile bits stripped */
  muteKey?: string
}

export interface EmotePreviewTarget {
  url: string
  code: string
  x: number
  y: number
  /** link-preview artwork: render big and aspect-correct instead of in a square emote box */
  wide?: boolean
  /** zero-width emotes layered on top of this one — previewed as the finished combination */
  overlayUrls?: string[]
  /** extra caption lines under the name (provider, author…) */
  subtitle?: string[]
  /** requested width for a `wide` preview, px */
  wideSize?: number
}

export interface ChannelPrompt {
  /** channel login the user is offered to add */
  channel: string
  /** who started the raid / gave the shoutout (for the "X → Y" prompt text) */
  from?: string
  /** channel is already open in some tab — offer to SWITCH instead of adding */
  existing?: boolean
  /** this prompt is a shoutout (adds a "follow ↗" action + different wording) */
  shoutout?: boolean
}

/** the hype train currently running in one of the open channels (one at a time, like Twitch) */
export interface HypeTrain {
  channel: string
  level: number
  /** points into the current level and what it needs — the bar */
  value: number
  goal: number
  /** unix ms the train expires at unless someone feeds it */
  expiresAt: number
  /** last contributor, shown under the bar */
  by?: string
  /** set when it is over: the popup lingers a few seconds on the result */
  ended?: 'COMPLETED' | 'EXPIRE'
}

/**
 * The link preview that is open right now, and where on screen it was asked for.
 *
 * One at a time, and OUTSIDE the message list. A card drawn inline is part of the document:
 * opening it makes the row taller, which moves every row below it, which is a scroll problem
 * dressed up as a preview. Anchoring it to the click instead means the chat's geometry never
 * changes at all — nothing to compensate for, nothing to jump.
 */
export interface LinkCardTarget {
  url: string
  /** where the link sits on screen, so the card can open beside it and stay in the window */
  x: number
  y: number
  /** hover-opened cards close themselves when the pointer leaves; clicked ones stay */
  sticky: boolean
}

interface UiState {
  settingsOpen: boolean
  /** which settings section to land on when the modal/window opens next */
  settingsSection: string | null
  addAccountOpen: boolean
  userCard: UserCardTarget | null
  toasts: Toast[]
  emotePreview: EmotePreviewTarget | null
  /** the floating link preview card, or null when none is open */
  linkCard: LinkCardTarget | null
  /** mass-gift groups the user expanded (header message id -> true) */
  expandedGifts: Record<string, boolean>
  /** small "add this channel?" prompt (raids) */
  channelPrompt: ChannelPrompt | null
  hypeTrain: HypeTrain | null
  whispersOpen: boolean
  /** split mode: scrolling one pane scrolls the others by the same amount */
  scrollSync: boolean
  /** accounts whose token died and need a full re-authorization (persistent banner) */
  reauthAccounts: { id: string; login: string }[]
  setSettingsOpen: (v: boolean) => void
  setSettingsSection: (v: string | null) => void
  toggleGiftGroup: (id: string) => void
  setAddAccountOpen: (v: boolean) => void
  setUserCard: (v: UserCardTarget | null) => void
  toast: (text: string, kind?: 'ok' | 'error') => void
  dismissToast: (id: number) => void
  setEmotePreview: (v: EmotePreviewTarget | null) => void
  setLinkCard: (v: LinkCardTarget | null) => void
  setChannelPrompt: (v: ChannelPrompt | null) => void
  setHypeTrain: (v: HypeTrain | null) => void
  setWhispersOpen: (v: boolean) => void
  toggleScrollSync: () => void
  markReauthNeeded: (id: string, login: string) => void
  clearReauthNeeded: (id: string) => void
}

let toastId = 0

/**
 * Identity of an error for the "don't show again" list: the same failure carries different
 * accounts/nicks/durations each time, so strip the volatile parts and keep the wording.
 */
export function errorMuteKey(text: string): string {
  return text
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  settingsSection: null,
  addAccountOpen: false,
  userCard: null,
  toasts: [],
  emotePreview: null,
  linkCard: null,
  expandedGifts: {},
  channelPrompt: null,
  hypeTrain: null,
  whispersOpen: false,
  scrollSync: false,
  reauthAccounts: [],
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  toggleGiftGroup: (id) =>
    set((s) => ({ expandedGifts: { ...s.expandedGifts, [id]: !s.expandedGifts[id] } })),
  setAddAccountOpen: (addAccountOpen) => set({ addAccountOpen }),
  setUserCard: (userCard) => set({ userCard }),
  toast: (text, kind = 'ok') => {
    const muteKey = kind === 'error' ? errorMuteKey(text) : undefined
    // silently drop errors the user has told us to stop showing
    if (muteKey && useSettingsStore.getState().settings.mutedErrors.includes(muteKey)) return
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, text, kind, muteKey }] }))
    // error toasts can optionally chime; lazy import avoids a static ui⇄sound cycle
    if (kind === 'error') {
      import('../lib/sound').then((m) => m.playErrorSound()).catch(() => {})
    }
    // errors carry explanations now — give people time to actually read them
    setTimeout(() => {
      useUiStore.getState().dismissToast(id)
    }, kind === 'error' ? 10000 : 3500)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setEmotePreview: (emotePreview) => set({ emotePreview }),
  setLinkCard: (linkCard) => set({ linkCard }),
  setChannelPrompt: (channelPrompt) => set({ channelPrompt }),
  setHypeTrain: (hypeTrain) => set({ hypeTrain }),
  setWhispersOpen: (whispersOpen) => set({ whispersOpen }),
  toggleScrollSync: () => set((s) => ({ scrollSync: !s.scrollSync })),
  markReauthNeeded: (id, login) =>
    set((s) =>
      s.reauthAccounts.some((a) => a.id === id)
        ? s
        : { reauthAccounts: [...s.reauthAccounts, { id, login }] }
    ),
  clearReauthNeeded: (id) =>
    set((s) => ({ reauthAccounts: s.reauthAccounts.filter((a) => a.id !== id) }))
}))
