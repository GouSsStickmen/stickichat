import { AppConfig, DEFAULT_MOD_BUTTONS, DEFAULT_SETTINGS } from '../types'
import { useAccountsStore } from '../store/accounts'
import { useLayoutStore } from '../store/layout'
import { useSettingsStore } from '../store/settings'

/** Loads persisted config into all stores. Returns true if config existed. */
export async function loadConfig(): Promise<boolean> {
  const raw = (await window.sticki.getConfig()) as Partial<AppConfig> | null
  if (!raw) return false

  const settings = useSettingsStore.getState()
  settings.setClientId(raw.clientId ?? '')
  settings.setSettings({ ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) })
  settings.setModButtons(raw.modButtons?.length ? raw.modButtons : DEFAULT_MOD_BUTTONS)
  settings.setRaidFavorites(raw.raidFavorites ?? [])
  settings.setHighlightRules(raw.highlightRules ?? [])
  settings.setFavoriteEmotes(raw.favoriteEmotes ?? [])

  const accounts = useAccountsStore.getState()
  for (const a of raw.accounts ?? []) {
    const accessToken = a.accessTokenEnc ? await window.sticki.decrypt(a.accessTokenEnc) : null
    const refreshToken = a.refreshTokenEnc ? await window.sticki.decrypt(a.refreshTokenEnc) : null
    accounts.addAccount({
      ...a,
      moderatedChannelIds: a.moderatedChannelIds ?? [],
      _accessToken: accessToken ?? undefined,
      _refreshToken: refreshToken ?? undefined
    })
  }

  useLayoutStore.getState().setAll(raw.tabs ?? [], raw.activeTabId ?? raw.tabs?.[0]?.id ?? null)
  return !!raw.clientId
}

function snapshot(): AppConfig {
  const s = useSettingsStore.getState()
  const a = useAccountsStore.getState()
  const l = useLayoutStore.getState()
  return {
    clientId: s.clientId,
    settings: s.settings,
    modButtons: s.modButtons,
    raidFavorites: s.raidFavorites,
    highlightRules: s.highlightRules,
    favoriteEmotes: s.favoriteEmotes,
    accounts: a.accounts.map(({ _accessToken, _refreshToken, ...rest }) => rest),
    tabs: l.tabs,
    activeTabId: l.activeTabId
  }
}

let saveTimer: number | null = null
function scheduleSave(): void {
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    window.sticki.setConfig(snapshot())
    window.sticki.notifyConfigChanged()
  }, 400)
}

/** Subscribe to every store and persist changes (debounced). */
export function startPersistence(): void {
  useSettingsStore.subscribe(scheduleSave)
  useAccountsStore.subscribe(scheduleSave)
  useLayoutStore.subscribe(scheduleSave)
}

/** Reload settings/accounts (not layout — each window keeps its own tabs) when another window saves. */
export function startConfigSync(): () => void {
  return window.sticki.onConfigChanged(() => {
    window.sticki.getConfig().then((raw) => {
      const cfg = raw as Partial<AppConfig> | null
      if (!cfg) return
      const settings = useSettingsStore.getState()
      settings.setClientId(cfg.clientId ?? '')
      settings.setSettings({ ...DEFAULT_SETTINGS, ...(cfg.settings ?? {}) })
      settings.setModButtons(cfg.modButtons?.length ? cfg.modButtons : DEFAULT_MOD_BUTTONS)
      settings.setRaidFavorites(cfg.raidFavorites ?? [])
      settings.setHighlightRules(cfg.highlightRules ?? [])
      settings.setFavoriteEmotes(cfg.favoriteEmotes ?? [])
    })
  })
}
