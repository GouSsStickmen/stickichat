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

const LIMIT = 1000
const LS_KEY = 'sticki:whispers'
/** which conversation is open right now (shared across windows via localStorage) */
const LS_OPEN_THREAD = 'sticki:whisperOpenThread'

function loadPersisted(): Whisper[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    const list = raw ? (JSON.parse(raw) as Whisper[]) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

let saveTimer: number | null = null
function persist(list: Whisper[]): void {
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(useWhispersStore.getState().whispers))
    } catch {
      /* storage full — history is best-effort */
    }
  }, 300)
  void list
}

export const useWhispersStore = create<WhispersState>()((set) => ({
  // conversation history survives restarts (localStorage is shared by all app windows)
  whispers: loadPersisted(),
  unread: 0,
  add: (w) =>
    set((s) => {
      // sender connections can deliver duplicates after a reconnect
      if (s.whispers.some((x) => x.id === w.id)) return s
      let whispers = [...s.whispers, w]
      if (whispers.length > LIMIT) whispers = whispers.slice(whispers.length - LIMIT)
      persist(whispers)
      // a whisper for the conversation the user is LOOKING at doesn't count as unread
      const openThread = getOpenWhisperThread()
      const unread = w.incoming && openThread !== w.otherLogin ? s.unread + 1 : s.unread
      return { whispers, unread }
    }),
  markRead: () => set({ unread: 0 })
}))

/** merge whisper history written by ANOTHER window (localStorage 'storage' event) */
window.addEventListener('storage', (e) => {
  if (e.key !== LS_KEY || !e.newValue) return
  try {
    const incoming = JSON.parse(e.newValue) as Whisper[]
    if (!Array.isArray(incoming)) return
    const cur = useWhispersStore.getState().whispers
    const seen = new Set(cur.map((w) => w.id))
    const fresh = incoming.filter((w) => !seen.has(w.id))
    if (fresh.length === 0) return
    const merged = [...cur, ...fresh].sort((a, b) => a.timestamp - b.timestamp).slice(-LIMIT)
    const openThread = getOpenWhisperThread()
    const newUnread = fresh.filter((w) => w.incoming && openThread !== w.otherLogin).length
    useWhispersStore.setState((s) => ({ whispers: merged, unread: s.unread + newUnread }))
  } catch {
    /* corrupt payload */
  }
})

/** the conversation currently open in ANY window (suppresses its notification sound) */
export function getOpenWhisperThread(): string | null {
  try {
    return localStorage.getItem(LS_OPEN_THREAD) || null
  } catch {
    return null
  }
}

export function setOpenWhisperThread(login: string | null): void {
  try {
    if (login) localStorage.setItem(LS_OPEN_THREAD, login)
    else localStorage.removeItem(LS_OPEN_THREAD)
  } catch {
    /* best-effort */
  }
}
