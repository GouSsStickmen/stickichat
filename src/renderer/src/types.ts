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
  /** first message we've seen from this login since we joined this channel this session */
  isFirstInSession?: boolean
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

export interface HighlightRule {
  id: string
  /** badge: match a twitch badge set id (moderator, vip, subscriber…); nick: exact login */
  kind: 'badge' | 'nick'
  value: string
  /** hex color like #9147ff */
  color: string
  /** 0..1 background opacity */
  opacity: number
  enabled: boolean
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
  translitEnabled: true,
  fontFamily: '',
  usercardFontSize: 14,
  showMentionBg: true,
  showFirstMsgBg: true,
  highlightSidebarDefault: 'highlights',
  lineSpacing: 0,
  rememberWindowSize: true,
  muted: false,
  customFonts: []
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
