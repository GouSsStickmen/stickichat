import { create } from 'zustand'
import { Pane, Tab } from '../types'
import { useUiStore } from './ui'

let idCounter = Date.now() % 100000
export function nextId(prefix: string): string {
  return `${prefix}-${++idCounter}-${Math.random().toString(36).slice(2, 6)}`
}

interface LayoutState {
  tabs: Tab[]
  activeTabId: string | null
  setAll: (tabs: Tab[], activeTabId: string | null) => void
  addTab: (name?: string) => string
  closeTab: (id: string) => void
  /**
   * Tabs that were closed, newest first, so Ctrl+Shift+T can put them back.
   *
   * Kept in memory only, like the tab strip's own live state: this is an undo for the last few
   * minutes, not a second copy of the layout.
   */
  closedTabs: Tab[]
  reopenTab: () => void
  /** where each closed tab used to sit, so reopening puts it back rather than at the end */
  reopenAt: Record<string, number>
  renameTab: (id: string, name: string) => void
  togglePinTab: (id: string) => void
  setActiveTab: (id: string) => void
  setColumns: (tabId: string, columns: number) => void
  addPane: (tabId: string, channel: string, accountId: string | null) => void
  closePane: (tabId: string, paneId: string) => void
  updatePane: (tabId: string, paneId: string, patch: Partial<Pane>) => void
  moveTab: (tabId: string, toIndex: number) => void
  swapPanes: (tabId: string, paneIdA: string, paneIdB: string) => void
  /** drag-reorder inside the split grid */
  movePane: (tabId: string, paneId: string, toIndex: number) => void
}

/*
 * A player belongs to the chat it was opened from.
 *
 * Players are rendered above the app rather than inside their pane, so that looking at another tab
 * cannot stop the stream. That also means nothing stops one when its chat goes: closing the tab, or
 * closing one chat of a split, left a stream playing with no way to see it or stop it. Any channel
 * that no surviving pane shows loses its player here; one still open elsewhere keeps it.
 */
function dropOrphanPlayers(surviving: Tab[], gone: Pane[]): void {
  const stillShown = new Set(surviving.flatMap((t) => t.panes.map((p) => p.channel)))
  const ui = useUiStore.getState()
  for (const pane of gone) {
    if (!stillShown.has(pane.channel) && ui.openPlayers.includes(pane.channel)) {
      ui.togglePlayer(pane.channel, false)
    }
  }
}

export const useLayoutStore = create<LayoutState>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  setAll: (tabs, activeTabId) => set({ tabs, activeTabId }),
  addTab: (name) => {
    const id = nextId('tab')
    set((s) => ({ tabs: [...s.tabs, { id, name, panes: [], columns: 0 }], activeTabId: id }))
    return id
  },
  closedTabs: [],
  reopenTab: () => {
    const s = get()
    const [last, ...rest] = s.closedTabs
    if (!last) return
    // back where it was, as far as that still makes sense, and in front
    const at = Math.min(s.reopenAt[last.id] ?? s.tabs.length, s.tabs.length)
    const tabs = [...s.tabs.slice(0, at), last, ...s.tabs.slice(at)]
    set({ tabs, closedTabs: rest, activeTabId: last.id })
  },
  reopenAt: {},
  closeTab: (id) => {
    const s = get()
    const closing = s.tabs.find((t) => t.id === id)
    const tabs = s.tabs.filter((t) => t.id !== id)
    const activeTabId = s.activeTabId === id ? (tabs[0]?.id ?? null) : s.activeTabId
    set({
      tabs,
      activeTabId,
      closedTabs: closing ? [closing, ...s.closedTabs].slice(0, 20) : s.closedTabs,
      reopenAt: closing
        ? { ...s.reopenAt, [closing.id]: s.tabs.findIndex((t) => t.id === id) }
        : s.reopenAt
    })
    if (closing) dropOrphanPlayers(tabs, closing.panes)
  },
  renameTab: (id, name) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t)) })),
  togglePinTab: (id) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)) })),
  setActiveTab: (id) => set({ activeTabId: id }),
  setColumns: (tabId, columns) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, columns } : t)) })),
  addPane: (tabId, channel, accountId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              panes: [...t.panes, { id: nextId('pane'), channel: channel.toLowerCase(), accountId }]
            }
          : t
      )
    })),
  closePane: (tabId, paneId) => {
    const gone = get().tabs.find((t) => t.id === tabId)?.panes.find((p) => p.id === paneId)
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const panes = t.panes.filter((p) => p.id !== paneId)
        /*
         * A column count chosen for two chats has to let go when one of them closes.
         *
         * The number of columns is the user's when they set one, and the grid keeps drawing that
         * many cells however few chats are left: the last chat sat in half the tab with dead space
         * beside it, and the strip that would let it be changed back is only shown while there is
         * more than one chat, so the only way out was to close the tab and open it again. A count
         * that no longer fits what is there goes back to automatic.
         */
        const columns = panes.length <= 1 || t.columns > panes.length ? 0 : t.columns
        return { ...t, panes, columns }
      })
    }))
    if (gone) dropOrphanPlayers(get().tabs, [gone])
  },
  updatePane: (tabId, paneId, patch) => {
    const before = get()
      .tabs.find((t) => t.id === tabId)
      ?.panes.find((p) => p.id === paneId)
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, panes: t.panes.map((p) => (p.id === paneId ? { ...p, ...patch } : p)) }
          : t
      )
    }))
    /*
     * A pane pointed somewhere else leaves its old channel with nothing showing it.
     *
     * Closing a chat already takes its player with it; changing the channel with the pencil did
     * not, so the stream that was there kept playing somewhere out of sight, talking away with
     * neither video nor chat on screen and nothing to close it by. Same rule as closing: the
     * player goes unless some other pane still has that channel open.
     */
    if (before && patch.channel && patch.channel !== before.channel) {
      dropOrphanPlayers(get().tabs, [before])
    }
  },
  moveTab: (tabId, toIndex) =>
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === tabId)
      if (from === -1) return s
      const tabs = [...s.tabs]
      const [tab] = tabs.splice(from, 1)
      tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab)
      return { tabs }
    }),
  movePane: (tabId, paneId, toIndex) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const from = t.panes.findIndex((p) => p.id === paneId)
        if (from === -1) return t
        const panes = [...t.panes]
        const [moved] = panes.splice(from, 1)
        panes.splice(Math.max(0, Math.min(toIndex, panes.length)), 0, moved)
        return { ...t, panes }
      })
    })),
  swapPanes: (tabId, paneIdA, paneIdB) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const i = t.panes.findIndex((p) => p.id === paneIdA)
        const j = t.panes.findIndex((p) => p.id === paneIdB)
        if (i === -1 || j === -1) return t
        const panes = [...t.panes]
        ;[panes[i], panes[j]] = [panes[j], panes[i]]
        return { ...t, panes }
      })
    }))
}))

/** every channel currently open in any tab */
export function allOpenChannels(tabs: Tab[]): string[] {
  const set = new Set<string>()
  for (const t of tabs) for (const p of t.panes) set.add(p.channel)
  return [...set]
}
