import { create } from 'zustand'
import { Account } from '../types'

interface AccountsState {
  accounts: Account[]
  addAccount: (a: Account) => void
  removeAccount: (id: string) => void
  updateAccount: (id: string, patch: Partial<Account>) => void
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
    set((s) => ({ accounts: s.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) }))
}))

export function getAccount(id: string | null): Account | undefined {
  if (!id) return undefined
  return useAccountsStore.getState().accounts.find((a) => a.id === id)
}
