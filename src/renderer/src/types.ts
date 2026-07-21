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
  /** local client feedback from Twitch (NOTICE: "Unrecognized command"…) — shown in chat,
   *  never on the stream overlay */
  clientNotice?: boolean
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
  /** subgift line: the gifter's login (lets a late header group earlier lines) */
  giftFrom?: string
  /** first message we've seen from this login since we joined this channel this session */
  isFirstInSession?: boolean
  /** channel-point redemption (custom reward / highlighted message) */
  redeemed?: boolean
  /** redemption reward name (shown instead of a generic "redeems" label) */
  rewardTitle?: string
  /** redemption cost in channel points */
  rewardCost?: number
  /** redemption reward icon (the channel-points image, instead of an emoji) */
  rewardIcon?: string
  /** watch-streak milestone usernotice */
  watchStreak?: boolean
  /** sub / resub / gifted-sub usernotice (the highlights "subs" tab) */
  subEvent?: boolean
  /** Twitch shared chat: origin broadcaster id when the message came from the partner channel */
  sourceRoomId?: string
  /** bits cheered in this message (from the IRC `bits` tag) */
  bits?: number
  /** "Gigantify an Emote" bits power-up — the message's emote is shown huge */
  gigantified?: boolean
  /** "Message Effect" bits power-up — the effect/animation id (e.g. "rainbow-eclipse") */
  messageEffect?: string
  /** incoming raid usernotice: the raider's login (enables the mod shoutout button) */
  raidFrom?: string
  /** system line describing a moderation action (timeout/ban/delete/clear) */
  modAction?: boolean
  /** system mod-action line: which user it was applied to (for the usercard) */
  modTargetUserId?: string
  /** message author arrived with a recent raid (highlighted via the 'raider' rule) */
  raider?: boolean
  /** which streamer's raid brought this author (shown as a tag while `raider` is active) */
  raiderFrom?: string
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
  | 'raider'
  | 'firstMsg'
  | 'firstStream'
  | 'watchStreak'

