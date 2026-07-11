import { AppConfig, DEFAULT_MOD_BUTTONS, DEFAULT_SETTINGS } from '../types'
import { useAccountsStore } from '../store/accounts'
import { useLayoutStore } from '../store/layout'
import { useSettingsStore } from '../store/settings'

/**
 * One-time migration: the old dedicated "first message" background settings become
 * regular highlight rules, so every category is edited in the same standardized UI.
 */
function migrateHighlightRules(): void {
  const st = useSettingsStore.getState()
  if (st.settings.hlMigratedV1) return
  const rules = [...st.highlightRules]
  if (!rules.some((r) => r.kind === 'firstStream')) {
    rules.push({
      id: 'hl-first-stream',
      kind: 'firstStream',
      value: '',
      color: st.settings.firstMessageBgColor || '#22c55e',
      opacity: 0.12,
      enabled: st.settings.showFirstMsgBg
    })
  }
  if (!rules.some((r) => r.kind === 'firstMsg')) {
    rules.push({
      id: 'hl-first-ever',
      kind: 'firstMsg',
      value: '',
      color: '#ff5c5c',
      opacity: 0.12,
      enabled: st.settings.showFirstMsgBg
    })
  }
  st.setHighlightRules(rules)
  st.setSettings({ hlMigratedV1: true })
}

/** seed default redeem + bits highlight rules so both are visible out of the box (editable) */
function migrateHighlightRulesV2(): void {
  const st = useSettingsStore.getState()
  if (st.settings.hlMigratedV2) return
  const rules = [...st.highlightRules]
  if (!rules.some((r) => r.kind === 'redeem')) {
    rules.push({ id: 'hl-redeem', kind: 'redeem', value: '', color: '#9147ff', opacity: 0.14, enabled: true })
  }
  if (!rules.some((r) => r.kind === 'bits')) {
    rules.push({ id: 'hl-bits', kind: 'bits', value: '', color: '#f5b83d', opacity: 0.14, enabled: true })
  }
  st.setHighlightRules(rules)
  st.setSettings({ hlMigratedV2: true })
}

/** Loads persisted config into all stores. Returns true if config existed. */
export async function loadConfig(): Promise<boolean> {
  const raw = (await window.sticki.getConfig()) as Partial<AppConfig> | null
  if (!raw) {
    // fresh install: still seed the default highlight rules
    migrateHighlightRules()
    migrateHighlightRulesV2()
    return false
  }

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
  migrateHighlightRules()
  migrateHighlightRulesV2()
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

// While applying a config broadcast from another window we must not re-save it: with
// persistence active in several windows that would ping-pong notifications forever.
let applyingRemote = false

let saveTimer: number | null = null
function scheduleSave(): void {
  if (applyingRemote) return
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    window.sticki.setConfig(snapshot())
    window.sticki.notifyConfigChanged()
  }, 400)
}

/** Subscribe to every store and persist changes (debounced). Main window only. */
export function startPersistence(): void {
  useSettingsStore.subscribe(scheduleSave)
  useAccountsStore.subscribe(scheduleSave)
  useLayoutStore.subscribe(scheduleSave)
}

let settingsSaveTimer: number | null = null
function scheduleSettingsSave(): void {
  if (applyingRemote) return
  if (settingsSaveTimer !== null) return
  settingsSaveTimer = window.setTimeout(async () => {
    settingsSaveTimer = null
    // merge into the stored config: utility windows must never write their (empty) layout
    const raw = ((await window.sticki.getConfig()) as Partial<AppConfig> | null) ?? {}
    const s = useSettingsStore.getState()
    await window.sticki.setConfig({
      ...raw,
      clientId: s.clientId,
      settings: s.settings,
      modButtons: s.modButtons,
      raidFavorites: s.raidFavorites,
      highlightRules: s.highlightRules,
      favoriteEmotes: s.favoriteEmotes
    })
    window.sticki.notifyConfigChanged()
  }, 400)
}

/**
 * Settings-only persistence for utility windows (settings/emote picker): without it any
 * change made there silently evaporates and reverts on the next config sync.
 */
export function startSettingsPersistence(): void {
  useSettingsStore.subscribe(scheduleSettingsSave)
}

/**
 * Persist ONLY the token fields of one account straight to disk, merging into the stored
 * config. Called right after a token refresh from ANY window — utility windows (emote
 * picker, settings) have no store persistence, and Twitch rotates refresh tokens on every
 * refresh, so losing the new one leaves a dead token on disk and bricks the account.
 */
