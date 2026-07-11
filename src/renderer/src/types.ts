// ---------- Accounts ----------

export interface Account {
  id: string // twitch user id
  login: string
  displayName: string
  avatarUrl?: string
  /** encrypted with safeStorage via main process */
  accessTokenEnc: string
  refreshTokenEnc: string
  /** channel ids where this account is a moderator (cached) */
  moderatedChannelIds: string[]
  /** runtime-only decrypted tokens, never persisted */
  _accessToken?: string
  _refreshToken?: string
}

// ---------- Chat ----------

export interface BadgeRef {
  setId: string
  version: string
}

export interface ReplyParent {
  login: string
  displayName: string
  text: string
  /** id of the message being replied to (for jump-to) */
  msgId?: string
}

export interface ChatMessage {
  id: string
  channel: string // channel login, no '#'
  channelId: string
  userId: string
  login: string
  displayName: string
  color?: string
  badges: BadgeRef[]
  text: string
  /** raw twitch `emotes=` IRC tag, positions are unicode code points */
  emotesTag?: string
  timestamp: number
  isAction: boolean
  isFirstMsg: boolean
  replyParent?: ReplyParent
  /** system messages: sub notices, raids, timeouts, connection info */
  system?: 'notice' | 'usernotice' | 'info'
  systemText?: string
  /** twitch announcement color (primary/blue/green/orange/purple), when this is an /announce */
  announceColor?: string
  deleted?: boolean
  historical?: boolean
  /** computed at ingest: mentions one of my accounts */
  isMention?: boolean
  /** the message is a reply to one of my accounts */
  replyToMe?: boolean
  /** this sub-gift belongs to a mass gift — hidden until its group is expanded */
  groupedUnder?: string
  /** this message is a mass-gift header that can expand its grouped gifts */
  giftGroupId?: string
  /** first message we've seen from this login since we joined this channel this session */
  isFirstInSession?: boolean
  /** channel-point redemption (custom reward / highlighted message) */
  redeemed?: boolean
  /** watch-streak milestone usernotice */
  watchStreak?: boolean
  /** bits cheered in this message (from the IRC `bits` tag) */
  bits?: number
}

// ---------- Emotes / badges ----------

export type EmoteProvider = 'twitch' | '7tv' | 'bttv' | 'ffz' | 'emoji'

export interface Emote {
  code: string
  url: string // 2x image
  provider: EmoteProvider
  zeroWidth?: boolean
  animated?: boolean
  /** base (1x) pixel width, when known — used to sort smallest to largest */
  size?: number
}

export type EmoteMap = Map<string, Emote>

// ---------- Cheermotes (bits) ----------

export interface CheermoteTier {
  /** minimum bits for this tier */
  min: number
  url: string
  /** tier color, used to tint the bit amount like on Twitch */
  color: string
}

export interface Cheermote {
  /** lower-cased prefix, e.g. "cheer" */
  prefix: string
  /** tiers sorted by `min` descending */
  tiers: CheermoteTier[]
}

export interface FavoriteEmote {
  code: string
  url: string
  provider: EmoteProvider
}

// ---------- Sounds ----------

export interface CustomSound {
  id: string
  name: string
  data: string // data URL
}

// ---------- User highlight rules ----------

/**
 * badge: twitch badge set id (moderator, vip…); nick: exact login;
 * own: my own messages; redeem: channel-point redemptions;
 * firstMsg: first message ever in the channel; firstStream: first message this stream;
 * watchStreak: watch-streak milestone messages
 */
export type HighlightKind =
  | 'badge'
  | 'nick'
  | 'own'
  | 'redeem'
  | 'bits'
  | 'firstMsg'
  | 'firstStream'
  | 'watchStreak'

/** kinds that don't need a value input (the category itself is the match) */
export const VALUELESS_HL_KINDS: ReadonlySet<HighlightKind> = new Set([
  'own', 'redeem', 'bits', 'firstMsg', 'firstStream', 'watchStreak'
])

export interface HighlightRule {
  id: string
  kind: HighlightKind
  value: string
  /** hex color like #9147ff */
  color: string
  /** 0..1 background opacity */
  opacity: number
  enabled: boolean
}

// ---------- Muted (dimmed/hidden) users ----------

export interface MutedUser {
  login: string
  /** hide: drop from chat entirely; dim: render with reduced opacity */
  mode: 'hide' | 'dim'
  /** 0..1 message opacity when mode = dim */
  opacity: number
}

// ---------- Hotkeys ----------

export type HotkeyAction = 'reconnect' | 'scrollLock' | 'translit' | 'resendLast'

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  reconnect: 'F5',
  scrollLock: 'Ctrl+L',
  translit: 'Ctrl+Shift+T',
  resendLast: 'Ctrl+Enter'
}

// ---------- Mod buttons ----------

export type ModActionType =
  | 'timeout'
  | 'ban'
  | 'unban'
  | 'delete'
  | 'warn'
  | 'shoutout'
  | 'raid'
  | 'announce'
  | 'snippet'
  | 'link'
  | 'fill'
  | 'copy'

