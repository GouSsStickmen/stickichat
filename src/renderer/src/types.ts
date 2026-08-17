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
  /**
   * A 7TV emote set changed. Kept structured rather than baked into a sentence so the line can
   * show the emotes themselves — the name alone tells you nothing about what was added, which is
   * the one thing you actually want to see.
   */
  emoteEvent?: {
    kind: 'added' | 'removed'
    /** who did it, when 7TV says */
    actor?: string
    emotes: { code: string; url?: string }[]
  }
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
  /**
   * Somebody followed the channel.
   *
   * Unlike every other event here there is no chat message behind it — Twitch never sends one —
   * so the line is built locally from the EventSub payload, and `login`/`displayName` carry the
   * follower so the events panel and the usercard work on it like on any other entry.
   */
  follow?: boolean
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
  /** provider-side emote id — lets a click open the emote's page on 7TV/BTTV/FFZ */
  id?: string
  /** who owns the emote (7TV), shown in the tooltip and used for "open their channel" */
  ownerLogin?: string
  ownerName?: string
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
  /** this emote is itself a zero-width LAYER — kept so the favorites tab can mark it too */
  zeroWidth?: boolean
  /** zero-width layers saved together with the base — a whole 7TV-style combination */
  overlays?: { code: string; url: string; provider: EmoteProvider }[]
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
  | 'sharedChat'
  /** subscriptions, resubs, gifts and gift upgrades — the whole sub family */
  | 'subEvent'
  /** somebody followed the channel — the only category with no message behind it */
  | 'follow'

