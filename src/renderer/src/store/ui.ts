import { create } from 'zustand'
import { BadgeRef, FavoriteEmote } from '../types'
import { useSettingsStore } from './settings'
import type { ModConfirmRequest } from '../lib/confirmMod'

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

/** an emote awaiting a decision about which favourite categories it belongs to */
export interface EmoteFolderMenu {
  key: string
  emote: FavoriteEmote
  x: number
  y: number
  /** the shelf it was right-clicked in, which is the only one "remove from this category" can mean */
  fromFolderId?: string | null
}

export interface Toast {
  id: number
  text: string
  kind: 'ok' | 'error'
  /** stable key for "don't show again": the message text with volatile bits stripped */
  muteKey?: string
  /** how long it should stay, in ms. The row owns the clock so hovering can stop it. */
  ms: number
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
  /** regular · shared · golden/mythic · community — decides its dress and its noise */
  flavour: 'regular' | 'shared' | 'golden' | 'community'
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
  /**
   * The channel whose train popup the reader closed by hand.
   *
   * Closing it used to last until the next contribution, which on a train being fed a gift sub
   * every few seconds is no time at all — the popup came straight back and the ✕ read as
   * broken. A dismissal now holds for the rest of THAT train; the service clears it when the
   * train ends, so the next one is announced normally.
   */
  hypeDismissed: string | null
  whispersOpen: boolean
  /** split mode: scrolling one pane scrolls the others by the same amount */
  /** accounts whose token died and need a full re-authorization (persistent banner) */
  reauthAccounts: { id: string; login: string }[]
  setSettingsOpen: (v: boolean) => void
  setSettingsSection: (v: string | null) => void
  toggleGiftGroup: (id: string) => void
  setAddAccountOpen: (v: boolean) => void
  setUserCard: (v: UserCardTarget | null) => void
  /**
   * @param opts.muteKey lets a non-error toast carry a "don't show again" button too — the mute
   *   machinery already existed, it was simply reachable only from errors.
   * @param opts.ms how long it stays. An explanation needs longer on screen than a confirmation.
   */
  toast: (text: string, kind?: 'ok' | 'error', opts?: { muteKey?: string; ms?: number }) => void
  dismissToast: (id: number) => void
  setEmotePreview: (v: EmotePreviewTarget | null) => void
  setLinkCard: (v: LinkCardTarget | null) => void
  setChannelPrompt: (v: ChannelPrompt | null) => void
  /**
   * A pending "are you sure" for a ban or a timeout, holding the promise that waits on the answer.
   * Null whenever nothing is being asked — see lib/confirmMod.ts.
   */
  modConfirm: ModConfirmRequest | null
  setModConfirm: (v: ModConfirmRequest | null) => void
  /**
   * The message whose action sheet is open, by id — touch only.
   *
   * An id rather than the message: the row that owns it already has everything the sheet needs
   * (its mod buttons, its permissions, its action context), so it draws the sheet itself and no
   * copy of that logic has to exist anywhere else.
   */
  heldMsgId: string | null
  setHeldMsgId: (v: string | null) => void
  /**
   * "Which categories should this emote be in?", opened with Alt+right-click.
   *
   * In the store rather than the picker because the same question is asked from chat, where the
   * picker is not mounted at all — and the answer is the same list either way.
   */
  emoteFolderMenu: EmoteFolderMenu | null
  setEmoteFolderMenu: (v: EmoteFolderMenu | null) => void
  setHypeTrain: (v: HypeTrain | null) => void
  dismissHypeTrain: () => void
  allowHypeTrain: () => void
  setWhispersOpen: (v: boolean) => void
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
  hypeDismissed: null,
  whispersOpen: false,
  reauthAccounts: [],
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  toggleGiftGroup: (id) =>
    set((s) => ({ expandedGifts: { ...s.expandedGifts, [id]: !s.expandedGifts[id] } })),
  setAddAccountOpen: (addAccountOpen) => set({ addAccountOpen }),
  setUserCard: (userCard) => set({ userCard }),
  toast: (text, kind = 'ok', opts) => {
    const muteKey = opts?.muteKey ?? (kind === 'error' ? errorMuteKey(text) : undefined)
    // silently drop errors the user has told us to stop showing
    if (muteKey && useSettingsStore.getState().settings.mutedErrors.includes(muteKey)) return
    const id = ++toastId
    // errors carry explanations now, so they get longer on screen than a confirmation
    const ms = opts?.ms ?? (kind === 'error' ? 10000 : 3500)
    set((s) => ({ toasts: [...s.toasts, { id, text, kind, muteKey, ms }] }))
    // error toasts can optionally chime; lazy import avoids a static ui⇄sound cycle
    if (kind === 'error') {
      import('../lib/sound').then((m) => m.playErrorSound()).catch(() => {})
    }
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setEmotePreview: (emotePreview) => set({ emotePreview }),
  setLinkCard: (linkCard) => set({ linkCard }),
  setChannelPrompt: (channelPrompt) => set({ channelPrompt }),
  modConfirm: null,
  setModConfirm: (modConfirm) => set({ modConfirm }),
  heldMsgId: null,
  setHeldMsgId: (heldMsgId) => set({ heldMsgId }),
  emoteFolderMenu: null,
  setEmoteFolderMenu: (emoteFolderMenu) => set({ emoteFolderMenu }),
  setHypeTrain: (hypeTrain) => set((s) => (hypeTrain && s.hypeDismissed === hypeTrain.channel ? s : { hypeTrain })),
  dismissHypeTrain: () =>
    set((s) => ({ hypeTrain: null, hypeDismissed: s.hypeTrain?.channel ?? s.hypeDismissed })),
  allowHypeTrain: () => set({ hypeDismissed: null }),
  setWhispersOpen: (whispersOpen) => set({ whispersOpen }),
  markReauthNeeded: (id, login) =>
    set((s) =>
      s.reauthAccounts.some((a) => a.id === id)
        ? s
        : { reauthAccounts: [...s.reauthAccounts, { id, login }] }
    ),
  clearReauthNeeded: (id) =>
    set((s) => ({ reauthAccounts: s.reauthAccounts.filter((a) => a.id !== id) }))
}))
