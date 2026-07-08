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

interface UiState {
  settingsOpen: boolean
  addAccountOpen: boolean
  userCard: UserCardTarget | null
  toasts: Toast[]
  emotePreview: EmotePreviewTarget | null
  setSettingsOpen: (v: boolean) => void
  setAddAccountOpen: (v: boolean) => void
  setUserCard: (v: UserCardTarget | null) => void
  toast: (text: string, kind?: 'ok' | 'error') => void
  dismissToast: (id: number) => void
  setEmotePreview: (v: EmotePreviewTarget | null) => void
}

let toastId = 0

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  addAccountOpen: false,
  userCard: null,
  toasts: [],
  emotePreview: null,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setAddAccountOpen: (addAccountOpen) => set({ addAccountOpen }),
  setUserCard: (userCard) => set({ userCard }),
  toast: (text, kind = 'ok') => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    setTimeout(() => {
      useUiStore.getState().dismissToast(id)
    }, 3500)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setEmotePreview: (emotePreview) => set({ emotePreview })
}))
