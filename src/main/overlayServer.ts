import { createServer, Server, ServerResponse } from 'http'

/**
 * Local chat-overlay server for OBS Browser Source (overlay editor v2).
 *
 * GET /overlay?channel=x&profile=id[&preview=1] → transparent, self-contained overlay page
 * GET /events?channel=x&profile=id              → SSE: `cfg` (that overlay's full config) + lines
 *
 * The renderer pushes STRUCTURED lines (nick, color, badges, avatar, body html…) and the
 * overlayId→config map over IPC. The page assembles the DOM itself from its config, so a
 * config change restyles/re-lays-out everything live — including already visible messages.
 * `preview=1` additionally makes the page generate demo messages locally (used by the
 * in-app editor's live preview iframe). Listens on 127.0.0.1 only.
 */

/** full ChatOverlayConfig (renderer type) + fontData — main is just a conduit */
export type OverlayStyle = Record<string, unknown>

/** structured chat line (renderer's OverlayLineData) — main only reads id/user/login */
export interface OverlayLine {
  id: string
  user: string
  login: string
  [k: string]: unknown
}

export interface OverlayDelete {
  id?: string
  user?: string
  all?: boolean
}

interface SseClient {
  channel: string
  profile: string
  res: ServerResponse
}

let server: Server | null = null
let currentPort = 0
let styles: Record<string, OverlayStyle> = {}
const clients = new Set<SseClient>()
/** channel -> last lines, replayed to a client on connect */
const backlog = new Map<string, OverlayLine[]>()
const BACKLOG_LIMIT = 30

function styleFor(profile: string): OverlayStyle | undefined {
  return styles[profile] ?? Object.values(styles)[0]
}

export function overlayPush(channel: string, line: OverlayLine): void {
  const list = backlog.get(channel) ?? []
  list.push(line)
  if (list.length > BACKLOG_LIMIT) list.shift()
  backlog.set(channel, list)
  const payload = `data: ${JSON.stringify(line)}\n\n`
  for (const c of clients) {
    if (c.channel !== channel) continue
    try {
      c.res.write(payload)
    } catch {
      clients.delete(c)
    }
  }
}

/** a message was deleted / a user was timed out — pull the lines off the overlay too */
export function overlayDelete(channel: string, del: OverlayDelete): void {
  const list = backlog.get(channel) ?? []
  backlog.set(
    channel,
    del.all ? [] : list.filter((l) => !(del.id && l.id === del.id) && !(del.user && l.user === del.user))
  )
  const payload = `event: del\ndata: ${JSON.stringify(del)}\n\n`
  for (const c of clients) {
    if (c.channel !== channel) continue
    try {
      c.res.write(payload)
    } catch {
      clients.delete(c)
    }
  }
}

function broadcastStyles(): void {
  for (const c of clients) {
    const style = styleFor(c.profile)
    if (!style) continue
    try {
      c.res.write(`event: cfg\ndata: ${JSON.stringify(style)}\n\n`)
    } catch {
      clients.delete(c)
    }
  }
}

let lastEnabled = false
let lastPort = 4715

export function overlayConfigure(enabled: boolean, port: number, newStyles?: Record<string, OverlayStyle>): void {
  lastEnabled = enabled
  lastPort = port
  if (newStyles) {
    styles = newStyles
    broadcastStyles()
  }
  if (!enabled || port !== currentPort) {
    if (server) {
      for (const c of clients) {
        try {
          c.res.end()
        } catch {
          /* noop */
        }
      }
      clients.clear()
      server.close()
      server = null
      currentPort = 0
    }
  }
  if (!enabled || server) return
  currentPort = port
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname === '/overlay') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(OVERLAY_HTML)
      return
    }
    if (url.pathname === '/events') {
      const channel = (url.searchParams.get('channel') ?? '').toLowerCase()
      const profile = url.searchParams.get('profile') ?? ''
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      })
      res.write(':ok\n\n')
      // this overlay's config first, then the backlog so the page isn't empty on connect
      const style = styleFor(profile)
      if (style) res.write(`event: cfg\ndata: ${JSON.stringify(style)}\n\n`)
      for (const line of backlog.get(channel) ?? []) {
        res.write(`data: ${JSON.stringify(line)}\n\n`)
      }
      const client: SseClient = { channel, profile, res }
      clients.add(client)
      req.on('close', () => clients.delete(client))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  server.on('error', () => {
    server = null
    currentPort = 0
  })
  server.listen(port, '127.0.0.1')
}

/** Force a full teardown + fresh start with the last config — the manual "reload server"
 *  escape hatch for when OBS shows nothing (e.g. the port was momentarily busy at startup). */
export function overlayRestart(): void {
  for (const c of clients) {
    try {
      c.res.end()
    } catch {
      /* noop */
    }
  }
  clients.clear()
  if (server) {
    try {
      server.close()
    } catch {
      /* noop */
    }
  }
  server = null
  currentPort = 0
  overlayConfigure(lastEnabled, lastPort, styles)
}

