import { create } from 'zustand'

export interface Whisper {
  id: string
  /** my account that sent/received this whisper */
  accountId: string
  /** the other party */
  otherLogin: string
  otherDisplay: string
  otherId: string
  color?: string
  text: string
  timestamp: number
  incoming: boolean
}

interface WhispersState {
  whispers: Whisper[]
  unread: number
  add: (w: Whisper) => void
  markRead: () => void
}

const LIMIT = 500

export const useWhispersStore = create<WhispersState>()((set) => ({
  whispers: [],
  unread: 0,
  add: (w) =>
    set((s) => {
      // sender connections can deliver duplicates after a reconnect
      if (s.whispers.some((x) => x.id === w.id)) return s
      let whispers = [...s.whispers, w]
      if (whispers.length > LIMIT) whispers = whispers.slice(whispers.length - LIMIT)
      return { whispers, unread: w.incoming ? s.unread + 1 : s.unread }
    }),
  markRead: () => set({ unread: 0 })
}))
