import { create } from 'zustand'
import { Pane, Tab } from '../types'

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
  renameTab: (id: string, name: string) => void
  setActiveTab: (id: string) => void
  setColumns: (tabId: string, columns: number) => void
  addPane: (tabId: string, channel: string, accountId: string | null) => void
  closePane: (tabId: string, paneId: string) => void
  updatePane: (tabId: string, paneId: string, patch: Partial<Pane>) => void
  moveTab: (tabId: string, toIndex: number) => void
  swapPanes: (tabId: string, paneIdA: string, paneIdB: string) => void
}

export const useLayoutStore = create<LayoutState>()((set) => ({
  tabs: [],
  activeTabId: null,
  setAll: (tabs, activeTabId) => set({ tabs, activeTabId }),
  addTab: (name) => {
    const id = nextId('tab')
    set((s) => ({ tabs: [...s.tabs, { id, name, panes: [], columns: 0 }], activeTabId: id }))
    return id
  },
  closeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId = s.activeTabId === id ? (tabs[0]?.id ?? null) : s.activeTabId
      return { tabs, activeTabId }
    }),
  renameTab: (id, name) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t)) })),
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
  closePane: (tabId, paneId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, panes: t.panes.filter((p) => p.id !== paneId) } : t
      )
    })),
  updatePane: (tabId, paneId, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, panes: t.panes.map((p) => (p.id === paneId ? { ...p, ...patch } : p)) }
          : t
      )
    })),
  moveTab: (tabId, toIndex) =>
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === tabId)
      if (from === -1) return s
      const tabs = [...s.tabs]
      const [tab] = tabs.splice(from, 1)
      tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab)
      return { tabs }
    }),
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