/** kinds that don't need a value input (the category itself is the match) */
export const VALUELESS_HL_KINDS: ReadonlySet<HighlightKind> = new Set([
  'own', 'redeem', 'bits', 'raider', 'firstMsg', 'firstStream', 'watchStreak'
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
  /** derive the highlight tint from the sender's nick color instead of the fixed `color` */
  adaptColor?: boolean
}

// ---------- Muted (dimmed/hidden) users ----------

export interface MutedUser {
  login: string
  /** hide: drop from chat entirely; dim: render with reduced opacity */
  mode: 'hide' | 'dim'
  /** 0..1 message opacity when mode = dim */
  opacity: number
}

// ---------- OBS overlay profiles ----------

/**
 * One named visual style for the OBS overlay. The same chat can be added to several OBS
 * sources with different profiles (each profile has its own /overlay URL).
 */
export interface OverlayProfile {
  id: string
  name: string
  font: string
  fontSize: number
  bold: boolean
  textColor: string
  textAlign: 'left' | 'center' | 'right'
  /** hard letter outline (text stroke), 0 = off */
  outlineWidth: number
  outlineColor: string
  /** soft drop shadow behind the text, 0 = off */
  shadowBlur: number
  shadowColor: string
  /** colored glow around the text, 0 = off */
  glowSize: number
  glowColor: string
  /** none · fit = plate hugs the text · line = full-width plate · panel = one backdrop under the whole chat */
  bgMode: 'none' | 'fit' | 'line' | 'panel'
  bgColor: string
  bgOpacity: number
  bgRadius: number
  /** drop shadow under the plate/panel, 0 = off */
  bgShadowBlur: number
  bgShadowColor: string
  /** custom background image (data URL) — used by panel AND per-line (fit/line) plates */
  bgImage?: string
  /** opacity of the custom background image, 0..1 (lets the plate image be made transparent) */
  bgImageOpacity: number
  /** fixed plate/panel width in px, 0 = auto (hug content / full width) */
  bgWidth: number
  /** fixed plate/panel height in px, 0 = auto */
  bgHeight: number
  /** keep the background image's aspect ratio (contain) instead of stretching to fill (cover) */
  bgKeepAspect: boolean
  /** users hidden in THIS profile only (global `overlayHiddenUsers` hides in every overlay) */
  hiddenUsers: string[]
  /** where new messages appear: 'up' = newest at the bottom (default), 'down' = newest at top */
  messageDir: 'up' | 'down'
  lineGap: number
  fade: number
  max: number
}

// ---------- OBS Overlays v2 (editor) ----------

/** solid color or multi-stop gradient fill used across the overlay editor */
export interface OverlayFill {
  kind: 'solid' | 'gradient'
  color: string
  /** 0..1 */
  opacity: number
  color2: string
  /** gradient angle, deg */
  angle: number
  /** multi-stop gradient: color + position 0..100. When present (≥2), wins over color/color2 */
  stops?: { color: string; at: number }[]
}

/** a decorative PNG pinned to a corner/edge of each message plate or the whole chat zone */
export interface OverlayDecor {
  id: string
  /** data URL */
  image: string
  anchor: 'tl' | 'tr' | 'bl' | 'br' | 'top' | 'bottom'
  dx: number
  dy: number
  /** px width */
  size: number
  /** 0..1 */
  opacity: number
  /** render above the plate content (true) or behind it (false) */
  above: boolean
  scope: 'message' | 'zone'
}

/** a word/symbol trigger: when a chat message contains `word`, an image/GIF pops up near
 *  the chat with a cute animation, at a configurable position */
export interface OverlayTrigger {
  id: string
  /** the word/emoji/symbols to react to (case-insensitive substring) */
  word: string
  /** data URL of the image/GIF */
  image: string
  /** screen = fixed spot on the overlay; message = right next to the triggering message's
   *  plate (tracks its width, scrolls away with it) */
  attach?: 'screen' | 'message'
  pos: 'tl' | 'top' | 'tr' | 'left' | 'right' | 'bl' | 'bottom' | 'br'
  dx: number
  dy: number
  /** px width */
  size: number
  anim: 'pop' | 'bounce' | 'fade' | 'slide' | 'wiggle'
  /** seconds on screen; 0 = never disappears */
  durationS: number
}

/**
 * One OBS overlay instance. `type` is future-proofing — today only 'chat' exists, later
 * alerts/goals/etc. get their own config shapes under the same manager.
 */
export interface ChatOverlayConfig {
  id: string
  name: string
  type: 'chat'
  /** channel baked into the OBS URL; empty/undefined = first open chat */
  channel?: string

  // ----- layout -----
  /** list = classic rows · bubble = card per message with nick header · horizontal = one
   *  row along the screen edge · compact = messenger style with avatar column */
  layout: 'list' | 'bubble' | 'horizontal' | 'compact'
  /** vertical flow: 'up' = newest at the bottom; 'down' = newest at top.
   *  horizontal layout: 'up' = newest on the right, 'down' = newest on the left */
  direction: 'up' | 'down'
  align: 'left' | 'center' | 'right'
  /** horizontal layout: stick the bar to the top or bottom of the source */
  anchor: 'top' | 'bottom'
  maxMessages: number
  /** seconds before a message fades out; 0 = keep */
  fadeAfter: number
  /** px between messages */
  lineGap: number
  /** how /me action messages render: user-colored text (like chat) or plain */
  meStyle: 'colored' | 'plain'
  /** which badge KINDS to show (setIds); empty = all badges */
  badgeKinds: string[]
  /** custom badges pinned to specific users (login → uploaded image) */
  userBadges: { login: string; image: string }[]
  /** replace a badge KIND's image with your own (setId → uploaded image) */
  badgeReplace: { [setId: string]: string }
  /** visual-editor offsets (px) and nick rotation (deg) — all default 0 */
  nickRotate: number
  avatarOffsetX: number
  avatarOffsetY: number
  badgeOffsetX: number
  badgeOffsetY: number
  tsOffsetX: number
  tsOffsetY: number
  textOffsetX: number
  textOffsetY: number
  /** TRUE credits: every message floats upward continuously at a constant speed */
  creditsMode: boolean
  /** credits float speed, px/second */
  creditsSpeed: number
  /** credits band height, px — messages vanish at its top; 0 = full screen */
  creditsHeight: number
  /** flood behavior: accelerate the whole tape (up to 4x) instead of dropping messages */
  creditsRush: boolean
  /** smooth push: new messages slide the chat instead of jumping */
  smoothScroll: boolean
  /** ms of the smooth push */
  smoothScrollMs: number
  /** px padding around the chat zone */
  zonePad: number
  /** px of gradient fade-out mask at the trailing edge (old messages melt away); 0 = off */
  edgeFade: number

  // ----- entrance / exit animation -----
  animIn:
    | 'none' | 'fade' | 'slide' | 'pop' | 'bounce' | 'zoom' | 'flip' | 'blur' | 'elastic'
    | 'swing' | 'drop' | 'roll' | 'spin' | 'stretch' | 'glitch' | 'flash'
    | 'rise' | 'slam' | 'rubber' | 'wobble' | 'fold' | 'skew' | 'neon' | 'tilt' | 'typewriter' | 'hinge'
  /** where the entrance comes FROM (directional animations only) */
  animDir: 'left' | 'right' | 'up' | 'down'
  animOut:
    | 'none' | 'fade' | 'shrink' | 'slide' | 'zoom' | 'blur' | 'flip' | 'spin' | 'drop' | 'roll'
    | 'rise' | 'slam' | 'wobble' | 'fold' | 'skew' | 'tilt' | 'hinge' | 'glitch'
  /** where the exit flies TO (directional animations only) */
  animOutDir: 'left' | 'right' | 'up' | 'down'
  /** legacy shared duration (ms) — kept as a fallback for animInMs/animOutMs */
  animMs: number
  /** entrance duration (ms); falls back to animMs when absent */
  animInMs?: number
  /** exit duration (ms); falls back to animMs when absent */
  animOutMs?: number

  // ----- message sound -----
  msgSoundEnabled: boolean
  /** uploaded sound as data URL */
  msgSoundData?: string
  /** 0..1 */
  msgSoundVolume: number

  // ----- 3D perspective of the whole chat zone -----
  /** deg, rotateX (tilt back/forward) */
  tiltX: number
  /** deg, rotateY (turn left/right) */
  tiltY: number
  /** deg, flat rotation */
  rotate: number
  /** px perspective depth (smaller = more dramatic) */
  perspDepth: number
  /** px shift of the whole chat zone (rescue it when perspective pushes it off-screen) */
  zoneOffsetX: number
  zoneOffsetY: number

  // ----- text -----
  font: string
  fontSize: number
  bold: boolean
  italic: boolean
  textTransform: 'none' | 'upper' | 'lower'
  textColor: string
  outlineWidth: number
  outlineColor: string
  shadowBlur: number
  shadowColor: string
  glowSize: number
  glowColor: string
  /** emote height in em (1 = text height) */
  emoteScale: number

  // ----- message plate -----
  /** none · fit = plate hugs content · line = full width · panel = one backdrop under all */
  plateMode: 'none' | 'fit' | 'line' | 'panel'
  plateBg: OverlayFill
  /** [tl, tr, br, bl] px */
  plateRadius: [number, number, number, number]
  /** rect honors plateRadius; others are clip-path presets */
  plateShape: 'rect' | 'pill' | 'slant' | 'bubble' | 'notch'
  /** px of the slant / corner cut for the shaped plates */
  plateShapeSize: number
  /** px of 3D extrusion under the plate (stacked darker layers), 0 = flat */
  plateDepth: number
  /** animated border/glow effect */
  plateAnim: 'none' | 'blink' | 'flow' | 'candle'
  /** seconds per animation cycle */
  plateAnimSpeed: number
  /** colors the blink/flow animation cycles through */
  plateAnimColors: string[]
  /** the glow follows the border animation */
  plateAnimSync: boolean
  plateBorderWidth: number
  plateBorderColor: string
  plateBorderStyle: 'solid' | 'dashed' | 'dotted' | 'double'
  /** 0..1 border transparency */
  plateBorderOpacity: number
  /** px soft halo in the border color (0 = crisp border only) */
  plateBorderBlur: number
  /** real drop shadow: offset + blur */
  plateShadowBlur: number
  plateShadowColor: string
  plateShadowX: number
  plateShadowY: number
  /** px colored glow around the plate, 0 = off */
  plateGlowSize: number
  plateGlowColor: string
  /** px backdrop blur behind the plate (frosted glass), 0 = off */
  plateBlur: number
  /** px feathered (blurred) plate edges via mask, 0 = off */
  plateEdgeBlur: number
  plateImage?: string
  plateImageOpacity: number
  plateImageFit: 'cover' | 'contain' | 'stretch'
  /** PNG whose alpha defines the plate's shape (CSS mask-image) */
  plateMask?: string
  /** 0 = auto */
  plateWidth: number
  plateHeight: number
  platePadX: number
  platePadY: number

  // ----- nick -----
  /** inline = before text · above = own row above text */
  nickPos: 'inline' | 'above'
  /** twitch = user's chat color (7TV paints ride along when enabled) */
  nickColorMode: 'twitch' | 'fixed' | 'palette'
  nickFixedColor: string
  /** palette mode: a color is picked per user (stable hash) */
  nickPalette: string[]
  nickBold: boolean
  nickItalic: boolean
  /** % of fontSize */
  nickScale: number
  nickTransform: 'none' | 'upper' | 'lower'
  /** own chip/plate behind the nick — works in any position */
  nickBgEnabled: boolean
  nickBg: OverlayFill
  nickBgRadius: number
  nickPadX: number
  nickPadY: number
  /** free nudge of the nick block, px (e.g. a cap overlapping the plate edge) */
  nickOffsetX: number
  nickOffsetY: number
  /** float the nick OVER the plate (absolute): it stops pushing the message down and moves
   *  freely via align + offsets while the text centers in its own plate */
  nickFloat: boolean
  /** where the nick block sits across the message width (nickPos = above) */
  nickAlign: 'left' | 'center' | 'right'
  /** message text alignment inside its own plate */
  msgAlign: 'left' | 'center' | 'right'
  // nick chip extras (mirror the plate's toolbox)
  nickBorderWidth: number
  nickBorderColor: string
  nickShadowBlur: number
  nickShadowColor: string
  nickGlowSize: number
  nickGlowColor: string
  /** px backdrop blur behind the chip */
  nickBlur: number
  nickImage?: string
  nickImageOpacity: number

  // ----- avatar -----
  avatarShow: boolean
  avatarPos: 'left' | 'right'
  avatarSize: number
  /** 0..50 (% border-radius; 50 = circle) */
  avatarRadius: number

  // ----- badges -----
  badgesShow: boolean
  badgesPos: 'before' | 'after'
  /** px height */
  badgeSize: number

  // ----- timestamp -----
  tsShow: boolean
  tsSeconds: boolean
  tsColor: string
  /** before or after the nick block */
  tsPos: 'before' | 'after'

  // ----- decor -----
  decors: OverlayDecor[]

  // ----- word/symbol triggers -----
  triggers: OverlayTrigger[]

  // ----- content -----
  hiddenUsers: string[]
  hideCommands: boolean
  showRedeems: boolean
  showBits: boolean
  showSubs: boolean
  showModActions: boolean

  // ----- escape hatch -----
  customCss: string
}

export const DEFAULT_FILL: OverlayFill = { kind: 'solid', color: '#000000', opacity: 0.45, color2: '#3a0ca3', angle: 135 }

export const DEFAULT_CHAT_OVERLAY: Omit<ChatOverlayConfig, 'id' | 'name'> = {
  type: 'chat',
  layout: 'list',
  direction: 'up',
  align: 'left',
  anchor: 'bottom',
  maxMessages: 15,
  fadeAfter: 0,
  lineGap: 4,
  meStyle: 'colored',
  badgeKinds: [],
  userBadges: [],
  badgeReplace: {},
  nickRotate: 0,
  avatarOffsetX: 0,
  avatarOffsetY: 0,
  badgeOffsetX: 0,
  badgeOffsetY: 0,
  tsOffsetX: 0,
  tsOffsetY: 0,
  textOffsetX: 0,
  textOffsetY: 0,
  creditsMode: false,
  creditsSpeed: 40,
  creditsHeight: 0,
  creditsRush: false,
  smoothScroll: false,
  smoothScrollMs: 300,
  zonePad: 8,
  edgeFade: 0,
  animIn: 'slide',
  animDir: 'down',
  animOut: 'fade',
  animOutDir: 'left',
  animMs: 200,
  animInMs: 300,
  animOutMs: 300,
  msgSoundEnabled: false,
  msgSoundVolume: 0.5,
  tiltX: 0,
  tiltY: 0,
  rotate: 0,
  perspDepth: 800,
  zoneOffsetX: 0,
  zoneOffsetY: 0,
  font: '',
  fontSize: 16,
  bold: false,
  italic: false,
  textTransform: 'none',
  textColor: '#ffffff',
  outlineWidth: 2,
  outlineColor: '#000000',
  shadowBlur: 0,
  shadowColor: '#000000',
  glowSize: 0,
  glowColor: '#a970ff',
  emoteScale: 1.4,
  plateMode: 'none',
  plateBg: DEFAULT_FILL,
  plateRadius: [8, 8, 8, 8],
  plateShape: 'rect',
  plateShapeSize: 12,
  plateDepth: 0,
  plateAnim: 'none',
  plateAnimSpeed: 2,
  plateAnimColors: ['#9147ff', '#5cffe0', '#ff5c8a'],
  plateAnimSync: true,
  plateBorderWidth: 0,
  plateBorderColor: '#ffffff',
  plateBorderStyle: 'solid',
  plateBorderOpacity: 1,
  plateBorderBlur: 0,
  plateShadowBlur: 0,
  plateShadowColor: '#000000',
  plateShadowX: 0,
  plateShadowY: 2,
  plateGlowSize: 0,
  plateGlowColor: '#a970ff',
  plateBlur: 0,
  plateEdgeBlur: 0,
  plateImageOpacity: 1,
  plateImageFit: 'cover',
  plateWidth: 0,
  plateHeight: 0,
  platePadX: 10,
  platePadY: 4,
  nickPos: 'inline',
  nickColorMode: 'twitch',
  nickFixedColor: '#a970ff',
  nickPalette: ['#ff5c8a', '#5cb2ff', '#7cff5c', '#ffd75c', '#c95cff', '#5cffe0'],
  nickBold: true,
  nickItalic: false,
  nickScale: 100,
  nickTransform: 'none',
  nickBgEnabled: false,
  nickBg: { kind: 'solid', color: '#9147ff', opacity: 1, color2: '#3a0ca3', angle: 135 },
  nickBgRadius: 8,
  nickPadX: 8,
  nickPadY: 1,
  nickOffsetX: 0,
  nickOffsetY: 0,
  nickFloat: false,
  nickAlign: 'left',
  msgAlign: 'left',
  nickBorderWidth: 0,
  nickBorderColor: '#ffffff',
  nickShadowBlur: 0,
  nickShadowColor: '#000000',
  nickGlowSize: 0,
  nickGlowColor: '#a970ff',
  nickBlur: 0,
  nickImageOpacity: 1,
  avatarShow: false,
  avatarPos: 'left',
  avatarSize: 28,
  avatarRadius: 50,
  badgesShow: true,
  badgesPos: 'before',
  badgeSize: 18,
  tsShow: false,
  tsSeconds: false,
  tsColor: '#b8b8c0',
  tsPos: 'after',
  decors: [],
  triggers: [],
  hiddenUsers: [],
  hideCommands: false,
  showRedeems: true,
  showBits: true,
  showSubs: true,
  showModActions: false,
  customCss: ''
}

/**
 * Structured chat line pushed to the overlay page — the page assembles the DOM itself
 * according to the active ChatOverlayConfig, so layout/position changes restyle already
 * visible messages live.
 */
export interface OverlayLineData {
  id: string
  /** twitch user id (delete-by-user on timeouts) */
  user: string
  login: string
  nick: string
  /** resolved nick color (twitch or 7TV solid) */
  color: string
  /** /me action message */
  act?: boolean
  /** 7TV paint — CSS background value clipped to the nick text */
  paint?: string
  avatar?: string
  /** badge image urls */
  badges: string[]
  /** badge setIds parallel to `badges` (for kind filtering on the page) */
  badgeSets?: string[]
  /** badge versions parallel to `badges` (per-variant replacement, e.g. predictions) */
  badgeVers?: string[]
  /** message body as safe HTML (emotes/cheers as <img>) */
  body: string
  /** plain message text (for word/symbol triggers on the page) */
  text?: string
  /** system/usernotice header text (escaped) — sub, redeem name, raid… */
  sys?: string
  kind: 'msg' | 'info'
  /** epoch ms */
  ts: number
  // page-side per-overlay filter flags
  redeem?: boolean
  bits?: boolean
  sub?: boolean
  mod?: boolean
  cmd?: boolean
}

/** @deprecated legacy v1 style — replaced by ChatOverlayConfig; kept until settings UI migrates */
export const DEFAULT_OVERLAY_STYLE: Omit<OverlayProfile, 'id' | 'name'> = {
  font: '',
  fontSize: 16,
  bold: false,
  textColor: '#ffffff',
  textAlign: 'left',
  outlineWidth: 2,
  outlineColor: '#000000',
  shadowBlur: 0,
  shadowColor: '#000000',
  glowSize: 0,
  glowColor: '#a970ff',
  bgMode: 'none',
  bgColor: '#000000',
  bgOpacity: 0.4,
  bgRadius: 8,
  bgShadowBlur: 0,
  bgShadowColor: '#000000',
  bgImageOpacity: 1,
  bgWidth: 0,
  bgHeight: 0,
  bgKeepAspect: false,
  hiddenUsers: [],
  messageDir: 'up',
  lineGap: 2,
  fade: 0,
  max: 15
}

// ---------- Hotkeys ----------

/** built-in synthesized notification sounds */
export type SoundPreset = 'ping' | 'pop' | 'bell' | 'chime' | 'blip' | 'knock' | 'coin' | 'chirp' | 'buzz'
/** a sound choice: a built-in preset or an uploaded custom sound */
export type SoundChoice = SoundPreset | 'custom'
export const SOUND_PRESETS: SoundPreset[] = ['ping', 'pop', 'bell', 'chime', 'blip', 'knock', 'coin', 'chirp', 'buzz']

export type HotkeyAction =
  | 'reconnect'
  | 'scrollLock'
  | 'pauseHold'
  | 'translit'
  | 'resendLast'
  | 'sendKeep'

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  reconnect: 'F5',
  scrollLock: 'Ctrl+L',
  /** hold to pause the chat (scroll lock while held); releasing resumes */
  pauseHold: 'Alt',
  translit: 'Ctrl+Shift+T',
  /** send the input's text WITHOUT clearing it */
  sendKeep: 'Ctrl+Enter',
  /** re-send the previously sent message */
  resendLast: 'Ctrl+Shift+Enter'
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
  /** send the clicked message's text as your own, immediately */
  | 'resend'
  /** put the clicked message's text into the input (no send) */
  | 'msgToInput'

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
  /** pinned tabs always show, regardless of the online/offline filter */
  pinned?: boolean
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
  mentionSoundType: SoundChoice
  mentionSoundVolume: number // 0..1
  /** data URL of a user-provided sound file */
  mentionSoundCustomId?: string
  firstMessageSound: boolean
  firstMessageSoundType: SoundChoice
  firstMessageSoundVolume: number // 0..1
  firstMessageSoundCustomId?: string
  /** library of uploaded sound files, shared between mention/first-message pickers */
  customSounds: CustomSound[]
  /** Chatterino-style side panel listing highlighted (mention/keyword) messages */
  showHighlightSidebar: boolean
  messageLimit: number // ring buffer per channel
  emotePickerDefaultTab: 'favorites' | 'twitch' | 'thirdparty'
  /** twitch emote owner ids pinned to the top of the Twitch-tab list/rail */
  pinnedEmoteOwners: string[]
  emotePickerAsWindow: boolean
  showCharCounter: boolean
  messageSpacing: number // px, extra vertical padding per message
  caseSensitiveNicks: boolean
  /** use a user's 7TV cosmetic nick color when they have one */
  sevenTvNickColors: boolean
  /** independent zoom for the tab bar (1 = default) */
  tabScale: number
  /** filter tabs by live status: all · only live · only offline */
  tabFilter: 'all' | 'online' | 'offline'
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
  /** px size of the preview shown when hovering an emote in a chat message */
  chatEmoteHoverSize: number
  /** show viewer count / stream title / uptime in the pane header */
  showStreamInfo: boolean
  /** custom highlight colors (hex) */
  mentionBgColor: string
  firstMessageBgColor: string
  /** words/phrases that trigger the keyword alert sound */
  keywordAlerts: string[]
  keywordSound: boolean
  keywordSoundType: SoundChoice
  keywordSoundVolume: number
  keywordSoundCustomId?: string
  /** sound + banner when a watched channel goes live */
  streamUpSound: boolean
  streamUpSoundType: SoundChoice
  streamUpSoundVolume: number
  streamUpSoundCustomId?: string
  streamUpNotify: boolean
  /** sound when an incoming whisper arrives */
  whisperSound: boolean
  whisperSoundType: SoundChoice
  whisperSoundVolume: number
  whisperSoundCustomId?: string
  /** sound when a raid prompt appears */
  raidSound: boolean
  raidSoundType: SoundChoice
  raidSoundVolume: number
  raidSoundCustomId?: string
  /** sound when an error notification (red toast) appears */
  errorSound: boolean
  errorSoundType: SoundChoice
  errorSoundVolume: number
  errorSoundCustomId?: string
  /** chat bot commands ("!followage"…) suggested in the input when you type "!" */
  botCommands: string[]
  /** the укр⇄eng wrong-layout converter (Aа button + Ctrl+Shift+T) */
  translitEnabled: boolean
  /** words the layout converter must never touch (e.g. "!followage") */
  translitExcludeWords: string[]
  /** custom UI font family; empty = default system stack */
  fontFamily: string
  /** text size in the standalone user-card window */
  usercardFontSize: number
  /** background highlight toggles (sounds/detection stay independent) */
  showMentionBg: boolean
  showFirstMsgBg: boolean
  /** inline preview cards for links in chat (Twitch clips get title + thumbnail) */
  linkPreviews: boolean
  /** link URLs: full everywhere · short chip everywhere · short chip only in the overlay */
  linkDisplay: 'full' | 'short' | 'overlayShort'
  /** link preview cards only for Twitch clip links */
  linkPreviewsClipsOnly: boolean
  /** preview card scale, % (100 = normal) */
  linkPreviewScale: number
  /** account picker next to the input: full name select or a compact avatar button */
  inputAccountDisplay: 'name' | 'avatar'
  /** which tab the highlight sidebar opens on */
  highlightSidebarDefault: 'highlights' | 'mentions' | 'redeems'
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
  /** color of the flash when jumping to a replied-to message */
  flashColor: string
  /** emote/emoji suggestions while typing (slash commands and @mentions stay on) */
  emoteSuggestions: boolean
  /** open user cards in a separate window instead of the in-app popup */
  usercardAsWindow: boolean
  /** persisted 📌 state of the standalone user-card window */
  usercardPinned: boolean
  /** open whispers in a separate window instead of the popover */
  whispersAsWindow: boolean
  whispersPinned: boolean
  /** favorite whisper contacts (logins), pinned to the top of the list */
  whisperFavorites: string[]
  /** open the highlights panel in a separate window instead of the sidebar */
  highlightsAsWindow: boolean
  highlightsPinned: boolean
  /** px text size in the highlights panel */
  highlightsFontSize: number
  /** offer to add the channel involved in a raid */
  raidPrompt: boolean
  /** only offer for raids on the channel you're currently watching (active tab) */
  raidPromptActiveOnly: boolean
  /** how long (minutes) arrivals after a raid keep the 'raider' highlight; 0 = off */
  raiderHighlightMinutes: number
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
  /** OBS chat overlay (local SSE server + transparent browser-source page) */
  overlayEnabled: boolean
  overlayPort: number
  overlayFontSize: number
  /** css font family; empty = default */
  overlayFont: string
  /** seconds before a line fades out; 0 = keep forever */
  overlayFade: number
  overlayMax: number
  /** px gap between overlay lines */
  overlayLineGap: number
  overlayBadges: boolean
  overlayBold: boolean
  /** hide "!command" messages on the overlay */
  overlayHideCmd: boolean
  /** message text color (hex) */
  overlayTextColor: string
  /** text outline: 0 = off */
  overlayOutlineWidth: number
  overlayOutlineColor: string
  /** per-line background plate: color + 0..1 opacity (0 = fully transparent) */
  overlayBgColor: string
  overlayBgOpacity: number
  /** logins never shown on the overlay */
  overlayHiddenUsers: string[]
  /** event visibility on the overlay */
  overlayShowRedeems: boolean
  overlayShowBits: boolean
  overlayShowSubs: boolean
  /** show moderation lines (timeouts/bans/clears) on the overlay */
  overlayShowModActions: boolean
  /** named visual styles; each gets its own /overlay URL for a separate OBS source */
  overlayProfiles: OverlayProfile[]
  /** keep the overlay live preview pinned to the bottom of the settings while scrolling options */
  overlayPreviewPinned: boolean
  /** OBS overlays v2 — full editor; each overlay has its own /overlay URL */
  chatOverlays: ChatOverlayConfig[]
  /** user-saved overlay presets (full config snapshots minus id/name/type) */
  overlayUserPresets: { id: string; name: string; patch: Partial<ChatOverlayConfig> }[]
  /** monotonically increasing revision, bumped on every settings change — save paths use it
   *  so a window with STALE settings can never clobber a newer save from another window */
  _rev?: number
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
  pinnedEmoteOwners: [],
  emotePickerAsWindow: false,
  showCharCounter: true,
  messageSpacing: 3,
  caseSensitiveNicks: false,
  sevenTvNickColors: true,
  tabScale: 1,
  tabFilter: 'all',
  alwaysOnTop: false,
  settingsAsWindow: false,
  rememberPinState: true,
  emotePickerPinned: false,
  settingsPinned: false,
  emojiNameLang: 'both',
  badgeSize: 18,
  emotePreviewSize: 112,
  chatEmoteHoverSize: 128,
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
  raidSound: true,
  raidSoundType: 'bell',
  raidSoundVolume: 0.5,
  errorSound: false,
  errorSoundType: 'pop',
  errorSoundVolume: 0.5,
  botCommands: [
    '!accountage',
    '!followage',
    '!leaderboard',
    '!points',
    '!queue',
    '!slots',
    '!song',
    '!vanish',
    '!watchtime'
  ],
  translitEnabled: true,
  translitExcludeWords: ['!followage', '!drop', '!time', '!uptime'],
  fontFamily: '',
  usercardFontSize: 14,
  showMentionBg: true,
  showFirstMsgBg: true,
  linkPreviews: true,
  linkDisplay: 'full',
  linkPreviewsClipsOnly: false,
  linkPreviewScale: 100,
  inputAccountDisplay: 'name',
  highlightSidebarDefault: 'highlights',
  lineSpacing: 0,
  rememberWindowSize: true,
  muted: false,
  customFonts: [],
  mentionBgOpacity: 0.2,
  flashColor: '#a970ff',
  emoteSuggestions: true,
  usercardAsWindow: false,
  usercardPinned: false,
  whispersAsWindow: false,
  whispersPinned: false,
  whisperFavorites: [],
  highlightsAsWindow: false,
  highlightsPinned: false,
  highlightsFontSize: 12,
  raidPrompt: true,
  raidPromptActiveOnly: false,
  raiderHighlightMinutes: 10,
  raidPromptDest: 'split',
  showBits: true,
  showRedeems: true,
  mutedUsers: [],
  savedColors: [],
  recentColors: [],
  hotkeys: {},
  swipeTimeouts: [60, 300, 600, 1800, 3600, 86400],
  overlayEnabled: false,
  overlayPort: 4715,
  overlayFontSize: 16,
  overlayFont: '',
  overlayFade: 0,
  overlayMax: 15,
  overlayLineGap: 2,
  overlayBadges: true,
  overlayBold: false,
  overlayHideCmd: false,
  overlayTextColor: '#ffffff',
  overlayOutlineWidth: 2,
  overlayOutlineColor: '#000000',
  overlayBgColor: '#000000',
  overlayBgOpacity: 0,
  overlayHiddenUsers: [],
  overlayShowRedeems: true,
  overlayShowBits: true,
  overlayShowSubs: true,
  overlayShowModActions: false,
  overlayProfiles: [],
  overlayPreviewPinned: false,
  chatOverlays: [],
  overlayUserPresets: [],
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
