import { create } from 'zustand'
import { BadgeRef } from '../types'

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
}

export interface EmotePreviewTarget {
  url: string
  code: string
  x: number
  y: number
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

interface UiState {
  settingsOpen: boolean
  /** which settings section to land on when the modal/window opens next */
  settingsSection: string | null
  addAccountOpen: boolean
  userCard: UserCardTarget | null
  toasts: Toast[]
  emotePreview: EmotePreviewTarget | null
  /** mass-gift groups the user expanded (header message id -> true) */
  expandedGifts: Record<string, boolean>
  /** small "add this channel?" prompt (raids) */
  channelPrompt: ChannelPrompt | null
  whispersOpen: boolean
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
  setChannelPrompt: (v: ChannelPrompt | null) => void
  setWhispersOpen: (v: boolean) => void
  markReauthNeeded: (id: string, login: string) => void
  clearReauthNeeded: (id: string) => void
}

let toastId = 0

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  settingsSection: null,
  addAccountOpen: false,
  userCard: null,
  toasts: [],
  emotePreview: null,
  expandedGifts: {},
  channelPrompt: null,
  whispersOpen: false,
  reauthAccounts: [],
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  toggleGiftGroup: (id) =>
    set((s) => ({ expandedGifts: { ...s.expandedGifts, [id]: !s.expandedGifts[id] } })),
  setAddAccountOpen: (addAccountOpen) => set({ addAccountOpen }),
  setUserCard: (userCard) => set({ userCard }),
  toast: (text, kind = 'ok') => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
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
  setChannelPrompt: (channelPrompt) => set({ channelPrompt }),
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