export async function persistAccountTokens(accountId: string): Promise<void> {
  const acc = useAccountsStore.getState().accounts.find((a) => a.id === accountId)
  if (!acc) return
  const raw = ((await window.sticki.getConfig()) as Partial<AppConfig> | null) ?? {}
  const { _accessToken, _refreshToken, ...stored } = acc
  const existing = raw.accounts ?? []
  const accounts = existing.some((a) => a.id === accountId)
    ? existing.map((a) =>
        a.id === accountId
          ? { ...a, accessTokenEnc: acc.accessTokenEnc, refreshTokenEnc: acc.refreshTokenEnc }
          : a
      )
    : [...existing, stored] // brand-new account added from a window without persistence
  await window.sticki.setConfig({ ...raw, accounts })
  window.sticki.notifyConfigChanged()
}

/**
 * Persist an account REMOVAL straight to disk (merging into the stored config) and tell other
 * windows. The standalone settings window has no account-store persistence, so removing an
 * account there otherwise never reached disk — and the account reappeared on the next open.
 */
export async function persistAccountRemoval(accountId: string): Promise<void> {
  const raw = ((await window.sticki.getConfig()) as Partial<AppConfig> | null) ?? {}
  const accounts = (raw.accounts ?? []).filter((a) => a.id !== accountId)
  await window.sticki.setConfig({ ...raw, accounts })
  window.sticki.notifyConfigChanged()
}

/** Reload settings/tokens (not layout — each window keeps its own tabs) when another window saves. */
export function startConfigSync(): () => void {
  return window.sticki.onConfigChanged(() => {
    window.sticki.getConfig().then(async (raw) => {
      const cfg = raw as Partial<AppConfig> | null
      if (!cfg) return
      applyingRemote = true
      try {
        const settings = useSettingsStore.getState()
        settings.setClientId(cfg.clientId ?? '')
        settings.setSettings({ ...DEFAULT_SETTINGS, ...(cfg.settings ?? {}) })
        settings.setModButtons(cfg.modButtons?.length ? cfg.modButtons : DEFAULT_MOD_BUTTONS)
        settings.setRaidFavorites(cfg.raidFavorites ?? [])
        settings.setHighlightRules(cfg.highlightRules ?? [])
        settings.setFavoriteEmotes(cfg.favoriteEmotes ?? [])
        // reconcile accounts with other windows: pick up token rotations, ADD accounts added
        // elsewhere (e.g. the standalone settings window), and drop ones removed elsewhere
        let tokensChanged = false
        let accountsAdded = false
        for (const a of cfg.accounts ?? []) {
          const existing = useAccountsStore.getState().accounts.find((x) => x.id === a.id)
          if (existing) {
            if (
              existing.accessTokenEnc === a.accessTokenEnc &&
              existing.refreshTokenEnc === a.refreshTokenEnc
            )
              continue
            const accessToken = a.accessTokenEnc ? await window.sticki.decrypt(a.accessTokenEnc) : null
            const refreshToken = a.refreshTokenEnc ? await window.sticki.decrypt(a.refreshTokenEnc) : null
            useAccountsStore.getState().updateAccount(a.id, {
              accessTokenEnc: a.accessTokenEnc,
              refreshTokenEnc: a.refreshTokenEnc,
              _accessToken: accessToken ?? undefined,
              _refreshToken: refreshToken ?? undefined
            })
            tokensChanged = true
          } else {
            // brand-new account authorized in another window — decrypt tokens and add it here
            const accessToken = a.accessTokenEnc ? await window.sticki.decrypt(a.accessTokenEnc) : null
            const refreshToken = a.refreshTokenEnc ? await window.sticki.decrypt(a.refreshTokenEnc) : null
            useAccountsStore.getState().addAccount({
              ...a,
              moderatedChannelIds: a.moderatedChannelIds ?? [],
              _accessToken: accessToken ?? undefined,
              _refreshToken: refreshToken ?? undefined
            })
            accountsAdded = true
          }
        }
        // reconcile removals: an account removed in another window must disappear here too
        const cfgIds = new Set((cfg.accounts ?? []).map((a) => a.id))
        const stale = useAccountsStore.getState().accounts.filter((a) => !cfgIds.has(a.id))
        if (tokensChanged || accountsAdded || stale.length) {
          const { chatService } = await import('./chatService')
          for (const a of stale) {
            chatService.dropSender(a.id)
            useAccountsStore.getState().removeAccount(a.id)
          }
          // fresh tokens / new accounts may unblock fetches and need whisper subscriptions
          const { reloadAllBadges } = await import('./emoteService')
          reloadAllBadges()
          chatService.resyncSubscriptions()
        }
      } finally {
        applyingRemote = false
      }
    })
  })
}
