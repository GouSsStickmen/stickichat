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

/**
 * Which conversation the user is actually LOOKING at — the one whose arrival should not ping.
 *
 * This used to be a bare login written to localStorage and removed on unmount, and that is a
 * latch that can stick shut. Close the app (or crash it) with a conversation open and the key
 * survives the restart, so from then on every whisper from that person is silently treated as
 * "already being read": no sound, no unread badge, forever. That is a bug you cannot even see,
 * because nothing about it is visible — reported as "whispers just don't notify for me".
 *
 * So it expires. The panel refreshes the marker while it is open AND its window has focus; a
 * marker nobody has refreshed for a few seconds means nobody is looking, whatever happened to
 * the window that wrote it. Anything written by an older version parses as junk and is ignored,
 * which heals the stuck state on first launch without asking the user to do anything.
 */
const OPEN_THREAD_TTL = 10_000

/**
 * What the panel was in the middle of: which conversation was open, and what had been typed
 * and not yet sent.
 *
 * The panel is a popover, so a click anywhere else closes it and unmounts it — and a
 * half-written message lived in component state, which meant it was simply gone. Losing text
 * someone typed is the one thing an app must never do casually, and here it took one stray
 * click. It goes to disk, keyed per conversation, and comes back when the panel reopens.
 */
const LS_UI = 'sticki:whisperUi'

export interface WhisperUiState {
  selected: string | null
  /** otherLogin -> unsent text */
  drafts: Record<string, string>
  composing: boolean
  composeNick: string
  composeText: string
}

const EMPTY_UI: WhisperUiState = { selected: null, drafts: {}, composing: false, composeNick: '', composeText: '' }

export function loadWhisperUi(): WhisperUiState {
  try {
    const raw = localStorage.getItem(LS_UI)
    if (!raw) return EMPTY_UI
    const v = JSON.parse(raw) as Partial<WhisperUiState>
    return {
      selected: typeof v.selected === 'string' ? v.selected : null,
      drafts: v.drafts && typeof v.drafts === 'object' ? v.drafts : {},
      composing: !!v.composing,
      composeNick: typeof v.composeNick === 'string' ? v.composeNick : '',
      composeText: typeof v.composeText === 'string' ? v.composeText : ''
    }
  } catch {
    return EMPTY_UI
  }
}

export function saveWhisperUi(patch: Partial<WhisperUiState>): void {
  try {
    localStorage.setItem(LS_UI, JSON.stringify({ ...loadWhisperUi(), ...patch }))
  } catch {
    /* best-effort */
  }
}

export function getOpenWhisperThread(): string | null {
  try {
    const raw = localStorage.getItem(LS_OPEN_THREAD)
    if (!raw) return null
    const v = JSON.parse(raw) as { login?: string; ts?: number }
    if (!v?.login || typeof v.ts !== 'number') return null
    return Date.now() - v.ts < OPEN_THREAD_TTL ? v.login : null
  } catch {
    return null
  }
}

export function setOpenWhisperThread(login: string | null): void {
  try {
    if (login) localStorage.setItem(LS_OPEN_THREAD, JSON.stringify({ login, ts: Date.now() }))
    else localStorage.removeItem(LS_OPEN_THREAD)
  } catch {
    /* best-effort */
  }
}
