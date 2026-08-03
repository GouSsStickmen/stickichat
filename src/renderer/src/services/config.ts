import { AppConfig, DEFAULT_MOD_BUTTONS, DEFAULT_SETTINGS, Settings } from '../types'
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
    // fresh install: still seed the default highlight rules + overlay profile
    migrateHighlightRules()
    migrateHighlightRulesV2()
    return false
  }

  const settings = useSettingsStore.getState()
  settings.setClientId(raw.clientId ?? '')
  settings.applySettings({ ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) })
  settings.setModButtons(raw.modButtons?.length ? raw.modButtons : DEFAULT_MOD_BUTTONS)
  settings.setRaidFavorites(raw.raidFavorites ?? [])
  // shared-chat used to be a pair of bespoke settings fields; it's a normal highlight rule
  // now, so seed it once for anyone upgrading (otherwise the tint just vanishes)
  const rules = raw.highlightRules ?? []
  settings.setHighlightRules(
    rules.some((r) => r.kind === 'sharedChat')
      ? rules
      : [...rules, { id: 'shared-chat', kind: 'sharedChat' as const, value: '', color: '#9147ff', opacity: 0.06, enabled: true }]
  )
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

const EXPORT_VERSION = 1

/**
 * Serialize the user's full configuration (everything except accounts/tokens, which are
 * device-bound secrets) to a portable JSON string for backup or transfer between machines.
 */
/**
 * What an export can be split into.
 *
 * Whole-config export is the wrong unit most of the time: someone wants to hand a friend their
 * mod buttons, or move one machine's highlight rules, not overwrite everything the other side
 * has. Each part is independent, and an import applies only the parts the file actually holds.
 */
export type ConfigPart =
  | 'appearance'
  | 'chat'
  | 'notifications'
  | 'highlightRules'
  | 'modButtons'
  | 'favoriteEmotes'
  | 'overlays'
  | 'hotkeys'
  | 'other'

export const CONFIG_PARTS: ConfigPart[] = [
  'appearance',
  'chat',
  'notifications',
  'highlightRules',
  'modButtons',
  'favoriteEmotes',
  'overlays',
  'hotkeys',
  'other'
]

/** settings keys that belong to each part; anything unlisted rides along with 'other' */
const PART_KEYS: Record<Exclude<ConfigPart, 'highlightRules' | 'modButtons' | 'favoriteEmotes'>, (keyof Settings)[]> = {
  appearance: [
    'theme', 'customThemes', 'fontFamily', 'fontSize', 'windowScales', 'emoteScale', 'badgeSize',
    'messageSpacing', 'lineSpacing', 'savedColors', 'recentColors'
  ],
  chat: [
    'showTimestamps', 'timestampSeconds', 'alternatingBackground', 'showStreamInfo',
    'smoothChatScroll', 'linkPreviews', 'linkDisplay', 'linkPreviewsClipsOnly',
    'linkPreviewsExpanded', 'linkHoverPreview', 'linkHoverImagesOnly', 'linkHoverSize',
    'linkPreviewScale', 'inputAccountDisplay', 'showBits', 'showRedeems', 'loadHistory',
    'emoteSuggestions', 'showCharCounter', 'caseSensitiveNicks', 'sevenTvNickColors',
    'colorBareNicks', 'showThirdPartyBadges', 'announceEmoteChanges', 'bypassDuplicateLimit',
    'botCommands', 'translitExcludeWords'
  ],
  notifications: [
    'mentionSound', 'mentionSoundType', 'mentionSoundVolume', 'mentionSoundOnActive',
    'alertSoundCooldown', 'firstMessageSound', 'firstMessageSoundType', 'firstMessageSoundVolume',
    'keywordSound', 'keywordAlerts', 'keywordSoundType', 'keywordSoundVolume',
    'keywordSoundOnActive', 'keywordWholeWord', 'nickAlertSound', 'nickAlerts',
    'nickAlertSoundType', 'nickAlertWholeWord',
    'nickAlertSoundVolume', 'nickAlertSoundOnActive', 'whisperSound', 'whisperSoundType',
    'whisperSoundVolume', 'streamUpNotify', 'streamUpSound', 'streamUpSoundType',
    'streamUpSoundVolume', 'raidPrompt', 'raidSound', 'raidSoundType', 'raidSoundVolume',
    'errorSound', 'mutedErrors', 'customSounds'
  ],
  overlays: ['chatOverlays', 'overlayEnabled', 'overlayPort'],
  hotkeys: ['hotkeys'],
  other: []
}

function pickSettings(settings: Settings, parts: ConfigPart[]): Partial<Settings> {
  const named = new Set<string>()
  for (const list of Object.values(PART_KEYS)) for (const k of list) named.add(k as string)
  const out: Partial<Settings> = {}
  for (const part of parts) {
    const keys = PART_KEYS[part as keyof typeof PART_KEYS]
    if (keys) {
      for (const k of keys) {
        if (k in settings) (out as Record<string, unknown>)[k as string] = settings[k]
      }
    }
    // "other" is everything the named groups don't claim, so a new setting can never quietly
    // fall out of exports just because nobody added it to a list
    if (part === 'other') {
      for (const k of Object.keys(settings)) {
        if (!named.has(k)) (out as Record<string, unknown>)[k] = (settings as unknown as Record<string, unknown>)[k]
      }
    }
  }
  return out
}