/** Self-contained overlay page; ALL styling + layout arrives live via the `cfg` SSE event. */
const OVERLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>StickiChat Overlay</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; height: 100%; }
  #zone {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: stretch;
    box-sizing: border-box;
    max-height: 100%;
  }
  /* horizontal bar: one row along an edge */
  #zone.layout-horizontal {
    flex-direction: row;
    align-items: flex-end;
    max-width: 100%;
    overflow: hidden;
    flex-wrap: nowrap;
    white-space: normal;
  }
  #zone.layout-horizontal.anchor-top { top: 0; bottom: auto; align-items: flex-start; }
  .line { display: flex; align-items: flex-start; box-sizing: border-box; position: relative; }
  .line.av-right { flex-direction: row-reverse; }
  .line .avatar { flex: 0 0 auto; object-fit: cover; margin: 2px 6px 0 0; }
  .line.av-right .avatar { margin: 2px 0 0 6px; }
  .content { min-width: 0; box-sizing: border-box; position: relative; line-height: 1.45; overflow-wrap: anywhere; }
  .cwrap { position: relative; min-width: 0; box-sizing: border-box; }
  .cwrap > .content { width: 100% !important; }
  /* shaped plates: the visual (bg/border/glow) lives on a separate layer so the TEXT is
     never clipped; slant = skewed layer, notch = clipped layer with drop-shadow outline */
  .content.shaped { isolation: isolate; background: transparent !important; border: none !important; clip-path: none !important; box-shadow: none !important; }
  .plate-bg { position: absolute; inset: 0; z-index: -1; pointer-events: none; }
  /* horizontal bar: messages stretch in WIDTH, never grow in height */
  #zone.layout-horizontal .line { flex: 0 0 auto; max-width: none; }
  #zone.layout-horizontal .content { white-space: nowrap; }
  #zone.layout-horizontal .body { white-space: nowrap; }
  .meta { display: flex; align-items: center; gap: 4px; }
  /* INLINE nick: align by TEXT baseline; badges/time center themselves so a tall badge
     doesn't push the nick above the message text */
  .body .meta { align-items: baseline; }
  .body .meta .badges, .body .meta .ts { align-self: center; }
  .meta.chip { display: inline-flex; }
  .badges { display: inline-flex; align-items: center; gap: 2px; vertical-align: -0.15em; }
  .badges img { display: inline-block; border-radius: 2px; }
  .nick { font-weight: 700; }
  .ts { opacity: 0.85; font-size: 0.8em; }
  .sysline { font-style: italic; opacity: 0.9; }
  .body img.emote { height: var(--emote-h, 1.4em); vertical-align: -0.3em; margin: 0 1px; }
  .body img.emoji-img { height: 1.25em; width: 1.25em; object-fit: contain; vertical-align: -0.25em; margin: 0 1px; }
  .decor { position: absolute; pointer-events: none; }
  /* custom plate image as its own layer (opacity independent of text) */
  .content.has-img, #zone.has-img, .meta.has-img { isolation: isolate; }
  .content.has-img::before, #zone.has-img::before, .meta.has-img::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image: var(--bg-img);
    background-size: var(--bg-img-size, cover);
    background-position: center;
    background-repeat: no-repeat;
    opacity: var(--bg-img-op, 1);
    border-radius: inherit;
    z-index: -1;
    pointer-events: none;
  }
  /* entrance animations — direction comes from --ax/--ay custom props set per line */
  @keyframes a-fade { from { opacity: 0; } }
  @keyframes a-slide { from { opacity: 0; transform: translate(var(--ax, 0px), var(--ay, 24px)); } }
  @keyframes a-pop { from { opacity: 0; transform: scale(0.55); } }
  @keyframes a-zoom { from { opacity: 0; transform: scale(1.45); } }
  @keyframes a-blur { from { opacity: 0; filter: blur(10px); } }
  @keyframes a-flip { from { opacity: 0; transform: perspective(500px) rotate3d(var(--fy, 0), var(--fx, 1), 0, 85deg); } }
  @keyframes a-bounce {
    0% { opacity: 0; transform: translate(var(--ax, 0px), var(--ay, 24px)) scale(0.4); }
    60% { opacity: 1; transform: translate(0, 0) scale(1.08); }
    80% { transform: scale(0.96); }
    100% { transform: scale(1); }
  }
  @keyframes a-elastic {
    0% { opacity: 0; transform: translate(calc(var(--ax, 0px) * 2), calc(var(--ay, 24px) * 2)); }
    55% { opacity: 1; transform: translate(calc(var(--ax, 0px) * -0.15), calc(var(--ay, 24px) * -0.15)); }
    75% { transform: translate(calc(var(--ax, 0px) * 0.07), calc(var(--ay, 24px) * 0.07)); }
    100% { transform: translate(0, 0); }
  }
  @keyframes a-swing {
    0% { opacity: 0; transform: rotate(-28deg); }
    60% { opacity: 1; transform: rotate(8deg); }
    80% { transform: rotate(-4deg); }
    100% { transform: rotate(0deg); }
  }
  @keyframes a-drop {
    0% { opacity: 0; transform: translateY(-90px); }
    55% { opacity: 1; transform: translateY(0) scale(1, 1); }
    72% { transform: translateY(0) scale(1.06, 0.8); }
    100% { transform: translateY(0) scale(1, 1); }
  }
  @keyframes a-roll {
    from { opacity: 0; transform: translate(calc(var(--ax, 0px) * 2.2), calc(var(--ay, 24px) * 2.2)) rotate(-200deg) scale(0.55); }
  }
  @keyframes a-spin {
    from { opacity: 0; transform: rotate(540deg) scale(0.05); }
  }
  @keyframes a-stretch {
    0% { opacity: 0; transform: scaleX(0.08); }
    70% { opacity: 1; transform: scaleX(1.06); }
    100% { transform: scaleX(1); }
  }
  @keyframes a-glitch {
    0% { opacity: 0; transform: translate(-8px, 4px) skewX(12deg); filter: hue-rotate(120deg); }
    20% { opacity: 1; transform: translate(5px, -3px) skewX(-8deg); }
    40% { transform: translate(-4px, 2px) skewX(5deg); filter: hue-rotate(-90deg); }
    60% { transform: translate(3px, -1px) skewX(-3deg); filter: none; }
    80% { transform: translate(-1px, 1px); }
    100% { transform: none; }
  }
  @keyframes a-flash {
    0% { opacity: 0; filter: brightness(5) blur(7px); }
    35% { opacity: 1; filter: brightness(2.2) blur(2px); }
    100% { filter: none; }
  }
  @keyframes a-rise { 0% { opacity: 0; transform: translate(var(--ax, 0px), var(--ay, 20px)) scale(0.96); } 100% { opacity: 1; transform: none; } }
  @keyframes a-slam {
    0% { opacity: 0; transform: scale(2.3); }
    60% { opacity: 1; transform: scale(0.9); }
    80% { transform: scale(1.05); }
    100% { transform: scale(1); }
  }
  @keyframes a-rubber {
    0% { opacity: 0; transform: scale(0.5); }
    40% { opacity: 1; transform: scale3d(1.28, 0.72, 1); }
    55% { transform: scale3d(0.82, 1.18, 1); }
    70% { transform: scale3d(1.1, 0.9, 1); }
    85% { transform: scale3d(0.97, 1.03, 1); }
    100% { transform: scale3d(1, 1, 1); }
  }
  @keyframes a-wobble {
    0% { opacity: 0; transform: translate(var(--ax, -30px), var(--ay, 0px)); }
    30% { opacity: 1; transform: translateX(12px) rotate(4deg); }
    50% { transform: translateX(-9px) rotate(-3deg); }
    70% { transform: translateX(5px) rotate(2deg); }
    100% { transform: none; }
  }
  @keyframes a-fold { 0% { opacity: 0; transform: perspective(600px) rotateX(-92deg); } 100% { opacity: 1; transform: perspective(600px) rotateX(0deg); } }
  @keyframes a-skew {
    0% { opacity: 0; transform: skewX(-28deg) translate(var(--ax, -40px), var(--ay, 0px)); }
    60% { opacity: 1; transform: skewX(9deg); }
    100% { transform: none; }
  }
  @keyframes a-neon {
    0% { opacity: 0; filter: brightness(0.35); }
    20% { opacity: 1; filter: brightness(2.6) drop-shadow(0 0 9px rgba(255,255,255,0.95)); }
    35% { filter: brightness(0.85); }
    55% { filter: brightness(2.1) drop-shadow(0 0 6px rgba(255,255,255,0.85)); }
    75% { filter: brightness(1); }
    100% { filter: none; }
  }
  @keyframes a-tilt { 0% { opacity: 0; transform: perspective(600px) rotateY(48deg) rotateX(-26deg); } 100% { opacity: 1; transform: perspective(600px) rotateY(0deg) rotateX(0deg); } }
  @keyframes a-typewriter {
    0% { opacity: 0; clip-path: inset(0 100% 0 0); }
    2% { opacity: 1; }
    100% { opacity: 1; clip-path: inset(0 0 0 0); }
  }
  @keyframes a-hinge {
    0% { opacity: 0; transform: rotate(-82deg) translateY(-28px); }
    55% { opacity: 1; transform: rotate(12deg); }
    75% { transform: rotate(-5deg); }
    100% { transform: rotate(0deg); }
  }
  /* exit animations (keyframe-based so direction vars apply) */
  .line.out { pointer-events: none; }
  @keyframes o-fade { to { opacity: 0; } }
  @keyframes o-shrink { to { opacity: 0; transform: scale(0.55); } }
  @keyframes o-slide { to { opacity: 0; transform: translate(calc(var(--ax, -40px) * 3), calc(var(--ay, 0px) * 3)); } }
  @keyframes o-zoom { to { opacity: 0; transform: scale(1.6); } }
  @keyframes o-blur { to { opacity: 0; filter: blur(14px); } }
  @keyframes o-flip { to { opacity: 0; transform: perspective(500px) rotate3d(var(--fy, 0), var(--fx, 1), 0, 85deg); } }
  @keyframes o-spin { to { opacity: 0; transform: rotate(320deg) scale(0.1); } }
  @keyframes o-drop { to { opacity: 0; transform: translateY(90px) rotate(12deg); } }
  @keyframes o-roll { to { opacity: 0; transform: translate(calc(var(--ax, -40px) * 2.5), calc(var(--ay, 0px) * 2.5)) rotate(200deg) scale(0.4); } }
  @keyframes o-rise { to { opacity: 0; transform: translate(calc(var(--ax, 0px) * 1.5), calc(var(--ay, -30px) * 1.5)) scale(0.9); } }
  @keyframes o-slam {
    0% { transform: scale(1); }
    25% { opacity: 1; transform: scale(1.2); }
    100% { opacity: 0; transform: scale(0.12); }
  }
  @keyframes o-wobble {
    0% { transform: none; }
    20% { transform: translateX(10px) rotate(3deg); }
    40% { transform: translateX(-13px) rotate(-4deg); }
    60% { opacity: 1; transform: translateX(15px) rotate(4deg); }
    100% { opacity: 0; transform: translate(calc(var(--ax, -40px) * 2), calc(var(--ay, 0px) * 2)); }
  }
  @keyframes o-fold { to { opacity: 0; transform: perspective(600px) rotateX(92deg); } }
  @keyframes o-skew { to { opacity: 0; transform: skewX(30deg) translate(calc(var(--ax, -40px) * 1.6), calc(var(--ay, 0px) * 1.6)); } }
  @keyframes o-tilt { to { opacity: 0; transform: perspective(600px) rotateY(55deg) rotateX(18deg); } }
  @keyframes o-hinge {
    0% { transform: rotate(0deg); }
    40% { opacity: 1; transform: rotate(14deg); }
    100% { opacity: 0; transform: rotate(72deg) translateY(70px); }
  }
  @keyframes o-glitch {
    0% { transform: none; }
    25% { transform: translate(6px, -3px) skewX(-8deg); filter: hue-rotate(90deg); }
    50% { transform: translate(-6px, 2px) skewX(6deg); }
    75% { opacity: 1; transform: translate(4px, -2px); filter: hue-rotate(-120deg); }
    100% { opacity: 0; transform: translate(-11px, 4px) skewX(11deg); filter: none; }
  }
  /* word/symbol trigger reactions: images/GIFs popping up around the chat */
  #fx { position: fixed; inset: 0; pointer-events: none; z-index: 50; }
  .tgi { position: absolute; }
  .tgi img { width: 100%; display: block; }
  /* TRUE credits mode: absolutely-positioned lines flying upward at constant speed */
  @keyframes credits-fly {
    from { transform: translateY(var(--cstart, 0px)); }
    to { transform: translateY(var(--cend, -1200px)); }
  }
  .line.credits { position: absolute; left: 0; right: 0; bottom: 0; }
  /* page-flip: the filled page turns away (direction set per-config), then a blank sheet */
  .page-flip { display: flex; flex-direction: column; width: 100%; backface-visibility: hidden; }
  /* single-message visual editor */
  body.edit { cursor: grab; }
  body.edit .meta, body.edit .avatar, body.edit .badges, body.edit .ts, body.edit .body, body.edit .cwrap { cursor: move; }
  body.edit .meta:hover, body.edit .avatar:hover, body.edit .badges:hover, body.edit .ts:hover, body.edit .body:hover {
    outline: 1px dashed rgba(255, 255, 255, 0.65);
    outline-offset: 2px;
  }
  @keyframes tg-pop { 0% { opacity: 0; transform: scale(0.2); } 70% { transform: scale(1.12); } 100% { opacity: 1; transform: scale(1); } }
  @keyframes tg-bounce {
    0% { opacity: 0; transform: translateY(40px) scale(0.6); }
    55% { opacity: 1; transform: translateY(-12px) scale(1.05); }
    80% { transform: translateY(4px) scale(0.98); }
    100% { transform: none; }
  }
  @keyframes tg-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes tg-slide { from { opacity: 0; transform: translateX(var(--tx, 60px)); } to { opacity: 1; } }
  @keyframes tg-wiggle-in { 0% { opacity: 0; transform: rotate(-14deg) scale(0.4); } 100% { opacity: 1; } }
  @keyframes tg-bob { 0%, 100% { transform: translateY(0) rotate(-3deg); } 50% { transform: translateY(-7px) rotate(3deg); } }
  .tgi.leaving { transition: opacity 0.4s ease, transform 0.4s ease; opacity: 0 !important; transform: scale(0.7); }
