import { create } from 'zustand'
import {
  DEFAULT_MOD_BUTTONS,
  DEFAULT_SETTINGS,
  FavoriteEmote,
  FavoriteFolder,
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
  /**
   * Named shelves inside the favourites, holding references rather than emotes.
   *
   * A key, not a copy, and a list per folder rather than a folder per emote: the same emote belongs
   * on several shelves at once — the one for a raid, the one for a bit — and neither owns it. The
   * emote itself stays in `favoriteEmotes`, which remains the whole collection.
   */
  favoriteFolders: FavoriteFolder[]
  setClientId: (id: string) => void
  setSettings: (patch: Partial<Settings>) => void
  applySettings: (settings: Settings) => void
  setModButtons: (buttons: ModButton[]) => void
  setRaidFavorites: (channels: string[]) => void
  setHighlightRules: (rules: HighlightRule[]) => void
  toggleFavoriteEmote: (e: FavoriteEmote) => void
  setFavoriteEmotes: (list: FavoriteEmote[]) => void
  setFavoriteFolders: (list: FavoriteFolder[]) => void
  /** put an emote on a shelf or take it off — the emote stays in the collection either way */
  toggleInFolder: (folderId: string, key: string) => void
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
  favoriteFolders: [],
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
  setFavoriteEmotes: (favoriteEmotes) => set({ favoriteEmotes }),
  setFavoriteFolders: (favoriteFolders) => set({ favoriteFolders }),
  toggleInFolder: (folderId, key) =>
    set((s) => ({
      favoriteFolders: s.favoriteFolders.map((f) =>
        f.id !== folderId
          ? f
          : { ...f, keys: f.keys.includes(key) ? f.keys.filter((k) => k !== key) : [...f.keys, key] }
      )
    }))
}))