/** export the whole config, or only the named parts */
export function exportConfigJson(parts: ConfigPart[] = CONFIG_PARTS): string {
  const s = useSettingsStore.getState()
  const body: Record<string, unknown> = {
    _app: 'stickichat',
    _version: EXPORT_VERSION,
    _parts: parts,
    exportedAt: new Date().toISOString()
  }
  const settings = pickSettings(s.settings, parts)
  if (Object.keys(settings).length) body.settings = settings
  if (parts.includes('modButtons')) body.modButtons = s.modButtons
  if (parts.includes('highlightRules')) body.highlightRules = s.highlightRules
  if (parts.includes('favoriteEmotes')) body.favoriteEmotes = s.favoriteEmotes
  if (parts.includes('other')) body.raidFavorites = s.raidFavorites
  return JSON.stringify(body, null, 2)
}

/** which parts a file actually carries — shown before an import overwrites anything */
export function describeImport(text: string): ConfigPart[] | null {
  try {
    const d = JSON.parse(text) as { _app?: string; _parts?: ConfigPart[] }
    if (!d || d._app !== 'stickichat') return null
    return Array.isArray(d._parts) ? d._parts : CONFIG_PARTS
  } catch {
    return null
  }
}

/**
 * Apply a config produced by {@link exportConfigJson}. Returns false when the text is not a
 * valid StickiChat export. Store persistence picks up the change and writes it to disk.
 */
export function importConfigJson(text: string): boolean {
  let data: Partial<AppConfig> & { _app?: string } = {}
  try {
    data = JSON.parse(text)
  } catch {
    return false
  }
  if (!data || data._app !== 'stickichat') return false
  const s = useSettingsStore.getState()
  // merge, never reset: a partial file must leave everything it doesn't mention alone, and a
  // whole-config file still lands on top of the current values the same way
  if (data.settings) s.setSettings({ ...data.settings })
  if (Array.isArray(data.modButtons)) s.setModButtons(data.modButtons.length ? data.modButtons : DEFAULT_MOD_BUTTONS)
  if (Array.isArray(data.raidFavorites)) s.setRaidFavorites(data.raidFavorites)
  if (Array.isArray(data.highlightRules)) s.setHighlightRules(data.highlightRules)
  if (Array.isArray(data.favoriteEmotes)) s.setFavoriteEmotes(data.favoriteEmotes)
  return true
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
  saveTimer = window.setTimeout(async () => {
    saveTimer = null
    const blob = snapshot()
    // stale-settings guard: another window (e.g. the overlay editor) may have just saved a
    // NEWER settings revision — never clobber it with our older copy; adopt it instead
    const raw = ((await window.sticki.getConfig()) as Partial<AppConfig> | null) ?? {}
    const diskRev = raw.settings?._rev ?? 0
    const memRev = blob.settings._rev ?? 0
    if (diskRev > memRev && raw.settings) {
      blob.settings = raw.settings
      applyingRemote = true
      try {
        useSettingsStore.getState().applySettings({ ...DEFAULT_SETTINGS, ...raw.settings })
      } finally {
        applyingRemote = false
      }
    }
    window.sticki.setConfig(blob)
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
    // stale-settings guard (same as the main window's save)
    const settings = (raw.settings?._rev ?? 0) > (s.settings._rev ?? 0) && raw.settings ? raw.settings : s.settings
    // account PRIORITY set in this window must reach the disk: keep the stored account
    // objects (tokens!) but reorder them to match the store
    const order = useAccountsStore.getState().accounts.map((a) => a.id)
    const accPos = (id: string): number => {
      const i = order.indexOf(id)
      return i === -1 ? 1e9 : i
    }
    const accounts = [...(raw.accounts ?? [])].sort((a, b) => accPos(a.id) - accPos(b.id))
    await window.sticki.setConfig({
      ...raw,
      accounts,
      clientId: s.clientId,
      settings,
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
  // account order changes (priority ↑/↓ in the standalone settings window) must persist too
  useAccountsStore.subscribe(scheduleSettingsSave)
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
        // never let an OLDER remote settings copy overwrite newer local edits (this was the
        // "values bounce back while editing" bug), and never bump the revision when applying
        const incomingRev = cfg.settings?._rev ?? 0
        const localRev = settings.settings._rev ?? 0
        if (incomingRev >= localRev) {
          settings.applySettings({ ...DEFAULT_SETTINGS, ...(cfg.settings ?? {}) })
        }
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
        // apply the saved priority ORDER (first = main account)
        useAccountsStore.getState().applyOrder((cfg.accounts ?? []).map((a) => a.id))
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