</style>
<style id="customCss"></style>
<style id="fontFace"></style>
<style id="fxCss"></style>
</head>
<body>
<div id="zone"></div>
<div id="fx"></div>
<script>
(function () {
  'use strict'
  var p = new URLSearchParams(location.search)
  var channel = (p.get('channel') || '').toLowerCase()
  var profile = p.get('profile') || ''
  var preview = p.get('preview') === '1'
  var editMode = p.get('edit') === '1'
  var zone = document.getElementById('zone')
  var customCss = document.getElementById('customCss')
  var fontFace = document.getElementById('fontFace')
  var fxCss = document.getElementById('fxCss')

  // defaults until the first cfg event lands (mirrors DEFAULT_CHAT_OVERLAY)
  var cfg = {
    layout: 'list', direction: 'up', align: 'left', anchor: 'bottom',
    maxMessages: 15, fadeAfter: 0, lineGap: 4, zonePad: 8, edgeFade: 0,
    animIn: 'slide', animDir: 'down', animOut: 'fade', animOutDir: 'left', animMs: 200, animInMs: 300, animOutMs: 300,
    meStyle: 'colored',
    creditsMode: false, creditsSpeed: 40, creditsHeight: 0, creditsRush: false, pageFlip: false, pageFlipMs: 650, pageFlipDir: 'up',
    badgeKinds: [], userBadges: [], badgeReplace: {},
    nickRotate: 0, avatarOffsetX: 0, avatarOffsetY: 0, badgeOffsetX: 0, badgeOffsetY: 0,
    tsOffsetX: 0, tsOffsetY: 0, textOffsetX: 0, textOffsetY: 0,
    msgSoundEnabled: false, msgSoundData: '', msgSoundVolume: 0.5,
    tiltX: 0, tiltY: 0, rotate: 0, perspDepth: 800,
    font: '', fontData: '', fontSize: 16, bold: false, italic: false, textTransform: 'none',
    textColor: '#ffffff',
    outlineWidth: 2, outlineColor: '#000000', shadowBlur: 0, shadowColor: '#000000',
    glowSize: 0, glowColor: '#a970ff', emoteScale: 1.4,
    plateMode: 'none',
    plateBg: { kind: 'solid', color: '#000000', opacity: 0.45, color2: '#3a0ca3', angle: 135 },
    plateRadius: [8, 8, 8, 8], plateShape: 'rect',
    plateBorderWidth: 0, plateBorderColor: '#ffffff', plateBorderStyle: 'solid',
    plateBorderOpacity: 1, plateBorderBlur: 0,
    plateShadowBlur: 0, plateShadowColor: '#000000', plateShadowX: 0, plateShadowY: 2,
    plateGlowSize: 0, plateGlowColor: '#a970ff', plateBlur: 0, plateEdgeBlur: 0,
    plateShapeSize: 12, plateDepth: 0,
    plateAnim: 'none', plateAnimSpeed: 2, plateAnimColors: ['#9147ff', '#5cffe0', '#ff5c8a'], plateAnimSync: true,
    plateImage: '', plateImageOpacity: 1, plateImageFit: 'cover', plateMask: '',
    plateWidth: 0, plateHeight: 0, platePadX: 10, platePadY: 4,
    nickPos: 'inline', nickColorMode: 'twitch', nickFixedColor: '#a970ff',
    nickPalette: ['#ff5c8a', '#5cb2ff', '#7cff5c', '#ffd75c', '#c95cff', '#5cffe0'],
    nickBold: true, nickItalic: false, nickScale: 100, nickTransform: 'none',
    nickBgEnabled: false,
    nickBg: { kind: 'solid', color: '#9147ff', opacity: 1, color2: '#3a0ca3', angle: 135 },
    nickBgRadius: 8, nickPadX: 8, nickPadY: 1, nickOffsetX: 0, nickOffsetY: 0,
    nickFloat: false, nickAlign: 'left', msgAlign: 'left',
    zoneOffsetX: 0, zoneOffsetY: 0,
    nickBorderWidth: 0, nickBorderColor: '#ffffff', nickShadowBlur: 0, nickShadowColor: '#000000',
    nickGlowSize: 0, nickGlowColor: '#a970ff', nickBlur: 0, nickImage: '', nickImageOpacity: 1,
    avatarShow: false, avatarPos: 'left', avatarSize: 28, avatarRadius: 50,
    badgesShow: true, badgesPos: 'before', badgeSize: 18,
    tsShow: false, tsSeconds: false, tsColor: '#b8b8c0', tsPos: 'after',
    decors: [], triggers: [], hiddenUsers: [],
    hideCommands: false, showRedeems: true, showBits: true, showSubs: true, showModActions: false,
    customCss: ''
  }

  var lines = [] // structured line data currently on screen (newest last)

  // ---------- helpers ----------
  function hexToRgba(hex, op) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
    if (!m) return 'rgba(0,0,0,' + (op == null ? 1 : op) + ')'
    var n = parseInt(m[1], 16)
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (op == null ? 1 : op) + ')'
  }
  function fill(f) {
    if (!f) return ''
    if (f.opacity <= 0) return ''
    if (f.kind === 'gradient') {
      // multi-stop gradients (color + 0..100 position); falls back to the 2-color pair
      var stops
      if (f.stops && f.stops.length >= 2) {
        stops = f.stops
          .slice()
          .sort(function (a, b) { return a.at - b.at })
          .map(function (s) { return hexToRgba(s.color, f.opacity) + ' ' + s.at + '%' })
      } else {
        stops = [hexToRgba(f.color, f.opacity), hexToRgba(f.color2, f.opacity)]
      }
      return 'linear-gradient(' + (f.angle || 0) + 'deg, ' + stops.join(', ') + ')'
    }
    return hexToRgba(f.color, f.opacity)
  }
  // direction → offset vector (used by both entrance and exit animations)
  function animVars(el, dir) {
    var d = dir || cfg.animDir || 'down'
    var ax = d === 'left' ? '-40px' : d === 'right' ? '40px' : '0px'
    var ay = d === 'up' ? '-24px' : d === 'down' ? '24px' : '0px'
    el.style.setProperty('--ax', ax)
    el.style.setProperty('--ay', ay)
    el.style.setProperty('--fx', d === 'up' || d === 'down' ? '1' : '0')
    el.style.setProperty('--fy', d === 'left' || d === 'right' ? '1' : '0')
  }
  // legacy animIn values (pre-direction) → new name + direction
  function animName() {
    var a = cfg.animIn
    if (a === 'slide-left') return 'slide'
    if (a === 'slide-right') return 'slide'
    if (a === 'slide-up') return 'slide'
    return a
  }
  function textShadow() {
    var parts = []
    var w = cfg.outlineWidth
    if (w > 0) {
      for (var x = -w; x <= w; x++)
        for (var y = -w; y <= w; y++)
          if (x || y) parts.push(x + 'px ' + y + 'px 0 ' + cfg.outlineColor)
    }
    if (cfg.shadowBlur > 0) parts.push('0 2px ' + cfg.shadowBlur + 'px ' + cfg.shadowColor)
    if (cfg.glowSize > 0) {
      parts.push('0 0 ' + cfg.glowSize + 'px ' + cfg.glowColor)
      parts.push('0 0 ' + cfg.glowSize * 2 + 'px ' + cfg.glowColor)
    }
    return parts.length ? parts.join(', ') : 'none'
  }
  function nickColorFor(d) {
    if (cfg.nickColorMode === 'fixed') return cfg.nickFixedColor
    if (cfg.nickColorMode === 'palette' && cfg.nickPalette && cfg.nickPalette.length) {
      var h = 0
      for (var i = 0; i < d.login.length; i++) h = (h * 31 + d.login.charCodeAt(i)) >>> 0
      return cfg.nickPalette[h % cfg.nickPalette.length]
    }
    return d.color || '#ffffff'
  }
  function isHidden(login) {
    return login && (cfg.hiddenUsers || []).indexOf(String(login).toLowerCase()) !== -1
  }
  function passesFilters(d) {
    if (isHidden(d.login)) return false
    if (d.kind === 'info') {
      if (d.mod && !cfg.showModActions) return false
      if (d.redeem && !cfg.showRedeems) return false
      return true
    }
    if (d.cmd && cfg.hideCommands) return false
    if (d.redeem && !cfg.showRedeems) return false
    if (d.bits && !cfg.showBits) return false
    if (d.sub && !cfg.showSubs) return false
    return true
  }
  function fmtTs(ts) {
    var dt = new Date(ts || Date.now())
    function pad(n) { return (n < 10 ? '0' : '') + n }
    var s = pad(dt.getHours()) + ':' + pad(dt.getMinutes())
    if (cfg.tsSeconds) s += ':' + pad(dt.getSeconds())
    return s
  }
  function shapeClip(shape) {
    var s = (cfg.plateShapeSize == null ? 12 : cfg.plateShapeSize) + 'px'
    if (shape === 'slant') return 'polygon(' + s + ' 0, 100% 0, calc(100% - ' + s + ') 100%, 0 100%)'
    if (shape === 'notch')
      return 'polygon(' + s + ' 0, calc(100% - ' + s + ') 0, 100% ' + s + ', 100% calc(100% - ' + s + '), calc(100% - ' + s + ') 100%, ' + s + ' 100%, 0 calc(100% - ' + s + '), 0 ' + s + ')'
    return ''
  }
  /** darken a #rrggbb color by the given factor (0..1) — used for the 3D extrude faces */
  function shade(hex, k) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
    if (!m) return 'rgba(0,0,0,0.5)'
    var n = parseInt(m[1], 16)
    var r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k)
    return 'rgb(' + r + ',' + g + ',' + b + ')'
  }

  // ---------- animated border/glow keyframes ----------
  function buildFxKeyframes() {
    if (!cfg.plateAnim || cfg.plateAnim === 'none') return ''
    var colors = (cfg.plateAnimColors && cfg.plateAnimColors.length ? cfg.plateAnimColors : ['#9147ff']).slice()
    var g = cfg.plateGlowSize > 0 ? cfg.plateGlowSize : 12
    var bw = cfg.plateBorderWidth > 0 ? cfg.plateBorderWidth : 0
    var sync = cfg.plateAnimSync !== false
    function frame(color, alpha) {
      var out = ''
      if (bw > 0) out += 'border-color: ' + hexToRgba(color, (cfg.plateBorderOpacity == null ? 1 : cfg.plateBorderOpacity) * alpha) + ';'
      if (sync) {
        out += 'box-shadow: 0 0 ' + Math.round(g * alpha) + 'px ' + color + ', 0 0 ' + Math.round(g * 2 * alpha) + 'px ' + color + ';'
      }
      return out
    }
    var kf = '@keyframes pa-fx {'
    if (cfg.plateAnim === 'candle') {
      // flicker: irregular intensity of the first color, like a candle flame
      var flicker = [1, 0.75, 0.95, 0.6, 1, 0.8, 0.55, 0.9, 0.7, 1]
      for (var i = 0; i < flicker.length; i++) {
        kf += Math.round((i / (flicker.length - 1)) * 100) + '% {' + frame(colors[0], flicker[i]) + '}'
      }
    } else {
      // blink (hard steps) and flow (smooth) both cycle through the color list; the
      // timing function chosen in applyPlate makes the difference
      colors.push(colors[0]) // wrap around for a seamless loop
      for (var j = 0; j < colors.length; j++) {
        kf += Math.round((j / (colors.length - 1)) * 100) + '% {' + frame(colors[j], 1) + '}'
      }
    }
    return kf + '}'
  }

  // ---------- shaped plate layer ----------
  // slant/notch move ALL plate visuals onto a separate layer: the text is never clipped,
  // the border/glow follow the shape (slant = real skewed border; notch = drop-shadow
  // outline that hugs the clip path)
  function applyShapedLayer(el) {
    var layer = el.querySelector(':scope > .plate-bg')
    if (!layer) {
      layer = document.createElement('div')
      layer.className = 'plate-bg'
      el.insertBefore(layer, el.firstChild)
    }
    el.classList.add('shaped')
    var s = cfg.plateShapeSize == null ? 12 : cfg.plateShapeSize
    var bcol = hexToRgba(cfg.plateBorderColor, cfg.plateBorderOpacity == null ? 1 : cfg.plateBorderOpacity)
    // fill + optional custom image stacked as multiple backgrounds
    var bg = fill(cfg.plateBg)
    var imgs = []
    if (cfg.plateImage) imgs.push("url('" + cfg.plateImage + "')")
    if (bg.indexOf('gradient') !== -1) imgs.push(bg)
    layer.style.backgroundColor = bg.indexOf('gradient') === -1 ? bg : 'transparent'
    layer.style.backgroundImage = imgs.join(', ')
    layer.style.backgroundSize = cfg.plateImageFit === 'contain' ? 'contain' : cfg.plateImageFit === 'stretch' ? '100% 100%' : 'cover'
    layer.style.backgroundPosition = 'center'
    layer.style.backgroundRepeat = 'no-repeat'
    layer.style.opacity = ''
    var r = cfg.plateRadius || [8, 8, 8, 8]
    if (cfg.plateShape === 'slant') {
      // shape size = skew strength (px of horizontal drift, converted to an angle-ish skew)
      var deg = Math.max(-45, Math.min(45, s))
      layer.style.transform = 'skewX(' + -deg + 'deg)'
      layer.style.clipPath = ''
      layer.style.borderRadius = r[0] + 'px ' + r[1] + 'px ' + r[2] + 'px ' + r[3] + 'px'
      layer.style.border = cfg.plateBorderWidth > 0 ? cfg.plateBorderWidth + 'px ' + cfg.plateBorderStyle + ' ' + bcol : ''
      var sh = []
      if (cfg.plateShadowBlur > 0) sh.push((cfg.plateShadowX || 0) + 'px ' + (cfg.plateShadowY == null ? 2 : cfg.plateShadowY) + 'px ' + cfg.plateShadowBlur + 'px ' + cfg.plateShadowColor)
      if (cfg.plateGlowSize > 0) { sh.push('0 0 ' + cfg.plateGlowSize + 'px ' + cfg.plateGlowColor); sh.push('0 0 ' + cfg.plateGlowSize * 2 + 'px ' + cfg.plateGlowColor) }
      layer.style.boxShadow = sh.length ? sh.join(', ') : ''
      layer.style.filter = ''
      // the animated border effect runs on the layer (its border/glow are the visible ones)
      layer.style.animation = cfg.plateAnim && cfg.plateAnim !== 'none'
        ? 'pa-fx ' + (cfg.plateAnimSpeed || 2) + 's infinite ' + (cfg.plateAnim === 'blink' ? 'step-end' : 'linear')
        : ''
    } else {
      // notch: octagon clip; outline + glow via drop-shadow (they follow the clip shape)
      layer.style.transform = ''
      layer.style.borderRadius = ''
      layer.style.border = ''
      layer.style.boxShadow = ''
      layer.style.clipPath = shapeClip('notch')
      var f = []
      var bw = cfg.plateBorderWidth
      if (bw > 0) {
        f.push('drop-shadow(' + bw + 'px 0 0 ' + bcol + ')')
        f.push('drop-shadow(-' + bw + 'px 0 0 ' + bcol + ')')
        f.push('drop-shadow(0 ' + bw + 'px 0 ' + bcol + ')')
        f.push('drop-shadow(0 -' + bw + 'px 0 ' + bcol + ')')
      }
      if (cfg.plateGlowSize > 0) f.push('drop-shadow(0 0 ' + cfg.plateGlowSize + 'px ' + cfg.plateGlowColor + ')')
      if (cfg.plateShadowBlur > 0) f.push('drop-shadow(' + (cfg.plateShadowX || 0) + 'px ' + (cfg.plateShadowY == null ? 2 : cfg.plateShadowY) + 'px ' + cfg.plateShadowBlur + 'px ' + cfg.plateShadowColor + ')')
      // drop-shadow clips inside the layer box — give the effects room around the clip
      layer.style.filter = f.length ? f.join(' ') : ''
      layer.style.animation = ''
    }
  }
  function removeShapedLayer(el) {
    el.classList.remove('shaped')
    var layer = el.querySelector(':scope > .plate-bg')
    if (layer) layer.remove()
  }

  // ---------- plate ----------
  function applyPlate(el, isZone) {
    var perLine = cfg.plateMode === 'fit' || cfg.plateMode === 'line'
    var active = isZone ? cfg.plateMode === 'panel' : perLine
    // shaped plates render their visuals on a dedicated layer (text stays unclipped);
    // the .shaped class neutralizes the normal bg/border/clip set below
    var shaped = !isZone && active && (cfg.plateShape === 'slant' || cfg.plateShape === 'notch')
    if (shaped) applyShapedLayer(el)
    else if (!isZone) removeShapedLayer(el)
    el.style.background = active ? fill(cfg.plateBg) : ''
    var r = cfg.plateRadius || [8, 8, 8, 8]
    el.style.borderRadius = active
      ? (cfg.plateShape === 'pill' ? '999px' : r[0] + 'px ' + r[1] + 'px ' + r[2] + 'px ' + r[3] + 'px')
      : ''
    el.style.clipPath = active ? shapeClip(cfg.plateShape) : ''
    el.style.border = active && cfg.plateBorderWidth > 0
      ? cfg.plateBorderWidth + 'px ' + cfg.plateBorderStyle + ' ' + hexToRgba(cfg.plateBorderColor, cfg.plateBorderOpacity == null ? 1 : cfg.plateBorderOpacity)
      : ''
    // translucent borders showed the background sticking out under them at the corners —
    // clip the background to the padding box so the border is a clean OUTER stroke
    el.style.backgroundClip = active && cfg.plateBorderWidth > 0 ? 'padding-box' : ''
    // stacked box-shadows: real drop shadow (with direction) + colored glow + soft border
    // halo + 3D extrude (stacked darker layers under the plate)
    var shadows = []
    if (active && cfg.plateDepth > 0) {
      var base = cfg.plateBg && cfg.plateBg.color ? cfg.plateBg.color : '#000000'
      for (var di = 1; di <= cfg.plateDepth; di++) {
        shadows.push('0 ' + di + 'px 0 ' + shade(base, 0.55 - (di / cfg.plateDepth) * 0.2))
      }
    }
    if (active && cfg.plateShadowBlur > 0)
      shadows.push((cfg.plateShadowX || 0) + 'px ' + ((cfg.plateShadowY == null ? 2 : cfg.plateShadowY) + (cfg.plateDepth || 0)) + 'px ' + cfg.plateShadowBlur + 'px ' + cfg.plateShadowColor)
    if (active && cfg.plateGlowSize > 0) {
      shadows.push('0 0 ' + cfg.plateGlowSize + 'px ' + cfg.plateGlowColor)
      shadows.push('0 0 ' + cfg.plateGlowSize * 2 + 'px ' + cfg.plateGlowColor)
    }
    if (active && cfg.plateBorderBlur > 0)
      shadows.push('0 0 ' + cfg.plateBorderBlur + 'px ' + hexToRgba(cfg.plateBorderColor, cfg.plateBorderOpacity == null ? 1 : cfg.plateBorderOpacity))
    el.style.boxShadow = shadows.length ? shadows.join(', ') : ''
    // animated border/glow effect (keyframes generated in applyCfg)
    if (!isZone) {
      el.style.animation = active && cfg.plateAnim && cfg.plateAnim !== 'none'
        ? 'pa-fx ' + (cfg.plateAnimSpeed || 2) + 's infinite ' + (cfg.plateAnim === 'blink' ? 'step-end' : 'linear')
        : ''
    }
    // frosted glass behind the plate
    el.style.backdropFilter = active && cfg.plateBlur > 0 ? 'blur(' + cfg.plateBlur + 'px)' : ''
    el.style.webkitBackdropFilter = el.style.backdropFilter
    el.style.padding = active
      ? cfg.platePadY + 'px ' + cfg.platePadX + 'px'
      : (isZone ? cfg.zonePad + 'px' : '1px 0')
    if (isZone) el.style.padding = active ? Math.max(cfg.zonePad, 4) + 'px' : cfg.zonePad + 'px'
    // fixed size
    if (!isZone) {
      el.style.width = active && cfg.plateWidth > 0 ? cfg.plateWidth + 'px'
        : cfg.plateMode === 'fit' ? 'fit-content' : cfg.plateMode === 'line' ? '' : 'fit-content'
      if (cfg.plateMode === 'line' && cfg.layout !== 'horizontal') el.style.width = '100%'
      // bubble/compact layouts hug their content regardless of the line/fit plate mode
      if ((cfg.layout === 'bubble' || cfg.layout === 'compact') && !(active && cfg.plateWidth > 0)) {
        el.style.width = 'fit-content'
      }
      el.style.height = active && cfg.plateHeight > 0 ? cfg.plateHeight + 'px' : ''
      el.style.maxWidth = '100%'
    } else {
      el.style.width = active && cfg.plateWidth > 0 ? cfg.plateWidth + 'px' : ''
      el.style.height = active && cfg.plateHeight > 0 ? cfg.plateHeight + 'px' : ''
    }
    // mask-image shape / feathered edges — per-line plates only; the zone's mask belongs to
    // edge-fade logic in applyCfg (touching it here silently wiped the edge fade on restyle)
    if (!isZone) {
      if (active && cfg.plateMask) {
        el.style.webkitMaskImage = "url('" + cfg.plateMask + "')"
        el.style.maskImage = "url('" + cfg.plateMask + "')"
        el.style.webkitMaskSize = '100% 100%'
        el.style.maskSize = '100% 100%'
        el.style.webkitMaskComposite = ''
        el.style.maskComposite = ''
      } else if (active && cfg.plateEdgeBlur > 0) {
        // feather all four edges: two crossed gradient masks intersected
        var fpx = cfg.plateEdgeBlur + 'px'
        var mh = 'linear-gradient(to right, transparent 0, black ' + fpx + ', black calc(100% - ' + fpx + '), transparent 100%)'
        var mv = 'linear-gradient(to bottom, transparent 0, black ' + fpx + ', black calc(100% - ' + fpx + '), transparent 100%)'
        el.style.webkitMaskImage = mh + ', ' + mv
        el.style.maskImage = mh + ', ' + mv
        el.style.webkitMaskSize = '100% 100%'
        el.style.maskSize = '100% 100%'
        el.style.webkitMaskComposite = 'source-in'
        el.style.maskComposite = 'intersect'
      } else {
        el.style.webkitMaskImage = ''
        el.style.maskImage = ''
        el.style.webkitMaskComposite = ''
        el.style.maskComposite = ''
      }
    }
    // custom image layer (shaped plates draw the image on their own layer instead)
    if (active && cfg.plateImage && !shaped) {
      el.classList.add('has-img')
      el.style.setProperty('--bg-img', "url('" + cfg.plateImage + "')")
      el.style.setProperty('--bg-img-op', String(cfg.plateImageOpacity == null ? 1 : cfg.plateImageOpacity))
      el.style.setProperty('--bg-img-size', cfg.plateImageFit === 'contain' ? 'contain' : cfg.plateImageFit === 'stretch' ? '100% 100%' : 'cover')
    } else {
      el.classList.remove('has-img')
      el.style.removeProperty('--bg-img')
    }
  }

  function addDecors(el, scope) {
    var ds = cfg.decors || []
    for (var i = 0; i < ds.length; i++) {
      var d = ds[i]
      if (d.scope !== scope || !d.image) continue
      var img = document.createElement('img')
      img.className = 'decor'
      img.src = d.image
      img.style.width = (d.size || 48) + 'px'
      img.style.opacity = String(d.opacity == null ? 1 : d.opacity)
      // list order = stacking order: later decors render on top of earlier ones
      img.style.zIndex = d.above ? String(3 + i) : String(-2 - (ds.length - i))
      var dx = (d.dx || 0) + 'px', dy = (d.dy || 0) + 'px'
      if (d.anchor === 'tl') { img.style.left = dx; img.style.top = dy }
      else if (d.anchor === 'tr') { img.style.right = dx; img.style.top = dy }
      else if (d.anchor === 'bl') { img.style.left = dx; img.style.bottom = dy }
      else if (d.anchor === 'br') { img.style.right = dx; img.style.bottom = dy }
      else if (d.anchor === 'top') { img.style.left = '50%'; img.style.top = dy; img.style.transform = 'translateX(-50%)' }
      else { img.style.left = '50%'; img.style.bottom = dy; img.style.transform = 'translateX(-50%)' }
      el.appendChild(img)
    }
  }

  // ---------- line assembly ----------
  function buildMeta(d) {
    var meta = document.createElement(cfg.nickPos === 'inline' ? 'span' : 'div')
    if (cfg.nickRotate) meta.style.rotate = cfg.nickRotate + 'deg'
    meta.className = 'meta'
    var badges = null
    // custom badge pinned to this user (shown first, before Twitch badges)
    var customBadge = null
    if (cfg.userBadges && cfg.userBadges.length && d.login) {
      for (var ci = 0; ci < cfg.userBadges.length; ci++) {
        if (cfg.userBadges[ci].login === String(d.login).toLowerCase() && cfg.userBadges[ci].image) {
          customBadge = cfg.userBadges[ci].image
          break
        }
      }
    }
    if (cfg.badgesShow && ((d.badges && d.badges.length) || customBadge)) {
      badges = document.createElement('span')
      if (cfg.badgeOffsetX || cfg.badgeOffsetY) badges.style.translate = (cfg.badgeOffsetX || 0) + 'px ' + (cfg.badgeOffsetY || 0) + 'px'
      badges.className = 'badges'
      if (customBadge) {
        var cb = document.createElement('img')
        cb.src = customBadge
        cb.style.height = cfg.badgeSize + 'px'
        badges.appendChild(cb)
      }
      var kindFilter = cfg.badgeKinds && cfg.badgeKinds.length ? cfg.badgeKinds : null
      var CORE_KINDS = ['broadcaster', 'moderator', 'vip', 'subscriber', 'founder']
      for (var i = 0; i < (d.badges || []).length; i++) {
        var setId = d.badgeSets ? d.badgeSets[i] : null
        // the 5 core kinds filter individually; EVERYTHING else (partner, bits, sub-gifter,
        // thematic/event badges) belongs to the single "global" category
        if (kindFilter) {
          var kind = setId && CORE_KINDS.indexOf(setId) !== -1 ? setId : 'global'
          if (kindFilter.indexOf(kind) === -1) continue
        }
        var b = document.createElement('img')
        // replacement: the exact "set/version" key (specific predictions variant) beats
        // the kind-wide key ("predictions" = every variant)
        var ver = d.badgeVers ? d.badgeVers[i] : null
        var rep = null
        if (setId && cfg.badgeReplace) {
          if (ver && cfg.badgeReplace[setId + '/' + ver]) rep = cfg.badgeReplace[setId + '/' + ver]
          else if (cfg.badgeReplace[setId]) rep = cfg.badgeReplace[setId]
        }
        b.src = rep || d.badges[i]
        b.style.height = cfg.badgeSize + 'px'
        badges.appendChild(b)
      }
      if (!badges.childNodes.length) badges = null
    }
    var nick = document.createElement('span')
    nick.className = 'nick'
    nick.textContent = cfg.nickTransform === 'upper' ? d.nick.toUpperCase() : cfg.nickTransform === 'lower' ? d.nick.toLowerCase() : d.nick
    nick.style.fontWeight = cfg.nickBold ? '700' : '400'
    nick.style.fontStyle = cfg.nickItalic ? 'italic' : 'normal'
    nick.style.fontSize = cfg.nickScale !== 100 ? (cfg.nickScale / 100) + 'em' : ''
    if (cfg.nickColorMode === 'twitch' && d.paint) {
      nick.style.background = d.paint
      nick.style.webkitBackgroundClip = 'text'
      nick.style.backgroundClip = 'text'
      nick.style.color = 'transparent'
      nick.style.webkitTextFillColor = 'transparent'
    } else {
      nick.style.color = nickColorFor(d)
    }
    var ts = null
    if (cfg.tsShow) {
      ts = document.createElement('span')
      if (cfg.tsOffsetX || cfg.tsOffsetY) ts.style.translate = (cfg.tsOffsetX || 0) + 'px ' + (cfg.tsOffsetY || 0) + 'px'
      ts.className = 'ts'
      ts.textContent = fmtTs(d.ts)
      ts.style.color = cfg.tsColor
    }
    if (ts && cfg.tsPos === 'before') meta.appendChild(ts)
    if (badges && cfg.badgesPos === 'before') meta.appendChild(badges)
    meta.appendChild(nick)
    if (badges && cfg.badgesPos === 'after') meta.appendChild(badges)
    if (ts && cfg.tsPos !== 'before') meta.appendChild(ts)
    // own chip/plate behind the nick block — works in ANY position, full styling toolbox
    if (cfg.nickBgEnabled) {
      meta.style.background = fill(cfg.nickBg)
      meta.style.borderRadius = cfg.nickBgRadius + 'px'
      meta.style.padding = cfg.nickPadY + 'px ' + cfg.nickPadX + 'px'
      meta.style.width = 'fit-content'
      meta.style.position = 'relative'
      meta.style.zIndex = '2'
      if (cfg.nickBorderWidth > 0) meta.style.border = cfg.nickBorderWidth + 'px solid ' + cfg.nickBorderColor
      var ns = []
      if (cfg.nickShadowBlur > 0) ns.push('0 2px ' + cfg.nickShadowBlur + 'px ' + cfg.nickShadowColor)
      if (cfg.nickGlowSize > 0) {
        ns.push('0 0 ' + cfg.nickGlowSize + 'px ' + cfg.nickGlowColor)
        ns.push('0 0 ' + cfg.nickGlowSize * 2 + 'px ' + cfg.nickGlowColor)
      }
      if (ns.length) meta.style.boxShadow = ns.join(', ')
      if (cfg.nickBlur > 0) {
        meta.style.backdropFilter = 'blur(' + cfg.nickBlur + 'px)'
        meta.style.webkitBackdropFilter = meta.style.backdropFilter
      }
      if (cfg.nickImage) {
        meta.classList.add('has-img')
        meta.style.setProperty('--bg-img', "url('" + cfg.nickImage + "')")
        meta.style.setProperty('--bg-img-op', String(cfg.nickImageOpacity == null ? 1 : cfg.nickImageOpacity))
        meta.style.setProperty('--bg-img-size', 'cover')
      }
    }
    if (cfg.nickFloat && effNickPos() === 'above') {
      // FREE nick: absolutely positioned over the plate — it stops pushing the message
      // down, the text centers in its own plate, and align + offsets move the chip anywhere
      meta.style.position = 'absolute'
      meta.style.width = 'fit-content'
      meta.style.whiteSpace = 'nowrap'
      meta.style.zIndex = '3'
      meta.style.top = (cfg.nickOffsetY || 0) + 'px'
      if (cfg.nickAlign === 'center') {
        meta.style.left = 'calc(50% + ' + (cfg.nickOffsetX || 0) + 'px)'
        meta.style.transform = 'translateX(-50%)'
      } else if (cfg.nickAlign === 'right') {
        meta.style.right = (-(cfg.nickOffsetX || 0)) + 'px'
      } else {
        meta.style.left = (cfg.nickOffsetX || 0) + 'px'
      }
      return meta
    }
    // free nudge, e.g. a cap that overlaps the plate edge
    if (cfg.nickOffsetX || cfg.nickOffsetY) {
      meta.style.position = 'relative'
      meta.style.left = (cfg.nickOffsetX || 0) + 'px'
      meta.style.top = (cfg.nickOffsetY || 0) + 'px'
    }
    if (effNickPos() === 'above') {
      meta.style.marginBottom = cfg.nickBgEnabled ? '2px' : '1px'
      // where the nick block sits across the message width
      if (cfg.nickAlign === 'center') { meta.style.marginLeft = 'auto'; meta.style.marginRight = 'auto'; meta.style.width = 'fit-content' }
      else if (cfg.nickAlign === 'right') { meta.style.marginLeft = 'auto'; meta.style.width = 'fit-content' }
    } else {
      meta.style.display = 'inline-flex'
      meta.style.verticalAlign = 'baseline'
      if (cfg.nickBgEnabled) meta.style.marginRight = '4px'
    }
    return meta
  }

  // bubble & compact layouts structurally put the nick on its own row above the text
  function effNickPos() {
    if (cfg.layout === 'bubble' || cfg.layout === 'compact') return 'above'
    return cfg.nickPos
  }

  // TRUE typewriter: split the message body into per-character units (images stay atomic),
  // lay them out hidden so line wrapping is already final, then reveal one unit at a time.
  // Multi-line text types LINE BY LINE because units reveal in reading (DOM) order.
  function typewriterReveal(el, durMs) {
    var units = []
    function walk(node) {
      var kids = Array.prototype.slice.call(node.childNodes)
      for (var i = 0; i < kids.length; i++) {
        var n = kids[i]
        if (n.nodeType === 3) {
          var chars = Array.from(n.nodeValue)
          if (!chars.length) continue
          var frag = document.createDocumentFragment()
          for (var c = 0; c < chars.length; c++) {
            var sp = document.createElement('span')
            sp.textContent = chars[c]
            sp.style.visibility = 'hidden'
            frag.appendChild(sp)
            units.push(sp)
          }
          node.replaceChild(frag, n)
        } else if (n.nodeType === 1) {
          if (n.tagName === 'IMG') { n.style.visibility = 'hidden'; units.push(n) }
          else walk(n)
        }
      }
    }
    walk(el)
    if (!units.length) return
    var per = Math.max(14, durMs / units.length)
    var i = 0
    var timer = setInterval(function () {
      if (!el.isConnected) { clearInterval(timer); return }
      if (i >= units.length) { clearInterval(timer); return }
      units[i].style.visibility = ''
      i++
    }, per)
  }

  function assemble(d) {
    var el = document.createElement('div')
    el.className = 'line'
    var typeTarget = null // the message text span, for the typewriter animation
    if (d.id) el.dataset.id = d.id
    if (d.user) el.dataset.user = d.user
    if (d.login) el.dataset.login = d.login
    if (cfg.avatarShow && cfg.avatarPos === 'right') el.classList.add('av-right')

    // compact ("messenger") layout always shows the avatar column
    if ((cfg.avatarShow || cfg.layout === 'compact') && d.kind === 'msg') {
      var av = document.createElement('img')
      av.className = 'avatar'
      if (cfg.avatarOffsetX || cfg.avatarOffsetY) av.style.translate = (cfg.avatarOffsetX || 0) + 'px ' + (cfg.avatarOffsetY || 0) + 'px'
      av.style.width = cfg.avatarSize + 'px'
      av.style.height = cfg.avatarSize + 'px'
      av.style.borderRadius = cfg.avatarRadius + '%'
      if (d.avatar) av.src = d.avatar
      else {
        av.style.background = nickColorFor(d)
        av.style.opacity = '0.6'
      }
      el.appendChild(av)
    }

    var content = document.createElement('div')
    content.className = 'content'
    content.style.textShadow = textShadow()

    if (d.kind === 'info') {
      var sys = document.createElement('div')
      sys.className = 'sysline'
      sys.textContent = ''
      sys.innerHTML = d.sys || ''
      content.appendChild(sys)
    } else {
      if (d.sys) {
        var hdr = document.createElement('div')
        hdr.className = 'sysline'
        hdr.innerHTML = d.sys
        content.appendChild(hdr)
      }
      var body = document.createElement('div')
      body.className = 'body'
      if (effNickPos() === 'inline') {
        body.appendChild(buildMeta(d))
        if (d.body) body.appendChild(document.createTextNode(': '))
      } else {
        content.appendChild(buildMeta(d))
      }
      var text = document.createElement('span')
      text.innerHTML = d.body || ''
      typeTarget = text
      if (cfg.textOffsetX || cfg.textOffsetY) {
        text.style.display = 'inline-block'
        text.style.translate = (cfg.textOffsetX || 0) + 'px ' + (cfg.textOffsetY || 0) + 'px'
      }
      // /me action: tint the text with the user's color (like chat) unless set to plain
      if (d.act && cfg.meStyle !== 'plain') text.style.color = nickColorFor(d)
      text.style.fontStyle = cfg.italic ? 'italic' : 'normal'
      text.style.textTransform = cfg.textTransform === 'upper' ? 'uppercase' : cfg.textTransform === 'lower' ? 'lowercase' : 'none'
      body.appendChild(text)
      content.appendChild(body)
    }

    applyPlate(content, false)
    // wrapper hugging the plate: decor images anchor to the PLATE edges (not the full line),
    // and stay outside any shape clipping
    var wrap = document.createElement('div')
    wrap.className = 'cwrap'
    var fullWidth = cfg.plateMode === 'line' && cfg.layout !== 'horizontal' &&
      cfg.layout !== 'bubble' && cfg.layout !== 'compact'
    var perLinePlate = cfg.plateMode === 'fit' || cfg.plateMode === 'line'
    wrap.style.width = perLinePlate && cfg.plateWidth > 0 ? cfg.plateWidth + 'px'
      : fullWidth ? '100%' : 'fit-content'
    wrap.style.maxWidth = '100%'
    wrap.appendChild(content)
    el.appendChild(wrap)
    addDecors(wrap, 'message')

    // zone-level alignment of fit plates
    if (cfg.layout !== 'horizontal') {
      el.style.justifyContent = cfg.align === 'center' ? 'center' : cfg.align === 'right' ? 'flex-end' : 'flex-start'
    }
    // message text aligns within ITS OWN plate independently of the zone alignment
    content.style.textAlign = cfg.msgAlign || 'left'

    // entrance animation (direction-aware). The animation is REMOVED once it finishes:
    // a lingering filled animation keeps a stacking/containing context on the line, which
    // silently disabled backdrop-filter (the "glass" effect) on the plates inside it.
    var an = animName()
    if (an === 'typewriter' && typeTarget && d.kind === 'msg' && !restyling && !creditsActive()) {
      // real typewriter: reveal the body character by character (line by line)
      typewriterReveal(typeTarget, cfg.animInMs || cfg.animMs || 300)
    } else if (an && an !== 'none' && !creditsActive()) {
      animVars(el, cfg.animDir)
      if (an === 'swing' || an === 'hinge') el.style.transformOrigin = 'top left'
      else if (an === 'stretch') el.style.transformOrigin = 'left center'
      else if (an === 'fold') el.style.transformOrigin = 'top center'
      el.style.animation = 'a-' + an + ' ' + (cfg.animInMs || cfg.animMs || 200) + 'ms ease both'
      el.addEventListener('animationend', function (ev) {
        if (ev.target === el) el.style.animation = ''
      }, { once: true })
    }
    // scheduled fade-out
    if (cfg.fadeAfter > 0) {
      var ms = cfg.fadeAfter * 1000
      setTimeout(function () { removeLine(el, true) }, ms)
    }
    return el
  }

  function removeLine(el, animate) {
    if (editMode) return
    if (!el || !el.parentNode) return
    var outMs = cfg.animOutMs || cfg.animMs || 200
    // a flying credits line: exit animations would clobber the flight transform — instant
    if (el.classList.contains('credits')) animate = false
    if (animate && cfg.animOut && cfg.animOut !== 'none') {
      animVars(el, cfg.animOutDir || 'left')
      var ao = cfg.animOut
      if (ao === 'hinge') el.style.transformOrigin = 'top left'
      else if (ao === 'fold') el.style.transformOrigin = 'top center'
      else if (ao === 'tilt' || ao === 'skew') el.style.transformOrigin = 'left center'
      el.classList.add('out')
      el.style.animation = 'o-' + ao + ' ' + outMs + 'ms ease both'
      setTimeout(function () {
        var i = indexOfEl(el)
        if (i !== -1) lines.splice(i, 1)
        el.remove()
        scheduleFit()
      }, outMs + 60)
    } else {
      var i = indexOfEl(el)
      if (i !== -1) lines.splice(i, 1)
      el.remove()
      scheduleFit()
    }
  }
  function indexOfEl(el) {
    var kids = zone.children
    for (var i = 0; i < kids.length; i++) if (kids[i] === el) return i
    return -1
  }

  // ---- keep the rotated/tilted zone inside the viewport ----
  // A 3D-tilted or rotated zone easily pokes past the browser-source edge and gets cut off.
  // After applying the base transform we measure the REAL on-screen bbox and prepend a
  // screen-space scale + translate that pulls everything back into view.
  var zoneBaseTf = ''
  var fitPending = false
  function fitZone() {
    if (!(cfg.tiltX || cfg.tiltY || cfg.rotate)) return
    // credits/page-flip: flying lines make the zone bbox huge — the fit would scale the
    // whole tilted plane down to nothing. Apply the raw perspective transform and stop.
    if (creditsActive() || cfg.pageFlip) { zone.style.transform = zoneBaseTf; return }
    var vw = window.innerWidth, vh = window.innerHeight
    zone.style.transform = zoneBaseTf
    var r = zone.getBoundingClientRect()
    if (!r.width || !r.height) return
    var t = zoneBaseTf
    var sc = Math.min(1, (vw - 8) / r.width, (vh - 8) / r.height)
    if (sc < 1) {
      t = 'scale(' + sc + ') ' + t
      zone.style.transform = t
      r = zone.getBoundingClientRect()
    }
    var dx = r.left < 0 ? -r.left + 4 : r.right > vw ? vw - r.right - 4 : 0
    var dy = r.top < 0 ? -r.top + 4 : r.bottom > vh ? vh - r.bottom - 4 : 0
    if (dx || dy) t = 'translate(' + dx + 'px, ' + dy + 'px) ' + t
    zone.style.transform = t
  }
  function scheduleFit() {
    if (fitPending) return
    fitPending = true
    requestAnimationFrame(function () { fitPending = false; fitZone() })
  }
  window.addEventListener('resize', scheduleFit)

  function creditsActive() {
    return cfg.creditsMode && cfg.layout !== 'horizontal' && !editMode
  }
  // CONVEYOR engine: one rAF loop moves every flying line by the same delta, so the whole
  // tape can ACCELERATE together during floods (creditsRush) and lines can never overlap.
  // A queued line launches only after the previous one cleared its height + gap.
  var creditsQueue = [] // waiting to launch: { el, h }
  var creditsFly = [] // in flight: { el, y }
  var creditsRaf = null
  var creditsLastTs = 0
  function creditsReset() {
    creditsQueue = []
    creditsFly = []
    creditsLastTs = 0
  }
  function startCredits(el) {
    el.classList.add('credits')
    el.style.visibility = 'hidden'
    var h = el.offsetHeight || 24
    if (!cfg.creditsRush) {
      // rush OFF: the launch queue caps at ~6s — extra burst messages are dropped
      var speed = Math.max(5, cfg.creditsSpeed || 40)
      var queued = 0
      for (var qi = 0; qi < creditsQueue.length; qi++) queued += (creditsQueue[qi].h + (cfg.lineGap || 4)) / speed
      if (queued > 6) {
        var di = indexOfEl(el)
        if (di !== -1) lines.splice(di, 1)
        el.remove()
        return
      }
    }
    creditsQueue.push({ el: el, h: h })
    if (creditsRaf === null) creditsRaf = requestAnimationFrame(creditsTick)
  }
  function creditsTick(ts) {
    creditsRaf = null
    if (!creditsActive()) {
      creditsReset()
      return
    }
    var dt = creditsLastTs ? Math.min(0.1, (ts - creditsLastTs) / 1000) : 0
    creditsLastTs = ts
    var speed = Math.max(5, cfg.creditsSpeed || 40)
    var v = speed
    // rush ON: a waiting queue speeds the WHOLE tape up (to 4x) until it drains
    if (cfg.creditsRush && creditsQueue.length) v = speed * Math.min(4, 1 + creditsQueue.length * 0.4)
    var band = cfg.creditsHeight > 0 ? cfg.creditsHeight : (window.innerHeight || 600)
    var gap = cfg.lineGap || 4
    for (var i = creditsFly.length - 1; i >= 0; i--) {
      var f = creditsFly[i]
      if (!f.el.parentNode) {
        creditsFly.splice(i, 1)
        continue
      }
      f.y -= v * dt
      if (f.y <= -(band + 40)) {
        var ri = indexOfEl(f.el)
        if (ri !== -1) lines.splice(ri, 1)
        f.el.remove()
        creditsFly.splice(i, 1)
      } else {
        f.el.style.transform = 'translateY(' + f.y + 'px)'
      }
    }
    if (creditsQueue.length) {
      var lastF = creditsFly.length ? creditsFly[creditsFly.length - 1] : null
      if (!lastF || lastF.y <= -gap) {
        var q = creditsQueue.shift()
        if (q.el.parentNode) {
          q.el.style.visibility = ''
          q.el.style.transform = 'translateY(' + q.h + 'px)'
          creditsFly.push({ el: q.el, y: q.h })
        }
      }
    }
    if (creditsFly.length || creditsQueue.length) creditsRaf = requestAnimationFrame(creditsTick)
    else creditsLastTs = 0
  }

  // ---- page-flip: when the page is full, fold it away and write a fresh blank sheet ----
  var flipping = false
  var flipQueue = []
  function realLineEls() {
    var out = []
    var kids = zone.querySelectorAll(':scope > .line')
    for (var i = 0; i < kids.length; i++) if (!kids[i].classList.contains('out')) out.push(kids[i])
    return out
  }
  // per-direction transforms: [pageTurnsAwayTo, transformOrigin, newPageStartsFrom]
  function flipTransforms(dir) {
    // the outgoing page lifts OUTWARD (translateZ toward the viewer) and turns over its
    // hinge edge — a real page peeling off, not sinking into the screen
    if (dir === 'down') return ['perspective(1600px) translateZ(160px) rotateX(-105deg)', 'bottom center', 'perspective(1600px) rotateX(70deg)']
    if (dir === 'left') return ['perspective(1600px) translateZ(160px) rotateY(-105deg)', 'left center', 'perspective(1600px) rotateY(70deg)']
    if (dir === 'right') return ['perspective(1600px) translateZ(160px) rotateY(105deg)', 'right center', 'perspective(1600px) rotateY(-70deg)']
    return ['perspective(1600px) translateZ(160px) rotateX(105deg)', 'top center', 'perspective(1600px) rotateX(-70deg)'] // up
  }
  function doPageFlip(triggerData) {
    flipping = true
    var dur = Math.max(150, cfg.pageFlipMs || 650)
    var tf = flipTransforms(cfg.pageFlipDir || 'up')
    var awayMs = Math.round(dur * 0.55), inMs = Math.round(dur * 0.45)
    var rect = zone.getBoundingClientRect()
    var cs = getComputedStyle(zone)
    // the outgoing page is a COPY of the whole sheet (background + text), lifted into the
    // unclipped #fx layer so the 3D turn isn't cut off by #zone's overflow. #zone itself is
    // cleared underneath → the fresh blank sheet shows through as the old page turns (notebook)
    var page = document.createElement('div')
    page.className = 'page-flip'
    page.style.position = 'absolute'
    page.style.left = rect.left + 'px'
    page.style.top = rect.top + 'px'
    page.style.width = rect.width + 'px'
    page.style.height = rect.height + 'px'
    page.style.boxSizing = 'border-box'
    page.style.paddingTop = cs.paddingTop
    page.style.paddingRight = cs.paddingRight
    page.style.paddingBottom = cs.paddingBottom
    page.style.paddingLeft = cs.paddingLeft
    page.style.backgroundColor = cs.backgroundColor
    page.style.backgroundImage = cs.backgroundImage
    page.style.backgroundSize = cs.backgroundSize
    page.style.backgroundPosition = cs.backgroundPosition
    page.style.borderRadius = cs.borderRadius
    page.style.boxShadow = cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : '0 14px 28px rgba(0,0,0,.45)'
    page.style.fontFamily = cs.fontFamily
    page.style.color = cs.color
    page.style.fontSize = cs.fontSize
    page.style.display = 'flex'
    page.style.flexDirection = 'column'
    page.style.justifyContent = cs.justifyContent === 'flex-start' ? 'flex-start' : 'flex-end'
    page.style.overflow = 'hidden'
    page.style.zIndex = '60'
    page.style.transformOrigin = tf[1]
    var kids = realLineEls()
    for (var i = 0; i < kids.length; i++) page.appendChild(kids[i])
    lines = [];
    (fxBox || document.body).appendChild(page)
    void page.offsetWidth // force a reflow so the transition actually plays
    page.style.transition = 'transform ' + awayMs + 'ms ease-in, opacity ' + awayMs + 'ms ease-in'
    page.style.transform = tf[0]
    page.style.opacity = '0'
    var finished = false
    function finish() {
      if (finished) return
      finished = true
      page.remove()
      // clear flip state FIRST so the trigger lands on the blank page, then drain in order
      flipping = false
      var q = flipQueue
      flipQueue = []
      if (triggerData) append(triggerData)
      var firstNew = realLineEls()[0]
      if (firstNew) {
        firstNew.style.transformOrigin = tf[1]
        firstNew.style.transform = tf[2]
        firstNew.style.opacity = '0'
        requestAnimationFrame(function () {
          firstNew.style.transition = 'transform ' + inMs + 'ms ease-out, opacity ' + inMs + 'ms ease-out'
          firstNew.style.transform = ''
          firstNew.style.opacity = ''
          setTimeout(function () { firstNew.style.transition = ''; firstNew.style.transformOrigin = '' }, inMs + 60)
        })
      }
      for (var j = 0; j < q.length; j++) append(q[j])
    }
    page.addEventListener('transitionend', finish, { once: true })
    setTimeout(finish, awayMs + 150) // fallback if transitionend is missed
  }

  var restyling = false
  function append(d) {
    if (editMode && d.id !== 'edit-1') return
    if (!passesFilters(d)) return
    // page-flip mode: queue during a flip; flip when the page is already full
    if (cfg.pageFlip && !creditsActive() && !restyling && d.kind !== undefined) {
      if (flipping) { flipQueue.push(d); return }
      if (realLineEls().length >= cfg.maxMessages) { doPageFlip(d); return }
    }
    lines.push(d)
    if (lines.length > cfg.maxMessages + 10) lines.splice(0, lines.length - cfg.maxMessages - 10)
    var el = assemble(d)
    if (cfg.direction === 'down') zone.insertBefore(el, zone.firstChild)
    else zone.appendChild(el)
    if (creditsActive()) {
      startCredits(el)
      // the message COUNT is still capped by "max messages" — drop the oldest instantly
      var flying = zone.querySelectorAll(':scope > .line')
      for (var fi = 0; fi < flying.length - cfg.maxMessages; fi++) {
        var old = flying[fi]
        var oi = indexOfEl(old)
        if (oi !== -1) lines.splice(oi, 1)
        old.remove()
      }
      return
    }
    var vis = []
    for (var ci = 0; ci < zone.children.length; ci++) {
      var ck = zone.children[ci]
      if (ck.classList && ck.classList.contains('line') && !ck.classList.contains('out')) vis.push(ck)
    }
    var excess = vis.length - cfg.maxMessages
    for (var ei = 0; ei < excess; ei++) {
      removeLine(cfg.direction === 'down' ? vis[vis.length - 1 - ei] : vis[ei], !restyling)
    }
    // free-floating nick: the plate must be at least as wide as the nick chip,
    // otherwise short messages leave the nick hanging past the plate edge
    if (cfg.nickFloat && !(cfg.plateWidth > 0) && d.kind === 'msg') {
      var fmeta = el.querySelector('.meta')
      var fwrap = el.querySelector(':scope > .cwrap')
      if (fmeta && fwrap && fmeta.style.position === 'absolute') {
        var need = fmeta.offsetWidth + Math.abs(cfg.nickOffsetX || 0) + 12
        if (fwrap.offsetWidth < need) fwrap.style.minWidth = need + 'px'
      }
    }
    // credits-style smooth push: the new line grows from 0 height, so older lines glide
    // instead of jumping by a full row (vertical layouts only)
    if (!restyling && cfg.smoothScroll && cfg.layout !== 'horizontal') {
      var hh = el.offsetHeight
      if (hh > 0) {
        var sms = cfg.smoothScrollMs || 300
        var mProp = cfg.direction === 'down' ? 'marginBottom' : 'marginTop'
        el.style.height = '0px'
        el.style[mProp] = -(cfg.lineGap || 0) + 'px'
        void el.offsetHeight
        el.style.transition = 'height ' + sms + 'ms ease-out, margin ' + sms + 'ms ease-out'
        el.style.height = hh + 'px'
        el.style[mProp] = '0px'
        setTimeout(function () {
          el.style.transition = ''
          el.style.height = ''
          el.style[mProp] = ''
        }, sms + 60)
      }
    }
    // per-message sound (never during a cfg restyle rebuild)
    if (!restyling && cfg.msgSoundEnabled && cfg.msgSoundData && d.kind === 'msg') {
      try {
        var au = new Audio(cfg.msgSoundData)
        au.volume = Math.max(0, Math.min(1, cfg.msgSoundVolume == null ? 0.5 : cfg.msgSoundVolume))
        au.play().catch(function () {})
      } catch (err) { /* noop */ }
    }
    // word/symbol trigger reactions
    if (!restyling && d.kind === 'msg' && d.text && cfg.triggers && cfg.triggers.length) {
      var tl = String(d.text).toLowerCase()
      var nickl = String(d.login || d.nick || '').toLowerCase()
      for (var ti = 0; ti < cfg.triggers.length; ti++) {
        var tg = cfg.triggers[ti]
        if (!tg.word || !tg.image) continue
        // one trigger can hold MANY words/phrases/nicks — one per line
        // NB: this whole page lives in a TS template literal — regex escapes like \\n get
        // mangled there, so split on the raw newline char code instead
        var words = String(tg.word).split(String.fromCharCode(10))
        for (var wi = 0; wi < words.length; wi++) {
          var w = words[wi].trim().toLowerCase()
          if (!w) continue
          var asNick = w.replace(/^@/, '')
          if (tl.indexOf(w) !== -1 || (asNick && nickl === asNick)) {
            spawnTrigger(tg, el.querySelector(':scope > .cwrap'))
            break
          }
        }
      }
    }
    scheduleFit()
  }

  var fxBox = document.getElementById('fx')
  var activeTriggers = {}
  function spawnTrigger(tg, wrap) {
    var onMessage = tg.attach === 'message' && wrap
    if (!onMessage) {
      if (activeTriggers[tg.id]) return // one instance of a screen trigger at a time
      activeTriggers[tg.id] = true
    }
    var box = document.createElement('div')
    box.className = 'tgi'
    box.style.width = (tg.size || 96) + 'px'
    var dx = (tg.dx || 0) + 'px', dy = (tg.dy || 0) + 'px'
    var p = tg.pos || 'br'
    if (onMessage) {
      // pinned NEXT TO the triggering message — decor-image positioning logic: anchored to
      // the plate wrapper's edge via left/right + margins (no transforms, so the entrance
      // animation can't knock it off place), tracking the plate's real width
      if (p === 'tl' || p === 'left' || p === 'bl') {
        box.style.right = '100%'
        box.style.marginRight = 6 + (tg.dx || 0) + 'px'
      } else {
        box.style.left = '100%'
        box.style.marginLeft = 6 + (tg.dx || 0) + 'px'
      }
      box.style.top = (tg.dy || 0) + 'px'
      box.style.zIndex = '5'
    } else if (p === 'tl') { box.style.left = dx; box.style.top = dy }
    else if (p === 'tr') { box.style.right = dx; box.style.top = dy }
    else if (p === 'bl') { box.style.left = dx; box.style.bottom = dy }
    else if (p === 'br') { box.style.right = dx; box.style.bottom = dy }
    else if (p === 'top') { box.style.left = 'calc(50% + ' + dx + ')'; box.style.top = dy; box.style.transform = 'translateX(-50%)' }
    else if (p === 'bottom') { box.style.left = 'calc(50% + ' + dx + ')'; box.style.bottom = dy; box.style.transform = 'translateX(-50%)' }
    else if (p === 'left') { box.style.left = dx; box.style.top = 'calc(50% + ' + dy + ')' }
    else { box.style.right = dx; box.style.top = 'calc(50% + ' + dy + ')' }
    // slide direction: from the nearest horizontal edge
    box.style.setProperty('--tx', p === 'tl' || p === 'left' || p === 'bl' ? '-60px' : '60px')
    // entrance animation on the box, gentle bob loop on the image inside
    var an = tg.anim || 'pop'
    var img = document.createElement('img')
    img.src = tg.image
    img.style.animation = 'tg-bob 2.2s ease-in-out 0.6s infinite'
    box.style.animation = 'tg-' + (an === 'wiggle' ? 'wiggle-in' : an) + ' 0.45s ease both'
    box.appendChild(img)
    ;(onMessage ? wrap : fxBox).appendChild(box)
    // duration 0 = the reaction never disappears (message-attached ones leave with the line)
    var life = (tg.durationS == null ? 5 : tg.durationS) * 1000
    if (life > 0) {
      setTimeout(function () {
        box.classList.add('leaving')
        setTimeout(function () {
          box.remove()
          if (!onMessage) delete activeTriggers[tg.id]
        }, 450)
      }, life)
    }
  }

  // ---------- config application ----------
  function applyCfg() {
    fontFace.textContent = cfg.fontData
      ? "@font-face { font-family: '" + (cfg.font || 'OverlayFont').replace(/'/g, '') + "'; src: url('" + cfg.fontData + "'); }"
      : ''
    customCss.textContent = cfg.customCss || ''
    // generated keyframes for the animated border/glow effect
    fxCss.textContent = buildFxKeyframes()
    zone.className =
      'layout-' + cfg.layout + ' dir-' + cfg.direction + ' anchor-' + cfg.anchor + ' align-' + cfg.align
    zone.style.fontFamily = cfg.font ? "'" + cfg.font.replace(/'/g, '') + "', 'Segoe UI', sans-serif" : "'Segoe UI', sans-serif"
    zone.style.fontSize = cfg.fontSize + 'px'
    zone.style.fontWeight = cfg.bold ? '600' : '400'
    zone.style.color = cfg.textColor
    zone.style.gap = cfg.lineGap + 'px'
    zone.style.setProperty('--emote-h', cfg.emoteScale + 'em')

    if (cfg.layout === 'horizontal') {
      zone.style.top = cfg.anchor === 'top' ? '0' : 'auto'
      zone.style.bottom = cfg.anchor === 'top' ? 'auto' : '0'
      zone.style.justifyContent = cfg.direction === 'down' ? 'flex-start' : 'flex-end'
    } else if (cfg.direction === 'down') {
      zone.style.top = '0'
      zone.style.bottom = 'auto'
      zone.style.justifyContent = 'flex-start'
    } else {
      zone.style.top = 'auto'
      zone.style.bottom = '0'
      zone.style.justifyContent = 'flex-end'
    }

    applyPlate(zone, true)

    // trailing-edge fade mask (old messages melt away instead of hard-clipping).
    // Applied AFTER applyPlate so nothing overwrites it. When the panel has its own
    // mask-image and no edge fade, the panel mask wins.
    if (cfg.edgeFade > 0) {
      var m
      if (cfg.layout === 'horizontal') {
        m = cfg.direction === 'down'
          ? 'linear-gradient(to left, transparent 0, black ' + cfg.edgeFade + 'px)'
          : 'linear-gradient(to right, transparent 0, black ' + cfg.edgeFade + 'px)'
      } else {
        m = cfg.direction === 'down'
          ? 'linear-gradient(to top, transparent 0, black ' + cfg.edgeFade + 'px)'
          : 'linear-gradient(to bottom, transparent 0, black ' + cfg.edgeFade + 'px)'
      }
      zone.style.webkitMaskImage = m
      zone.style.maskImage = m
      zone.style.webkitMaskSize = ''
      zone.style.maskSize = ''
    } else if (cfg.plateMode === 'panel' && cfg.plateMask) {
      zone.style.webkitMaskImage = "url('" + cfg.plateMask + "')"
      zone.style.maskImage = "url('" + cfg.plateMask + "')"
      zone.style.webkitMaskSize = '100% 100%'
      zone.style.maskSize = '100% 100%'
    } else {
      zone.style.webkitMaskImage = ''
      zone.style.maskImage = ''
    }
    // zone decors: clear previously added ones, re-add
    var old = zone.querySelectorAll(':scope > .decor')
    for (var i = 0; i < old.length; i++) old[i].remove()
    addDecors(zone, 'zone')

    // 3D perspective + free shift of the whole chat zone
    var tf = ''
    if (cfg.zoneOffsetX || cfg.zoneOffsetY) {
      tf += 'translate(' + (cfg.zoneOffsetX || 0) + 'px, ' + (cfg.zoneOffsetY || 0) + 'px) '
    }
    if (cfg.tiltX || cfg.tiltY || cfg.rotate) {
      tf += 'perspective(' + (cfg.perspDepth || 800) + 'px)'
      if (cfg.tiltX) tf += ' rotateX(' + cfg.tiltX + 'deg)'
      if (cfg.tiltY) tf += ' rotateY(' + cfg.tiltY + 'deg)'
      if (cfg.rotate) tf += ' rotate(' + cfg.rotate + 'deg)'
    }
    zoneBaseTf = tf.trim()
    zone.style.transform = zoneBaseTf
    zone.style.transformOrigin = cfg.anchor === 'top' || cfg.direction === 'down' ? '50% 0%' : '50% 100%'

    // rebuild all visible lines with the new structure/styles
    creditsReset() // credits engine restarts with the rebuild
    flipping = false; flipQueue = [] // page-flip state resets too
    var kids = zone.querySelectorAll(':scope > .line')
    for (var k = 0; k < kids.length; k++) kids[k].remove()
    var data = lines.slice(-cfg.maxMessages)
    lines = []
    var savedAnim = cfg.animIn
    cfg.animIn = 'none' // don't replay entrance animations on restyle
    restyling = true
    for (var j = 0; j < data.length; j++) append(data[j])
    restyling = false
    cfg.animIn = savedAnim
  }

  // ---------- SSE ----------
  function connect() {
    var es = new EventSource('/events?channel=' + encodeURIComponent(channel) + '&profile=' + encodeURIComponent(profile))
    es.addEventListener('cfg', function (e) {
      try { cfg = Object.assign(cfg, JSON.parse(e.data)); applyCfg() } catch (err) { /* noop */ }
    })
    es.addEventListener('del', function (e) {
      try {
        var d = JSON.parse(e.data)
        var kids = zone.querySelectorAll(':scope > .line')
        for (var i = 0; i < kids.length; i++) {
          var el = kids[i]
          if (d.all || (d.id && el.dataset.id === d.id) || (d.user && el.dataset.user === d.user)) removeLine(el, false)
        }
      } catch (err) { /* noop */ }
    })
    es.onmessage = function (e) {
      try { append(JSON.parse(e.data)) } catch (err) { /* noop */ }
    }
    es.onerror = function () { es.close(); setTimeout(connect, 3000) }
  }

  // ---------- editor preview: local demo messages ----------
  function svgAvatar(letter, color) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<rect width="64" height="64" fill="' + color + '"/>' +
      '<text x="32" y="42" font-size="32" font-family="Segoe UI" font-weight="700" fill="#fff" text-anchor="middle">' + letter + '</text></svg>'
    return 'data:image/svg+xml;base64,' + btoa(svg)
  }
  var BADGE_MOD = 'https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/2'
  var BADGE_VIP = 'https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/2'
  var EMOTE = 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'
  function demoLines() {
    return [
      { nick: 'Bobik069', color: '#ff69b4', badges: [BADGE_MOD], body: 'привіт чат! <img class="emoji-img" src="https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/1f49c.png">', av: 'B' },
      { nick: 'Pinuses', color: '#5cb2ff', badges: [], body: 'that timing was clean <img class="emote" src="' + EMOTE + '">', av: 'P' },
      { nick: 'Meme_gavgav', color: '#7cff5c', badges: [BADGE_VIP], body: 'гав гав гав <img class="emoji-img" src="https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/1f436.png">', av: 'M' },
      { nick: 'I_Love_Vladyslav', color: '#ffd75c', badges: [], body: 'Їжте щедрі ґрона! Quick brown fox 0123', av: 'I' },
      { nick: 'Ivan_In_My_Ass', color: '#ff8a5c', badges: [], body: 'хто тут головний по мемах?', av: 'I' },
      { nick: 'n1cole_cat', color: '#5cffd7', badges: [BADGE_VIP], body: 'мур-мур <img class="emoji-img" src="https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/1f63a.png"> клас стрім', av: 'N' },
      { nick: 'Mira_Cat', color: '#c95cff', badges: [BADGE_MOD, BADGE_VIP], body: 'дуже класний оверлей вийшов <img class="emoji-img" src="https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/1f431.png">', av: 'M' }
    ]
  }
  function startDemo() {
    var samples = demoLines()
    var n = 0
    function push() {
      var s = samples[n % samples.length]
      n++
      append({
        id: 'demo-' + n,
        user: 'demo',
        login: s.nick.toLowerCase(),
        nick: s.nick,
        color: s.color,
        avatar: svgAvatar(s.av, s.color),
        badges: s.badges,
        body: s.body,
        kind: 'msg',
        ts: Date.now()
      })
    }
    for (var i = 0; i < 4; i++) push()
    setInterval(push, 2500)
  }

  // ---------- single-message visual editor (?edit=1, used by the in-app editor) ----------
  function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
  function postEdit(patch) {
    try { window.parent.postMessage({ __oeEdit: true, patch: patch }, '*') } catch (err) { /* noop */ }
  }
  var editApplyPending = false
  function localApply(patch) {
    for (var k in patch) cfg[k] = patch[k]
    if (editApplyPending) return
    editApplyPending = true
    requestAnimationFrame(function () { editApplyPending = false; applyCfg() })
  }
  function editTargetOf(t) {
    if (!t || !t.closest) return null
    var el = t.closest('.avatar, .badges, .ts, .meta, .body, .cwrap')
    if (!el) return null
    if (el.classList.contains('avatar')) return 'avatar'
    if (el.classList.contains('badges')) return 'badges'
    if (el.classList.contains('ts')) return 'ts'
    if (el.classList.contains('meta')) return 'nick'
    if (el.classList.contains('body')) return 'text'
    return 'plate'
  }
  function editBase(kind) {
    if (kind === 'nick') return [cfg.nickOffsetX || 0, cfg.nickOffsetY || 0]
    if (kind === 'avatar') return [cfg.avatarOffsetX || 0, cfg.avatarOffsetY || 0]
    if (kind === 'badges') return [cfg.badgeOffsetX || 0, cfg.badgeOffsetY || 0]
    if (kind === 'ts') return [cfg.tsOffsetX || 0, cfg.tsOffsetY || 0]
    if (kind === 'text') return [cfg.textOffsetX || 0, cfg.textOffsetY || 0]
    return [cfg.zoneOffsetX || 0, cfg.zoneOffsetY || 0]
  }
  function editDragPatch(kind, x, y) {
    if (kind === 'nick') return { nickOffsetX: x, nickOffsetY: y }
    if (kind === 'avatar') return { avatarOffsetX: x, avatarOffsetY: y }
    if (kind === 'badges') return { badgeOffsetX: x, badgeOffsetY: y }
    if (kind === 'ts') return { tsOffsetX: x, tsOffsetY: y }
    if (kind === 'text') return { textOffsetX: x, textOffsetY: y }
    return { zoneOffsetX: x, zoneOffsetY: y }
  }
  function startEditMode() {
    document.body.classList.add('edit')
    append({
      id: 'edit-1',
      user: 'demo',
      login: 'bobik069',
      nick: 'Bobik069',
      color: '#9147ff',
      avatar: svgAvatar('B', '#9147ff'),
      badges: [BADGE_MOD],
      body: 'Щурячий бугай із їжаком-харцизом в\u2019ючись підписали ґешефт у єнах',
      text: 'Щурячий бугай із їжаком-харцизом в\u2019ючись підписали ґешефт у єнах',
      kind: 'msg',
      ts: Date.now()
    })
    var drag = null
    document.addEventListener('contextmenu', function (e) { e.preventDefault() })
    document.addEventListener('pointerdown', function (e) {
      // Ctrl + RIGHT mouse anywhere = pan the parent's preview viewport. SCREEN coords:
      // client coords shift together with the transformed iframe and fed back into a
      // jitter loop — screen coords are stable
      if (e.button === 2) {
        if (e.ctrlKey) {
          drag = { kind: 'pan', x: e.screenX, y: e.screenY }
          e.preventDefault()
        }
        return
      }
      var kind = editTargetOf(e.target)
      if (!kind) return
      drag = { kind: kind, x: e.clientX, y: e.clientY, base: editBase(kind) }
      e.preventDefault()
    })
    // avatar/badges/time/text move by DIRECT style during the drag — zero rebuilds, zero
    // flicker; nick/plate need the full layout pass (their offsets apply structurally).
    // The patch is posted to the editor ONCE on pointerup, so no mid-drag sync storms.
    function applyDirect(kind, x, y) {
      var line = zone.querySelector('.line')
      if (!line) return false
      var el =
        kind === 'avatar' ? line.querySelector('.avatar')
        : kind === 'badges' ? line.querySelector('.badges')
        : kind === 'ts' ? line.querySelector('.ts')
        : kind === 'text' ? line.querySelector('.body > span:last-child')
        : null
      if (!el) return false
      if (kind === 'text') el.style.display = 'inline-block'
      el.style.translate = x + 'px ' + y + 'px'
      return true
    }
    document.addEventListener('pointermove', function (e) {
      if (!drag) return
      if (drag.kind === 'pan') {
        try {
          window.parent.postMessage({ __oeEdit: true, panBy: { x: e.screenX - drag.x, y: e.screenY - drag.y } }, '*')
        } catch (err) { /* noop */ }
        drag.x = e.screenX
        drag.y = e.screenY
        return
      }
      var x = drag.base[0] + Math.round(e.clientX - drag.x)
      var y = drag.base[1] + Math.round(e.clientY - drag.y)
      var patch = editDragPatch(drag.kind, x, y)
      for (var k in patch) cfg[k] = patch[k]
      drag.last = patch
      if (!applyDirect(drag.kind, x, y)) localApply(patch)
    })
    document.addEventListener('pointerup', function () {
      if (drag && drag.last) postEdit(drag.last)
      drag = null
    })
    // Ctrl+Z / Ctrl+Shift+Z inside the preview forward to the editor's undo/redo
    document.addEventListener('keydown', function (e) {
      if (!e.ctrlKey || e.altKey || e.code !== 'KeyZ') return
      e.preventDefault()
      try {
        window.parent.postMessage({ __oeEdit: true, undo: !e.shiftKey, redo: e.shiftKey }, '*')
      } catch (err) { /* noop */ }
    })
    // wheel = scale element; wheel on EMPTY space = zoom the parent's preview viewport
    document.addEventListener('wheel', function (e) {
      var kind = editTargetOf(e.target)
      if (!kind) {
        e.preventDefault()
        try {
          window.parent.postMessage({ __oeEdit: true, zoomStep: { dir: e.deltaY < 0 ? 1 : -1, x: e.clientX, y: e.clientY } }, '*')
        } catch (err) { /* noop */ }
        return
      }
      e.preventDefault()
      var dir = e.deltaY < 0 ? 1 : -1
      var patch = null
      if (kind === 'avatar') patch = { avatarSize: clampN((cfg.avatarSize || 28) + dir * 2, 12, 128) }
      else if (kind === 'badges') patch = { badgeSize: clampN((cfg.badgeSize || 18) + dir, 8, 64) }
      else if (kind === 'nick') {
        patch = e.altKey
          ? { nickRotate: clampN((cfg.nickRotate || 0) + dir * 2, -180, 180) }
          : { nickScale: clampN((cfg.nickScale || 100) + dir * 5, 40, 300) }
      } else if (kind === 'text' || kind === 'plate') patch = { fontSize: clampN((cfg.fontSize || 16) + dir, 8, 72) }
      if (patch) { localApply(patch); postEdit(patch) }
    }, { passive: false })
  }

  applyCfg()
  connect()
  if (editMode) startEditMode()
  else if (preview) startDemo()
  // debug hook (harmless in OBS): lets diagnostics poke the page state from devtools
  window.__oe = { cfg: cfg, applyCfg: applyCfg, append: append, zone: zone }
})()
</script>
</body>
</html>`
