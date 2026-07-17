import { create } from 'zustand'
import { Account } from '../types'

interface AccountsState {
  accounts: Account[]
  addAccount: (a: Account) => void
  removeAccount: (id: string) => void
  updateAccount: (id: string, patch: Partial<Account>) => void
  /** move an account up/down — the FIRST account is the "main" one (used for raids/new chats) */
  moveAccount: (id: string, dir: -1 | 1) => void
  /** apply a saved priority order (ids first = higher priority; unknown ids keep position) */
  applyOrder: (ids: string[]) => void
}

export const useAccountsStore = create<AccountsState>()((set) => ({
  accounts: [],
  addAccount: (a) =>
    set((s) => ({
      accounts: s.accounts.some((x) => x.id === a.id)
        ? s.accounts.map((x) => (x.id === a.id ? a : x))
        : [...s.accounts, a]
    })),
  removeAccount: (id) => set((s) => ({ accounts: s.accounts.filter((a) => a.id !== id) })),
  updateAccount: (id, patch) =>
    set((s) => ({ accounts: s.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
  applyOrder: (ids) =>
    set((s) => {
      const pos = (a: { id: string }): number => {
        const i = ids.indexOf(a.id)
        return i === -1 ? 1e9 : i
      }
      const sorted = [...s.accounts].sort((a, b) => pos(a) - pos(b))
      return sorted.some((a, i) => a !== s.accounts[i]) ? { accounts: sorted } : s
    }),
  moveAccount: (id, dir) =>
    set((s) => {
      const i = s.accounts.findIndex((a) => a.id === id)
      const j = i + dir
      if (i === -1 || j < 0 || j >= s.accounts.length) return s
      const accounts = [...s.accounts]
      ;[accounts[i], accounts[j]] = [accounts[j], accounts[i]]
      return { accounts }
    })
}))

export function getAccount(id: string | null): Account | undefined {
  if (!id) return undefined
  return useAccountsStore.getState().accounts.find((a) => a.id === id)
}