/** these require real moderator rights via Helix; the rest are plain chat actions anyone can use */
export const MOD_ONLY_TYPES: ReadonlySet<ModActionType> = new Set([
  'timeout', 'ban', 'unban', 'delete', 'warn', 'shoutout', 'raid', 'announce'
])


export interface ModButton {
  id: string
  label: string
  icon?: string // emoji
  type: ModActionType
  /** timeout: seconds; announce/snippet/link/fill: text/url; announce: color */
  seconds?: number
  text?: string
  color?: 'primary' | 'blue' | 'green' | 'orange' | 'purple'
  /** where the button shows up */
  scope: 'message' | 'toolbar'
  /** limit to specific channel logins (comma-entered in settings); empty/undefined = everywhere */
  channels?: string[]
}

// ---------- Layout ----------

export interface Pane {
  id: string
  channel: string // login
  /** account used for sending + mod actions in this pane; null = read-only */
  accountId: string | null
}

export interface Tab {
  id: string
  name?: string
  panes: Pane[]
  /** 0 = auto */
  columns: number
}

// ---------- Settings ----------

export interface Settings {
  language: 'uk' | 'en'
  theme: 'dark' | 'light'
  fontSize: number // px
  emoteScale: number // 1 = 100%
  showTimestamps: boolean
  timestampSeconds: boolean
  alternatingBackground: boolean
  loadHistory: boolean // recent-messages.robotty.de
  highlightMentions: boolean
  mentionSound: boolean
  mentionSoundType: 'ping' | 'pop' | 'bell' | 'custom'
  mentionSoundVolume: number // 0..1
  /** data URL of a user-provided sound file */
  mentionSoundCustomId?: string
  firstMessageSound: boolean
  firstMessageSoundType: 'ping' | 'pop' | 'bell' | 'custom'
  firstMessageSoundVolume: number // 0..1
  firstMessageSoundCustomId?: string
  /** library of uploaded sound files, shared between mention/first-message pickers */
  customSounds: CustomSound[]
  /** Chatterino-style side panel listing highlighted (mention/keyword) messages */
  showHighlightSidebar: boolean
  messageLimit: number // ring buffer per channel
  emotePickerDefaultTab: 'favorites' | 'twitch' | 'thirdparty'
  emotePickerAsWindow: boolean
  showCharCounter: boolean
  messageSpacing: number // px, extra vertical padding per message
  caseSensitiveNicks: boolean
  alwaysOnTop: boolean
  /** open Settings as a separate window instead of the in-app modal */
  settingsAsWindow: boolean
  /** persist the 📌 always-on-top state of utility windows between opens */
  rememberPinState: boolean
  emotePickerPinned: boolean
  settingsPinned: boolean
  /** language of emoji names in tooltips/search hints */
  emojiNameLang: 'uk' | 'en' | 'both'
  /** px size of badges in chat/lists */
  badgeSize: number
  /** px size of the big hover preview in the emote picker */
  emotePreviewSize: number
  /** show viewer count / stream title / uptime in the pane header */
  showStreamInfo: boolean
  /** custom highlight colors (hex) */
  mentionBgColor: string
  firstMessageBgColor: string
  /** words/phrases that trigger the keyword alert sound */
  keywordAlerts: string[]
  keywordSound: boolean
  keywordSoundType: 'ping' | 'pop' | 'bell' | 'custom'
  keywordSoundVolume: number
  keywordSoundCustomId?: string
  /** sound + banner when a watched channel goes live */
  streamUpSound: boolean
  streamUpSoundType: 'ping' | 'pop' | 'bell' | 'custom'
  streamUpSoundVolume: number
  streamUpSoundCustomId?: string
  streamUpNotify: boolean
  /** sound when an incoming whisper arrives */
  whisperSound: boolean
  whisperSoundType: 'ping' | 'pop' | 'bell' | 'custom'
  whisperSoundVolume: number
  whisperSoundCustomId?: string
  /** the укр⇄eng wrong-layout converter (Aа button + Ctrl+Shift+T) */
  translitEnabled: boolean
  /** custom UI font family; empty = default system stack */
  fontFamily: string
  /** text size in the standalone user-card window */
  usercardFontSize: number
  /** background highlight toggles (sounds/detection stay independent) */
  showMentionBg: boolean
  showFirstMsgBg: boolean
  /** which tab the highlight sidebar opens on */
  highlightSidebarDefault: 'highlights' | 'mentions'
  /** extra px of line-height inside messages (emote rows overlapping) */
  lineSpacing: number
  /** restore the main window's size/position on launch */
  rememberWindowSize: boolean
  /** global sound mute */
  muted: boolean
  /** user-uploaded fonts (name + data URL), injected as @font-face */
  customFonts: { name: string; data: string }[]
  /** 0..1 background opacity of the mention highlight */
  mentionBgOpacity: number
  /** emote/emoji suggestions while typing (slash commands and @mentions stay on) */
  emoteSuggestions: boolean
  /** open user cards in a separate window instead of the in-app popup */
  usercardAsWindow: boolean
  /** persisted 📌 state of the standalone user-card window */
  usercardPinned: boolean
  /** offer to add the channel involved in a raid */
  raidPrompt: boolean
  /** only offer for raids on the channel you're currently watching (active tab) */
  raidPromptActiveOnly: boolean
  /** where accepting a raid prompt puts the channel: a new top tab or the current split */
  raidPromptDest: 'tabs' | 'split'
  /** show bits/cheers in chat */
  showBits: boolean
  /** tag messages that were channel-point redemptions */
  showRedeems: boolean
  /** users whose messages are hidden or dimmed */
  mutedUsers: MutedUser[]
  /** user-saved palette colors (hex) shown next to every color field */
  savedColors: string[]
  /** recently used colors (hex), newest first */
  recentColors: string[]
  /** action → accelerator (e.g. "Ctrl+L"); missing keys fall back to DEFAULT_HOTKEYS */
  hotkeys: Partial<Record<HotkeyAction, string>>
  /** swipe-to-moderate timeout tiers (seconds), shortest→longest */
  swipeTimeouts: number[]
  /** one-time migration: mention/first-message colors converted into highlight rules */
  hlMigratedV1: boolean
  /** one-time migration: default redeem + bits highlight rules seeded */
  hlMigratedV2: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'uk',
  theme: 'dark',
  fontSize: 13,
  emoteScale: 1,
  showTimestamps: true,
  timestampSeconds: false,
  alternatingBackground: false,
  loadHistory: true,
  highlightMentions: true,
  mentionSound: true,
  mentionSoundType: 'ping',
  mentionSoundVolume: 0.5,
  firstMessageSound: false,
  firstMessageSoundType: 'bell',
  firstMessageSoundVolume: 0.5,
  customSounds: [],
  showHighlightSidebar: false,
  messageLimit: 800,
  emotePickerDefaultTab: 'favorites',
  emotePickerAsWindow: false,
  showCharCounter: true,
  messageSpacing: 3,
  caseSensitiveNicks: false,
  alwaysOnTop: false,
  settingsAsWindow: false,
  rememberPinState: true,
  emotePickerPinned: false,
  settingsPinned: false,
  emojiNameLang: 'both',
  badgeSize: 18,
  emotePreviewSize: 112,
  showStreamInfo: true,
  mentionBgColor: '#8b5cf6',
  firstMessageBgColor: '#22c55e',
  keywordAlerts: [],
  keywordSound: true,
  keywordSoundType: 'ping',
  keywordSoundVolume: 0.5,
  streamUpSound: false,
  streamUpSoundType: 'bell',
  streamUpSoundVolume: 0.5,
  streamUpNotify: true,
  whisperSound: true,
  whisperSoundType: 'pop',
  whisperSoundVolume: 0.5,
  translitEnabled: true,
  fontFamily: '',
  usercardFontSize: 14,
  showMentionBg: true,
  showFirstMsgBg: true,
  highlightSidebarDefault: 'highlights',
  lineSpacing: 0,
  rememberWindowSize: true,
  muted: false,
  customFonts: [],
  mentionBgOpacity: 0.2,
  emoteSuggestions: true,
  usercardAsWindow: false,
  usercardPinned: false,
  raidPrompt: true,
  raidPromptActiveOnly: false,
  raidPromptDest: 'split',
  showBits: true,
  showRedeems: true,
  mutedUsers: [],
  savedColors: [],
  recentColors: [],
  hotkeys: {},
  swipeTimeouts: [60, 300, 600, 1800, 3600, 86400],
  hlMigratedV1: false,
  hlMigratedV2: false
}

