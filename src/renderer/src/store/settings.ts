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

/** stable identity of a favorite: provider + base code + every layer, in order */
export function favKey(e: FavoriteEmote): string {
  const overlays = e.overlays?.map((o) => o.code).join('+') ?? ''
  return `${e.provider}:${e.code}${overlays ? `+${overlays}` : ''}`
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
      // identity includes the LAYERS: "Kappa" and "Kappa + SoSnowy" are different favorites,
      // so saving a second combination on the same base no longer deletes the first
      const exists = s.favoriteEmotes.some((f) => favKey(f) === favKey(e))
      return {
        favoriteEmotes: exists
          ? s.favoriteEmotes.filter((f) => favKey(f) !== favKey(e))
          : [...s.favoriteEmotes, e]
      }
    }),
  setFavoriteEmotes: (favoriteEmotes) => set({ favoriteEmotes })
}))
