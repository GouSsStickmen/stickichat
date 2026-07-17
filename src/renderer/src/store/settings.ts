import { create } from 'zustand'
import {
  DEFAULT_MOD_BUTTONS,
  DEFAULT_SETTINGS,
  FavoriteEmote,
  HighlightRule,
  ModButton,
  Settings
} from '../types'

interface SettingsState {
  clientId: string
  settings: Settings
  modButtons: ModButton[]
  raidFavorites: string[]
  highlightRules: HighlightRule[]
  favoriteEmotes: FavoriteEmote[]
  setClientId: (id: string) => void
  setSettings: (patch: Partial<Settings>) => void
  applySettings: (settings: Settings) => void
  setModButtons: (buttons: ModButton[]) => void
  setRaidFavorites: (channels: string[]) => void
  setHighlightRules: (rules: HighlightRule[]) => void
  toggleFavoriteEmote: (e: FavoriteEmote) => void
  setFavoriteEmotes: (list: FavoriteEmote[]) => void
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  clientId: '',
  settings: DEFAULT_SETTINGS,
  modButtons: DEFAULT_MOD_BUTTONS,
  raidFavorites: [],
  highlightRules: [],
  favoriteEmotes: [],
  setClientId: (clientId) => set({ clientId }),
  setSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch, _rev: (s.settings._rev ?? 0) + 1 } })),
  // apply a settings object AS-IS (config load / cross-window sync) — no revision bump,
  // otherwise applying an OLD remote copy would mint a "newer" revision of stale values
  applySettings: (settings) => set({ settings }),
  setModButtons: (modButtons) => set({ modButtons }),
  setRaidFavorites: (raidFavorites) => set({ raidFavorites }),
  setHighlightRules: (highlightRules) => set({ highlightRules }),
  toggleFavoriteEmote: (e) =>
    set((s) => {
      const exists = s.favoriteEmotes.some((f) => f.code === e.code && f.provider === e.provider)
      return {
        favoriteEmotes: exists
          ? s.favoriteEmotes.filter((f) => !(f.code === e.code && f.provider === e.provider))
          : [...s.favoriteEmotes, e]
      }
    }),
  setFavoriteEmotes: (favoriteEmotes) => set({ favoriteEmotes })
}))