export const DEFAULT_MOD_BUTTONS: ModButton[] = [
  { id: 'mb-del', label: 'Delete', icon: '🗑️', type: 'delete', scope: 'message' },
  { id: 'mb-t60', label: '1m', icon: '⏱️', type: 'timeout', seconds: 60, scope: 'message' },
  { id: 'mb-t600', label: '10m', icon: '⏱️', type: 'timeout', seconds: 600, scope: 'message' },
  { id: 'mb-t3600', label: '1h', icon: '⏱️', type: 'timeout', seconds: 3600, scope: 'message' },
  { id: 'mb-ban', label: 'Ban', icon: '🔨', type: 'ban', scope: 'message' },
  { id: 'mb-raid', label: 'Raid', icon: '🚀', type: 'raid', scope: 'toolbar' },
  { id: 'mb-announce', label: 'Announce', icon: '📢', type: 'announce', scope: 'toolbar' }
]

// ---------- Persisted config ----------

export interface AppConfig {
  clientId: string
  accounts: Omit<Account, '_accessToken' | '_refreshToken'>[]
  settings: Settings
  modButtons: ModButton[]
  raidFavorites: string[]
  highlightRules: HighlightRule[]
  favoriteEmotes: FavoriteEmote[]
  tabs: Tab[]
  activeTabId: string | null
}