/** kinds that don't need a value input (the category itself is the match) */
export const VALUELESS_HL_KINDS: ReadonlySet<HighlightKind> = new Set([
  'own', 'redeem', 'bits', 'raider', 'firstMsg', 'firstStream', 'watchStreak', 'sharedChat', 'subEvent', 'follow'
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

import type { Anchor9, OverlayScene } from './lib/overlayScene'

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
  /**
   * What provokes it. Absent means 'word', so every trigger that already exists keeps working.
   *
   * The event kinds ignore `word` entirely — a first message is not a string anyone can type,
   * and asking the streamer to invent one would be a puzzle with no answer.
   */
  on?: 'word' | 'firstMsg' | 'firstStream'
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
 * What every overlay carries, whatever it draws.
 *
 * The manager, the URL, the live-config push and the delete-detection all work on this much and
 * nothing more — which is what lets a new kind of overlay be a new config shape and a new page,
 * instead of another pass through every one of those places.
 */
export interface OverlayBase {
  id: string
  name: string
  /** channel baked into the OBS URL; empty/undefined = first open chat */
  channel?: string
  /**
   * Whether the editor's preview keeps acting things out by itself.
   *
   * Only the preview reads this — an OBS source has no demo to switch off. A wheel that spins
   * every few seconds while its colours are being picked is unusable, so it can be stopped.
   */
  previewDemo?: boolean
}

/** every overlay kind there is; the discriminant of the OverlayConfig union */
export type OverlayKind = 'chat' | 'emotes' | 'goal' | 'follow' | 'roulette'

/** One OBS chat overlay instance. */
export interface ChatOverlayConfig extends OverlayBase {
  type: 'chat'

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
  /** page-flip: fill the page, then flip to a blank sheet and start writing fresh */
  pageFlip: boolean
  /** page-flip animation duration (ms) */
  pageFlipMs: number
  /** page-flip direction: which way the filled page turns away */
  pageFlipDir: 'up' | 'down' | 'left' | 'right'
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
  /** backdrop saturation % applied with the blur (100 = untouched) — the 'glass' look */
  plateSaturate: number
  /** 0..100 diagonal sheen + inner edge highlight strength, like a pane of glass */
  plateGloss: number
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

  /**
   * Wear the chatter's 7TV paint on their nick.
   *
   * Its own switch, because the app-wide one is about the streamer's chat window and had no
   * business deciding what the stream shows — turning paints off to make the client readable
   * silently turned them off on stream too.
   */
  nickPaint: boolean
  /**
   * Mark a user's very first message in the channel.
   *
   * This one WINS over the per-stream mark when both are true, because it always is: somebody's
   * first words ever are also their first words today. Marking that as "first this stream" tells
   * the streamer the smaller of the two facts and hides the bigger one.
   */
  hlFirstMsg: boolean
  hlFirstMsgColor: string
  /** the chip's words for this category; empty = no chip even when chips are on */
  hlFirstMsgLabel: string
  /** mark their first message of this stream */
  hlFirstStream: boolean
  hlFirstStreamColor: string
  hlFirstStreamLabel: string
  /**
   * HOW a first message is marked — three switches that stack in any combination.
   *
   * Everything is drawn onto the plate the overlay already has, never instead of it: the frame
   * takes the plate's own corner radius and shape, the glow follows its silhouette, the fill
   * keeps the gradient or picture underneath visible until its opacity reaches the top, where it
   * becomes simply a differently coloured plate. A mark that ignored the design would look like
   * a second overlay had leaked in.
   *
   * They are optional because `hlFirstMode` came first and was single-choice. An overlay that
   * only has the old field is read through it, so nothing changes look on update; the editor
   * writes all three the moment one is touched.
   */
  hlFirstBorder?: boolean
  hlFirstGlow?: boolean
  hlFirstFill?: boolean
  /** legacy single choice, still read when none of the three switches above exist */
  hlFirstMode: 'tint' | 'border' | 'glow' | 'both' | 'plate'
  /** frame thickness, px */
  hlFirstSize: number
  /** glow spread, px — its own number, because a thin frame with a wide halo is a normal want */
  hlFirstGlowSize?: number
  /** strength of the fill, 0..1; at 1 it covers the plate's own colours entirely */
  hlFirstOpacity: number
  /** repaint the message text; empty = leave it as the overlay draws it */
  hlFirstTextColor?: string
  /** a small caption above the message ("Перше повідомлення") in the accent colour */
  hlFirstLabel: boolean
  /** breathe the mark for a few seconds so it is noticed in a moving chat */
  hlFirstPulse: boolean

  // ----- word/symbol triggers -----
  triggers: OverlayTrigger[]

  /**
   * The element/layer document, for the beta edit mode.
   *
   * Optional and additive on purpose: an overlay without one behaves exactly as it always has,
   * and turning the beta on converts what is already there rather than starting blank. Nothing
   * reads this until `editMode` says so, so the flat fields above stay authoritative until the
   * user opts in — which is what makes this safe to ship half-built.
   */
  scene?: OverlayScene
  /** which editor drives this overlay; absent = classic */
  editMode?: 'classic' | 'beta'
  /** id of the trigger being edited: the overlay pins it permanently so its position can be
   *  dialled in live instead of waiting for someone to type the word. Never persisted. */
  triggerPreviewId?: string | null

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

/**
 * Emotes scattering across the screen — the celebration overlay.
 *
 * Every emote that goes through chat can become a sprite flying over the stream. Animated ones
 * stay animated, because they arrive as the same GIF or WebP the chat uses and an <img> plays it
 * without being asked.
 *
 * The motion is deliberately not one canned effect. "Confetti" and "a slow drift" and "thrown in
 * from the left" are different feelings, and a celebration overlay that can only do one of them
 * gets used once.
 */
export interface EmoteRainOverlayConfig extends OverlayBase {
  type: 'emotes'

  // ----- what sets it off -----
  /** ordinary chat messages contribute their emotes */
  onChat: boolean
  /** ignore messages with fewer than this many emotes; 1 = every emote counts */
  minEmotes: number
  /** cheers, and how many bits it takes */
  onBits: boolean
  bitsMin: number
  /** subs, resubs and gifts */
  onSubs: boolean
  /** channel-point redemptions */
  onRedeems: boolean
  /** newline-separated words that set it off on their own; empty = off */
  words: string
  /** only these people can set it off (logins, newline-separated); empty = everyone */
  allowUsers: string
  /** at most this many distinct emotes taken from one message */
  perMessage: number
  /** how many sprites each emote spawns */
  copies: number
  /** biggest celebration a single message may cause, sprites */
  burstMax: number

  // ----- how many, how long -----
  maxOnScreen: number
  /** seconds before a sprite fades out; 0 = until it leaves the screen */
  lifetimeS: number

  // ----- how they look -----
  /** px; each sprite picks a random size in this range */
  sizeMin: number
  sizeMax: number
  opacity: number
  /** a soft drop shadow so light emotes stay visible on a light scene */
  shadow: boolean
  /** hue-rotate every sprite by a random amount — parties, not accuracy */
  rainbow: boolean

  // ----- how they move -----
  /**
   * fall     from above, like snow or confetti
   * rise     up from the bottom, like bubbles
   * burst    thrown out from one point in every direction
   * float    drifting across, entering from a random edge
   * fly      straight across the screen from one side
   * physics  thrown with gravity, bouncing off the floor and walls
   */
  motion: 'fall' | 'rise' | 'burst' | 'float' | 'fly' | 'physics'
  /** where they come in from; `burst` uses it as the centre of the explosion */
  from: 'top' | 'bottom' | 'left' | 'right' | 'random' | 'center'
  /** px per second, randomised per sprite */
  speedMin: number
  speedMax: number
  /** how much of a spread the direction gets, degrees */
  spread: number
  /** px/s² for the physics mode */
  gravity: number
  /** 0..1 — how much speed a bounce keeps */
  bounce: number
  /** max degrees per second; each sprite picks its own and its own direction */
  spin: number
  /** sideways sway, px */
  wobble: number
  /** grow in on spawn / fade out at the end */
  scaleIn: boolean
  fadeOut: boolean
}

/**
 * A goal bar — followers, subs, bits, or anything counted by hand.
 *
 * The count is a base plus what the app has seen since, rather than a number fetched from Twitch:
 * the totals that matter here either need scopes the streamer may not have granted or do not
 * exist as an API at all (bits this stream). A base the streamer types once, plus honest live
 * counting, works for every metric and never shows a number nobody can explain.
 */
export interface GoalOverlayConfig extends OverlayBase {
  type: 'goal'

  metric: 'followers' | 'subs' | 'bits' | 'custom'
  /**
   * Where the number comes from.
   *
   * `auto` asks Twitch for the real total, which only exists for followers and subscribers, and
   * only for an account that is the broadcaster (or a mod, for followers). `events` counts what
   * chat announces since the last reset — the only thing possible for bits, and the fallback
   * whenever the scope was never granted. Saying which one is in use beats a goal that silently
   * sits at zero.
   */
  source: 'auto' | 'events'
  /** where the count starts — today's followers, this month's subs, whatever the goal means */
  base: number
  target: number
  /** counted since `base` was set; the editor can reset it */
  progress: number
  /** gifted subs add their whole batch rather than one */
  countGifts: boolean

  // ----- text -----
  title: string
  /** shown once the target is reached; empty = keep showing the numbers */
  doneText: string
  font: string
  fontSize: number
  textColor: string
  /** current/target, a percentage, both, or nothing */
  numbers: 'value' | 'percent' | 'both' | 'none'
  showTitle: boolean
  /** put the words inside the bar instead of above it */
  textInside: boolean
  /**
   * Words of the streamer's own, with the numbers written in where they want them.
   *
   * `{value} {target} {left} {percent}` are replaced as they are drawn. Empty falls back to the
   * plain "17 / 100 · 17%", which is fine but says nothing about what the goal is for.
   */
  customText: string

  // ----- shape -----
  shape: 'bar' | 'ring' | 'text'
  width: number
  height: number
  radius: number
  /** ring only: how thick the stroke is */
  ringWidth: number

  // ----- colours -----
  trackFill: OverlayFill
  barFill: OverlayFill
  doneFill: OverlayFill
  borderWidth: number
  borderColor: string
  glowSize: number
  glowColor: string
  /**
   * Paint the outline and the glow with the bar's own fill.
   *
   * Same idea as the alert plate: a gradient bar with a one-colour ring around it always looks
   * like the colour was picked wrong, and with more than two stops there is no right answer.
   */
  fxFromFill?: boolean
  /** ms for the bar to travel to a new value */
  animMs: number
  /** legacy single switch; `gainFx` takes over once it exists */
  pulseOnGain: boolean
  /**
   * What happens when the number goes up — a new follower, a sub, a cheer.
   *
   * The page needs no separate event feed for this: the count arrives with the config, so a value
   * bigger than the last one IS the event. That also means it survives a source restart, which a
   * fire-and-forget alert would not.
   */
  gainFx: 'none' | 'pulse' | 'flash' | 'shake' | 'pop'
  /** float the amount gained ("+1", "+100") above the bar */
  gainLabel: boolean
  gainColor: string

  /** a picture or GIF that belongs to the goal — a mascot, an emote, a trophy */
  image: string
  /** where it goes: inside the bar, beside it, or filling the bar's background */
  imagePlace: 'left' | 'right' | 'inLeft' | 'inRight' | 'above' | 'below' | 'fill'
  /** px; the height for the beside/inside placements */
  imageSize: number
  imageOpacity: number
  /** a second picture shown only once the goal is reached */
  doneImage: string

  customCss: string
}

/** the entrance/exit animations a follow alert can use; `custom` runs uploaded keyframes */
export type AlertAnim =
  | 'none'
  | 'fade'
  | 'slideUp'
  | 'slideDown'
  | 'slideLeft'
  | 'slideRight'
  | 'pop'
  | 'zoom'
  | 'bounce'
  | 'flip'
  | 'swing'
  | 'blur'
  | 'glitch'
  | 'wipe'
  | 'custom'

export const ALERT_ANIMS: AlertAnim[] = [
  'none', 'fade', 'slideUp', 'slideDown', 'slideLeft', 'slideRight',
  'pop', 'zoom', 'bounce', 'flip', 'swing', 'blur', 'glitch', 'wipe', 'custom'
]

/**
 * A follow alert: somebody followed, so something appears on stream and then leaves.
 *
 * Built out of slots rather than one canned card — a picture, an avatar, a headline and a second
 * line, each of which can be turned off, moved and sized. That is what makes it possible to build
 * something that does not look like every other alert, which is the whole reason a streamer would
 * use their own client's overlay instead of the usual service.
 */
export interface FollowOverlayConfig extends OverlayBase {
  type: 'follow'

  // ----- timing -----
  /** seconds on screen, not counting the animations */
  durationS: number
  animInMs: number
  animOutMs: number
  /** alerts queue instead of overlapping; extra pause between them, ms */
  gapMs: number
  /** most alerts kept waiting; older ones are dropped when a raid floods the queue */
  queueMax: number

  // ----- animation -----
  animIn: AlertAnim
  animOut: AlertAnim
  /**
   * Uploaded keyframes, used when an animation is set to `custom`.
   *
   * The CSS is injected as-is and referenced by name, so anything a browser can animate works —
   * which is the only honest way to let somebody bring their own animation to a web overlay.
   */
  customAnimCss: string
  customAnimInName: string
  customAnimOutName: string

  // ----- the picture -----
  /** an image, a GIF or a video — the kind is read off the data url, not configured */
  image: string
  /** px width; 0 = natural size */
  imageWidth: number
  /** a PNG whose alpha cuts the picture's shape, or one of the built-in shapes */
  mask: string
  maskShape: 'none' | 'circle' | 'rounded' | 'hexagon' | 'star' | 'blob'
  /** soften the mask edge, px */
  maskFeather: number
  /** the picture keeps animating on its own while the alert is up */
  imageLoop: 'none' | 'float' | 'pulse' | 'spin' | 'shake'
  /**
   * Free placement, used when `layout` is 'free'.
   *
   * The five arrangements cover the usual alert and nothing else; anything with a mascot leaning
   * on the words from a corner needs real coordinates. The anchor is which point of the STAGE the
   * offsets are measured from, so a picture pinned bottom-right stays there at any resolution.
   */
  imageAnchor: Anchor9
  imageX: number
  imageY: number
  imageRotate: number
  imageOpacity: number
  /** the words get their own placement in free mode, or they would be stranded */
  textAnchor: Anchor9
  textX: number
  textY: number

  // ----- the follower's avatar -----
  avatarShow: boolean
  avatarSize: number
  avatarRound: boolean
  avatarRing: number
  avatarRingColor: string

  // ----- words -----
  /** {user} is replaced with the follower's display name */
  title: string
  subtitle: string
  font: string
  titleSize: number
  subtitleSize: number
  titleColor: string
  subtitleColor: string
  /** paint the name inside the title differently from the rest of it */
  nameColor: string
  outlineWidth: number
  outlineColor: string
  shadowBlur: number
  shadowColor: string

  // ----- arrangement -----
  /** where the whole alert sits on the screen */
  anchor: 'top' | 'center' | 'bottom'
  align: 'left' | 'center' | 'right'
  offsetX: number
  offsetY: number
  /** picture above the words, beside them, behind them — or placed by hand */
  layout: 'imageTop' | 'imageLeft' | 'imageRight' | 'imageBehind' | 'textOnly' | 'free'
  gap: number

  // ----- the plate behind it -----
  plate: boolean
  plateFill: OverlayFill
  /**
   * A picture, GIF or video for the plate instead of a flat fill.
   *
   * Video because a looping MP4 is a fraction of the size of the same seconds as a GIF, and an
   * alert backdrop is exactly the kind of short loop where that difference is the whole budget.
   */
  plateMedia: string
  plateMediaFit: 'cover' | 'contain' | 'stretch'
  plateMediaOpacity: number
  /** a ready-made outline for the plate; `rect` keeps plateRadius */
  plateShape: PlateShape
  /** a PNG whose alpha cuts the plate instead, when a preset is not the shape you meant */
  plateMask: string
  /**
   * Paint the outline and the glow with the plate's own fill.
   *
   * A gradient plate ringed in one flat colour picked out of it always looks like a mistake, and
   * picking the "right" one by hand is impossible once the gradient has more than two stops.
   */
  plateFxFromFill: boolean
  plateRadius: number
  platePadX: number
  platePadY: number
  plateBorderWidth: number
  plateBorderColor: string
  plateGlowSize: number
  plateGlowColor: string

  // ----- sound -----
  soundData: string
  soundVolume: number

  customCss: string
}

/**
 * The ready-made plate outlines.
 *
 * Shared by every overlay that draws a plate, so a shape learned in one editor means the same
 * thing in the next one. `rect` is the plain rounded box and the only one that reads a radius.
 */
export type PlateShape =
  | 'rect'
  | 'pill'
  | 'circle'
  | 'notch'
  | 'hexagon'
  | 'hexflat'
  | 'ribbon'
  | 'ticket'
  | 'banner'
  | 'shield'
  | 'tag'
  | 'slant'
  | 'blob'

/** one wedge of the wheel */
export interface WheelSection {
  id: string
  label: string
  /**
   * How likely this wedge is, and how wide it is drawn.
   *
   * The two are the same number on purpose: a wheel whose slices do not match their odds is a lie
   * told to the viewers, and the whole appeal of spinning one on stream is that everybody can see
   * the chances.
   */
  weight: number
  color: string
  textColor: string
  /** an image, GIF or video drawn inside the wedge */
  media: string
  /** how big that picture is drawn, per cent of the wheel; 100 = exactly covers it */
  mediaScale?: number
  /** and where its centre sits, in pixels from the middle of the wheel */
  mediaX?: number
  mediaY?: number
  /** remove this wedge once it has won — for giveaways that should not repeat */
  removeOnWin: boolean
}

/**
 * The wheel of fortune.
 *
 * The winner is chosen in the app, not on the page: the result has to be announceable in chat and
 * has to be the same for every browser source pointed at this overlay, and a page that rolled its
 * own dice could guarantee neither.
 */
export interface RouletteOverlayConfig extends OverlayBase {
  type: 'roulette'

  sections: WheelSection[]

  // ----- what makes it spin -----
  /** a chat command, a channel-point reward, or only the editor's button */
  trigger: 'command' | 'redeem' | 'manual'
  command: string
  /** who may use the command */
  who: 'broadcaster' | 'mods' | 'everyone'
  redeemTitle: string
  /** seconds before it can be spun again; 0 = no limit */
  cooldownS: number
  /** write the result into chat when it lands */
  announce: boolean
  announceText: string

  // ----- the spin -----
  spinS: number
  /** whole turns before it starts easing into the winner */
  turns: number
  /** how abruptly it settles; higher = longer glide at the end */
  easing: 'smooth' | 'snappy' | 'heavy'
  /** how long the winner stays up afterwards, seconds */
  resultS: number

  // ----- the wheel -----
  size: number
  rimWidth: number
  rimColor: string
  /** a line between the wedges */
  dividerWidth: number
  dividerColor: string
  font: string
  fontSize: number
  /** text along the radius, or upright */
  textRadial: boolean
  /** the marker that picks the winner */
  pointer: 'triangle' | 'arrow' | 'pin' | 'none'
  pointerColor: string
  /** the disc in the middle: a logo, an avatar, anything */
  hubMedia: string
  hubSize: number
  /**
   * One picture across the whole disc, turning with it.
   *
   * Different thing from the backdrop: this one is the wheel's own face, clipped to the circle and
   * spinning, so a drawn wheel can be used as-is with the wedges left as invisible geometry.
   */
  faceMedia?: string
  faceOpacity?: number

  // ----- around it -----
  /** image, GIF or video behind the whole wheel; it does not turn */
  backdrop: string
  backdropFit: 'cover' | 'contain' | 'stretch'
  backdropOpacity: number
  /** the winner's name, drawn over the wheel when it stops */
  resultShow: boolean
  resultSize: number
  resultColor: string

  // ----- sound -----
  /**
   * Which sound plays while it turns.
   *
   * `tick` is the one people expect from a wheel: a click each time a wedge passes the pointer,
   * which slows down as the wheel does — it cannot go out of step with the picture the way a
   * recording of clicks would, and it has no length to run out of.
   */
  spinSoundKind?: 'none' | 'tick' | 'whoosh' | 'drumroll' | 'custom'
  /** an uploaded loop, used when the kind is `custom` */
  spinSound: string
  winSoundKind?: 'none' | 'fanfare' | 'chime' | 'coin' | 'custom'
  /** one shot when it lands, used when the kind is `custom` */
  winSound: string
  soundVolume: number

  offsetX: number
  offsetY: number
  customCss: string
}

/**
 * Any overlay in the manager. `type` is the discriminant — narrow on it before touching
 * anything that is not on OverlayBase.
 */
export type OverlayConfig =
  | ChatOverlayConfig
  | EmoteRainOverlayConfig
  | GoalOverlayConfig
  | FollowOverlayConfig
  | RouletteOverlayConfig

export const DEFAULT_FILL: OverlayFill = { kind: 'solid', color: '#000000', opacity: 0.45, color2: '#3a0ca3', angle: 135 }

export const DEFAULT_EMOTE_OVERLAY: Omit<EmoteRainOverlayConfig, 'id' | 'name'> = {
  type: 'emotes',
  onChat: true,
  minEmotes: 1,
  onBits: false,
  bitsMin: 100,
  onSubs: false,
  onRedeems: false,
  words: '',
  allowUsers: '',
  perMessage: 3,
  copies: 1,
  burstMax: 12,
  maxOnScreen: 60,
  lifetimeS: 0,
  sizeMin: 48,
  sizeMax: 96,
  opacity: 1,
  shadow: true,
  rainbow: false,
  motion: 'fall',
  from: 'top',
  speedMin: 60,
  speedMax: 160,
  spread: 30,
  gravity: 900,
  bounce: 0.55,
  spin: 90,
  wobble: 24,
  scaleIn: true,
  fadeOut: true
}

export const DEFAULT_FOLLOW_OVERLAY: Omit<FollowOverlayConfig, 'id' | 'name'> = {
  type: 'follow',
  durationS: 5,
  animInMs: 600,
  animOutMs: 500,
  gapMs: 400,
  queueMax: 8,
  animIn: 'slideUp',
  animOut: 'fade',
  customAnimCss: '',
  customAnimInName: '',
  customAnimOutName: '',
  image: '',
  imageWidth: 220,
  mask: '',
  maskShape: 'none',
  maskFeather: 0,
  imageLoop: 'float',
  imageAnchor: 'center',
  imageX: 0,
  imageY: 0,
  imageRotate: 0,
  imageOpacity: 1,
  textAnchor: 'center',
  textX: 0,
  textY: 0,
  avatarShow: true,
  avatarSize: 84,
  avatarRound: true,
  avatarRing: 3,
  avatarRingColor: '#9147ff',
  title: 'Новий фоловер!',
  subtitle: '{user}',
  font: 'Inter',
  titleSize: 30,
  subtitleSize: 40,
  titleColor: '#ffffff',
  subtitleColor: '#ffffff',
  nameColor: '#c7a6ff',
  outlineWidth: 0,
  outlineColor: '#000000',
  shadowBlur: 14,
  shadowColor: '#000000',
  anchor: 'center',
  align: 'center',
  offsetX: 0,
  offsetY: 0,
  layout: 'imageTop',
  gap: 12,
  plate: false,
  plateFill: { kind: 'solid', color: '#18181b', opacity: 0.8, color2: '#3a0ca3', angle: 135 },
  plateMedia: '',
  plateMediaFit: 'cover',
  plateMediaOpacity: 1,
  plateShape: 'rect',
  plateMask: '',
  plateFxFromFill: false,
  plateRadius: 18,
  platePadX: 28,
  platePadY: 20,
  plateBorderWidth: 0,
  plateBorderColor: '#9147ff',
  plateGlowSize: 0,
  plateGlowColor: '#9147ff',
  soundData: '',
  soundVolume: 0.6,
  customCss: ''
}

export const DEFAULT_ROULETTE_OVERLAY: Omit<RouletteOverlayConfig, 'id' | 'name'> = {
  type: 'roulette',
  sections: [
    { id: 'w1', label: 'Приз 1', weight: 1, color: '#9147ff', textColor: '#ffffff', media: '', removeOnWin: false },
    { id: 'w2', label: 'Приз 2', weight: 1, color: '#12b886', textColor: '#ffffff', media: '', removeOnWin: false },
    { id: 'w3', label: 'Приз 3', weight: 1, color: '#ff5c8a', textColor: '#ffffff', media: '', removeOnWin: false },
    { id: 'w4', label: 'Нічого', weight: 2, color: '#3f3f46', textColor: '#ffffff', media: '', removeOnWin: false }
  ],
  trigger: 'manual',
  command: '!рулетка',
  who: 'broadcaster',
  redeemTitle: '',
  cooldownS: 30,
  announce: true,
  announceText: '🎡 Випало: {result}',
  spinS: 6,
  turns: 5,
  easing: 'smooth',
  resultS: 4,
  size: 460,
  rimWidth: 10,
  rimColor: '#ffffff',
  dividerWidth: 2,
  dividerColor: '#00000055',
  font: 'Inter',
  fontSize: 20,
  textRadial: true,
  pointer: 'triangle',
  pointerColor: '#ffffff',
  hubMedia: '',
  hubSize: 90,
  faceMedia: '',
  faceOpacity: 1,
  backdrop: '',
  backdropFit: 'cover',
  backdropOpacity: 1,
  resultShow: true,
  resultSize: 42,
  resultColor: '#ffffff',
  spinSoundKind: 'tick',
  spinSound: '',
  winSoundKind: 'fanfare',
  winSound: '',
  soundVolume: 0.6,
  offsetX: 0,
  offsetY: 0,
  customCss: ''
}

export const DEFAULT_GOAL_OVERLAY: Omit<GoalOverlayConfig, 'id' | 'name'> = {
  type: 'goal',
  metric: 'followers',
  source: 'auto',
  base: 0,
  target: 100,
  progress: 0,
  countGifts: true,
  title: 'Ціль підписників',
  doneText: 'Ціль досягнута!',
  font: 'Inter',
  fontSize: 18,
  textColor: '#ffffff',
  numbers: 'both',
  showTitle: true,
  textInside: false,
  customText: '',
  shape: 'bar',
  width: 420,
  height: 34,
  radius: 17,
  ringWidth: 14,
  trackFill: { kind: 'solid', color: '#000000', opacity: 0.5, color2: '#3a0ca3', angle: 135 },
  barFill: { kind: 'gradient', color: '#9147ff', opacity: 1, color2: '#5cffe0', angle: 90 },
  doneFill: { kind: 'gradient', color: '#12b886', opacity: 1, color2: '#c7f464', angle: 90 },
  borderWidth: 0,
  borderColor: '#ffffff',
  glowSize: 0,
  glowColor: '#9147ff',
  fxFromFill: false,
  animMs: 600,
  pulseOnGain: true,
  gainFx: 'pulse',
  gainLabel: true,
  gainColor: '#ffe066',
  image: '',
  imagePlace: 'left',
  imageSize: 56,
  imageOpacity: 1,
  doneImage: '',
  customCss: ''
}

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
  pageFlip: false,
  pageFlipMs: 650,
  pageFlipDir: 'up',
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
  plateSaturate: 100,
  plateGloss: 0,
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
  nickPaint: true,
  hlFirstMsg: false,
  hlFirstMsgColor: '#7a5cff',
  hlFirstMsgLabel: 'Перше повідомлення',
  hlFirstStream: false,
  hlFirstStreamColor: '#12b886',
  hlFirstStreamLabel: 'Перше за етер',
  hlFirstBorder: true,
  hlFirstGlow: false,
  hlFirstFill: false,
  hlFirstMode: 'border',
  hlFirstSize: 2,
  hlFirstGlowSize: 10,
  hlFirstOpacity: 0.35,
  hlFirstTextColor: '',
  hlFirstLabel: false,
  hlFirstPulse: false,
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
  /**
   * The rest of the paint. A URL paint is an IMAGE, and an image background without its size and
   * repeat draws nothing — with the text already made transparent to show it through, the nick
   * simply vanished. Sending only the background was why 7TV nicks came out black.
   */
  paintSize?: string
  paintRepeat?: string
  paintShadow?: string
  /** this user's very first message in this channel, ever */
  firstMsg?: boolean
  /** their first message of THIS stream */
  firstStream?: boolean
  avatar?: string
  /** badge image urls */
  badges: string[]
  /** badge setIds parallel to `badges` (for kind filtering on the page) */
  badgeSets?: string[]
  /** badge versions parallel to `badges` (per-variant replacement, e.g. predictions) */
  badgeVers?: string[]
  /** message body as safe HTML (emotes/cheers as <img>) */
  body: string
  /**
   * The emote image urls of this message, in the order they were typed.
   *
   * Separate from `body` because the celebration overlay needs the pictures without the sentence
   * around them, and digging them back out of the HTML on the page would mean parsing our own
   * markup to recover something we already had.
   */
  emotes?: string[]
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
  /** how many bits were cheered — goals count them, the celebration gates on them */
  bitsAmount?: number
  /** how many subscriptions this one line represents; a mass-gift header is worth 0, see subsWorth */
  subCount?: number
  /** this sub was a gift, so a goal that only counts self-subs can skip it */
  subGift?: boolean
  /** a follow, for goal overlays; carried on an info line */
  follow?: boolean
  /**
   * A wheel spin: which wedge won, and how long to take getting there.
   *
   * The app decides the winner and sends it, so every browser source pointed at the overlay lands
   * on the same wedge and the result can be announced in chat as the same word the wheel shows.
   */
  wheel?: { index: number; label: string; spinMs: number; turns: number; id: string }
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
/**
 * Built-in sounds. Most are synthesized on the spot (a few oscillator notes, no assets);
 * `dindin` and `chuchu` are real recordings shipped with the app — a train needs a train.
 */
export type SoundPreset =
  | 'ping' | 'pop' | 'bell' | 'chime' | 'blip' | 'knock' | 'coin' | 'chirp' | 'buzz'
  | 'dindin' | 'chuchu'
/** a sound choice: a built-in preset or an uploaded custom sound */
export type SoundChoice = SoundPreset | 'custom'
export const SOUND_PRESETS: SoundPreset[] = [
  'ping', 'pop', 'bell', 'chime', 'blip', 'knock', 'coin', 'chirp', 'buzz', 'dindin', 'chuchu'
]

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

/**
 * Actions that need A MESSAGE to act on, so the toolbar above the chat is not a place they can
 * live: there is no clicked message up there, and a button that can only ever fail is worse
 * than one that is not offered. Settings hides the placement choice for these entirely rather
 * than letting someone build a button that does nothing.
 *
 * `raid` and `announce` are the mirror image — they act on the CHANNEL and belong on the
 * toolbar — but they have always been offered correctly, so they are not listed here.
 */
export const MESSAGE_ONLY_TYPES: ReadonlySet<ModActionType> = new Set([
  'delete', 'timeout', 'ban', 'unban', 'warn', 'shoutout', 'copy', 'resend', 'msgToInput'
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
  /**
   * Whether this pane moves with the scroll-sync group.
   *
   * Sync used to be one switch for the whole tab, which is wrong the moment one of the panes is a
   * channel you are only half watching: you either dragged everything along or gave up pairing
   * the two you actually cared about. It is per pane now, and opt-in — chats scroll on their own
   * until you say otherwise, which is what anyone expects the first time they split the view.
   */
  syncScroll?: boolean
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

/**
 * A user-made theme. Declared here rather than in lib/themes.ts so the settings layer never
 * has to import the theme registry — the registry imports the settings store, and one of the
 * two directions has to stay clean.
 *
 * `tokens` holds only the colours the editor exposes; the derived ones (shadows, scrim,
 * checkerboard, highlight tint) are computed at save time from `dark` and the palette,
 * because getting those wrong is what made the built-in palettes look broken.
 */
export interface CustomTheme {
  id: string
  name: string
  dark: boolean
  tokens: Record<string, string>
  /** corner roundness, percent of the design scale — a theme's shape, not a global setting */
  radius?: number
  /** the tab strip's own palette; omitted fields fall back to the theme's surfaces */
  tabColors?: Partial<TabColors>
}

/** the tab strip's own palette — see the --tab-* custom properties in global.css */
export interface TabColors {
  bg: string
  text: string
  border: string
  hoverBg: string
  activeBg: string
  activeText: string
  activeBorder: string
}

export interface Settings {
  language: 'uk' | 'en'
  /** a theme id — a built-in from lib/themes.ts or one of `customThemes` */
  theme: string
  /** themes the user built or imported; they live alongside the built-ins everywhere */
  customThemes: CustomTheme[]
  /** freeze animated emotes while this window isn't focused — the first frame stays visible */
  pauseEmotesUnfocused: boolean
  /**
   * Interface scale per utility window, keyed by window kind, percent (70..180). Per window
   * on purpose: one shared number meant scaling the usercard also grew the settings window.
   */
  windowScales: Record<string, number>
  fontSize: number // px
  emoteScale: number // 1 = 100%
  showTimestamps: boolean
  timestampSeconds: boolean
  alternatingBackground: boolean
  /** a hairline between messages — the other way to see where one ends and the next begins */
  messageSeparators: boolean
  loadHistory: boolean // recent-messages.robotty.de
  highlightMentions: boolean
  mentionSound: boolean
  /** keep the 2s gap between repeated alert sounds (off = every call-out is heard) */
  alertSoundCooldown: boolean
  /** also play the ping when the mentioned channel is on screen (default: stay quiet) */
  mentionSoundOnActive: boolean
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
  /** append an invisible character so Twitch accepts repeated identical messages */
  bypassDuplicateLimit: boolean
  /** shared chat origin tag: show the avatar only, or the avatar plus the channel name */
  sharedChatTagMode: 'avatar' | 'full'
  /** post a chat line when a 7TV emote is added to / removed from the channel set */
  announceEmoteChanges: boolean
  /** color nicknames typed without a leading "@" too */
  colorBareNicks: boolean
  /** show 7TV / BetterTTV badges next to the Twitch ones */
  showThirdPartyBadges: boolean
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
  /** error messages the user chose never to see again (see Toast.muteKey) */
  mutedErrors: string[]
  /** spellings of YOUR nick that Twitch's @-mention never catches ("стікмен", "stiki"…).
   *  Functionally the same match as a keyword, but with its own sound so a personal call-out
   *  is audibly different from a topic word. */
  nickAlerts: string[]
  /**
   * Match a nick spelling as a WHOLE word rather than anywhere inside another one.
   * Off, "стікмен" also fires on "стікменсва"; on, only on the word itself. Kept as a
   * switch and not a rule because both readings are legitimate: a short handle needs the
   * strict one, while a stem you want to catch in any inflection needs the loose one.
   */
  nickAlertWholeWord: boolean
  nickAlertSound: boolean
  nickAlertSoundOnActive: boolean
  nickAlertSoundType: SoundChoice
  nickAlertSoundVolume: number
  nickAlertSoundCustomId?: string
  keywordSound: boolean
  /** whole-word matching for the keyword list — see [nickAlertWholeWord] */
  keywordWholeWord: boolean
  keywordSoundOnActive: boolean
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
  /** also show a toast for an incoming whisper — a sound alone is missed with the app in back */
  whisperNotify: boolean
  /** sound when a raid prompt appears */
  raidSound: boolean
  raidSoundType: SoundChoice
  raidSoundVolume: number
  raidSoundCustomId?: string
  /** announce hype trains with an info line in the channel's chat */
  hypeTrainLine: boolean
  /** the floating train popup with the live level and countdown */
  hypeTrainPopup: boolean
  /** sounds for the train — departure and every level after it get their own */
  hypeTrainSound: boolean
  /**
   * Which train flavours may chime for a channel whose tab is NOT in front.
   *
   * Per flavour rather than one switch: a regular train runs somewhere most of the day and is
   * not worth interrupting for, while a golden one is rare enough that missing it is the whole
   * complaint. Empty = only the channel you are looking at ever makes a sound.
   */
  hypeTrainInactiveKinds: ('regular' | 'shared' | 'golden' | 'community')[]
  hypeTrainStartSoundType: SoundChoice
  hypeTrainStartSoundVolume: number
  hypeTrainStartSoundCustomId?: string
  hypeTrainLevelSoundType: SoundChoice
  hypeTrainLevelSoundVolume: number
  hypeTrainLevelSoundCustomId?: string
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
  /** show link preview cards already expanded (default: collapsed behind an arrow chip) */
  linkPreviewsExpanded: boolean
  /** blow the artwork up next to the cursor when hovering a link preview */
  linkHoverPreview: boolean
  /** hover preview only for real pictures/GIFs — skip video thumbnails (clips, YouTube…) */
  linkHoverImagesOnly: boolean
  /** width of that hover preview, px */
  linkHoverSize: number
  /** preview card scale, % (100 = normal) */
  linkPreviewScale: number
  /** account picker next to the input: full name select or a compact avatar button */
  inputAccountDisplay: 'name' | 'avatar'
  /** Chatterino-style: every new message glides the chat instead of jumping */
  smoothChatScroll: boolean
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
  /** zoom of the whispers panel — Ctrl+wheel over it, 1 = default */
  whisperScale: number
  /** width of the whispers popover in px (drag its left edge) */
  whisperWidth: number
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
  /**
   * Write a line in chat when somebody follows.
   *
   * Off by default, and separate from the events panel on purpose: the panel keeps every follow
   * either way, while a busy channel may not want its chat interrupted by them.
   */
  announceFollows: boolean
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
  /** every OBS overlay, of every kind; the name predates there being more than one kind */
  chatOverlays: OverlayConfig[]
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
  customThemes: [],
  pauseEmotesUnfocused: false,
  windowScales: {},
  fontSize: 13,
  emoteScale: 1,
  showTimestamps: true,
  timestampSeconds: false,
  alternatingBackground: false,
  messageSeparators: false,
  loadHistory: true,
  highlightMentions: true,
  mentionSound: true,
  alertSoundCooldown: false,
  mentionSoundOnActive: false,
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
  bypassDuplicateLimit: true,
  sharedChatTagMode: 'full',
  announceEmoteChanges: true,
  colorBareNicks: true,
  showThirdPartyBadges: true,
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
  mutedErrors: [],
  nickAlerts: [],
  // off by default: turning it on for everyone would silently stop firing alerts people
  // already rely on, and a stem entered on purpose ("стікмен" to catch every inflection) is
  // a legitimate way to use the list
  nickAlertWholeWord: false,
  nickAlertSound: true,
  nickAlertSoundOnActive: true,
  nickAlertSoundType: 'ping',
  nickAlertSoundVolume: 0.5,
  keywordSound: true,
  keywordWholeWord: false,
  keywordSoundOnActive: true,
  keywordSoundType: 'ping',
  keywordSoundVolume: 0.5,
  streamUpSound: false,
  streamUpSoundType: 'bell',
  streamUpSoundVolume: 0.5,
  streamUpNotify: true,
  whisperSound: true,
  whisperSoundType: 'pop',
  whisperSoundVolume: 0.5,
  whisperNotify: true,
  raidSound: true,
  raidSoundType: 'bell',
  raidSoundVolume: 0.5,
  hypeTrainLine: true,
  hypeTrainPopup: true,
  hypeTrainSound: true,
  hypeTrainInactiveKinds: ['golden', 'community'],
  hypeTrainStartSoundType: 'dindin',
  hypeTrainStartSoundVolume: 0.5,
  hypeTrainLevelSoundType: 'chuchu',
  hypeTrainLevelSoundVolume: 0.5,
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
  linkPreviewsExpanded: true,
  linkHoverPreview: true,
  linkHoverImagesOnly: false,
  linkHoverSize: 560,
  linkPreviewScale: 100,
  inputAccountDisplay: 'name',
  smoothChatScroll: false,
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
  whisperScale: 1,
  whisperWidth: 320,
  highlightsAsWindow: false,
  highlightsPinned: false,
  highlightsFontSize: 12,
  raidPrompt: true,
  raidPromptActiveOnly: false,
  raiderHighlightMinutes: 10,
  raidPromptDest: 'split',
  showBits: true,
  showRedeems: true,
  announceFollows: false,
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
