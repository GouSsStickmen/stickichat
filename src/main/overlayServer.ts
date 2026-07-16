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
  /* horizontal bar: messages stretch in WIDTH, never grow in height */
  #zone.layout-horizontal .line { flex: 0 0 auto; max-width: none; }
  #zone.layout-horizontal .content { white-space: nowrap; }
  #zone.layout-horizontal .body { white-space: nowrap; }
  .meta { display: flex; align-items: center; gap: 4px; }
  .meta.chip { display: inline-flex; }
  .badges { display: inline-flex; align-items: center; gap: 2px; vertical-align: -0.15em; }
  .badges img { display: inline-block; border-radius: 2px; }
  .nick { font-weight: 700; }
  .ts { opacity: 0.85; font-size: 0.8em; }
  .sysline { font-style: italic; opacity: 0.9; }
  .body img.emote { height: var(--emote-h, 1.4em); vertical-align: -0.3em; margin: 0 1px; }
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
  .line.out { transition-property: opacity, transform; transition-timing-function: ease; }
  .line.out.o-fade { opacity: 0; }
  .line.out.o-shrink { opacity: 0; transform: scale(0.6); }
</style>
<style id="customCss"></style>
<style id="fontFace"></style>
<style id="fxCss"></style>
</head>
<body>
<div id="zone"></div>
<script>
(function () {
  'use strict'
  var p = new URLSearchParams(location.search)
  var channel = (p.get('channel') || '').toLowerCase()
  var profile = p.get('profile') || ''
  var preview = p.get('preview') === '1'
  var zone = document.getElementById('zone')
  var customCss = document.getElementById('customCss')
  var fontFace = document.getElementById('fontFace')
  var fxCss = document.getElementById('fxCss')

  // defaults until the first cfg event lands (mirrors DEFAULT_CHAT_OVERLAY)
  var cfg = {
    layout: 'list', direction: 'up', align: 'left', anchor: 'bottom',
    maxMessages: 15, fadeAfter: 0, lineGap: 4, zonePad: 8, edgeFade: 0,
    animIn: 'slide', animDir: 'down', animOut: 'fade', animMs: 200,
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
    decors: [], hiddenUsers: [],
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
  // entrance direction → offset vector for slide/bounce/elastic and flip axis
  function animVars(el) {
    var d = cfg.animDir || 'down'
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

  // ---------- plate ----------
  function applyPlate(el, isZone) {
    var perLine = cfg.plateMode === 'fit' || cfg.plateMode === 'line'
    var active = isZone ? cfg.plateMode === 'panel' : perLine
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
    // custom image layer
    if (active && cfg.plateImage) {
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
    meta.className = 'meta'
    var badges = null
    if (cfg.badgesShow && d.badges && d.badges.length) {
      badges = document.createElement('span')
      badges.className = 'badges'
      for (var i = 0; i < d.badges.length; i++) {
        var b = document.createElement('img')
        b.src = d.badges[i]
        b.style.height = cfg.badgeSize + 'px'
        badges.appendChild(b)
      }
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

  function assemble(d) {
    var el = document.createElement('div')
    el.className = 'line'
    if (d.id) el.dataset.id = d.id
    if (d.user) el.dataset.user = d.user
    if (d.login) el.dataset.login = d.login
    if (cfg.avatarShow && cfg.avatarPos === 'right') el.classList.add('av-right')

    // compact ("messenger") layout always shows the avatar column
    if ((cfg.avatarShow || cfg.layout === 'compact') && d.kind === 'msg') {
      var av = document.createElement('img')
      av.className = 'avatar'
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
      text.style.fontStyle = cfg.italic ? 'italic' : 'normal'
      text.style.textTransform = cfg.textTransform === 'upper' ? 'uppercase' : cfg.textTransform === 'lower' ? 'lowercase' : 'none'
      body.appendChild(text)
      content.appendChild(body)
    }

    applyPlate(content, false)
    el.appendChild(content)
    // decors live on the LINE, not the content — clip-path shapes must not cut them off
    addDecors(el, 'message')

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
    if (an && an !== 'none') {
      animVars(el)
      el.style.animation = 'a-' + an + ' ' + (cfg.animMs || 200) + 'ms ease both'
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
    if (!el || !el.parentNode) return
    if (animate && cfg.animOut && cfg.animOut !== 'none') {
      el.classList.add('out', 'o-' + cfg.animOut)
      el.style.transitionDuration = (cfg.animMs || 200) + 'ms'
      setTimeout(function () {
        var i = indexOfEl(el)
        if (i !== -1) lines.splice(i, 1)
        el.remove()
      }, (cfg.animMs || 200) + 60)
    } else {
      var i = indexOfEl(el)
      if (i !== -1) lines.splice(i, 1)
      el.remove()
    }
  }
  function indexOfEl(el) {
    var kids = zone.children
    for (var i = 0; i < kids.length; i++) if (kids[i] === el) return i
    return -1
  }

  var restyling = false
  function append(d) {
    if (!passesFilters(d)) return
    lines.push(d)
    if (lines.length > cfg.maxMessages + 10) lines.splice(0, lines.length - cfg.maxMessages - 10)
    var el = assemble(d)
    if (cfg.direction === 'down') zone.insertBefore(el, zone.firstChild)
    else zone.appendChild(el)
    while (zone.children.length > cfg.maxMessages) {
      zone.removeChild(cfg.direction === 'down' ? zone.lastChild : zone.firstChild)
    }
    // per-message sound (never during a cfg restyle rebuild)
    if (!restyling && cfg.msgSoundEnabled && cfg.msgSoundData && d.kind === 'msg') {
      try {
        var au = new Audio(cfg.msgSoundData)
        au.volume = Math.max(0, Math.min(1, cfg.msgSoundVolume == null ? 0.5 : cfg.msgSoundVolume))
        au.play().catch(function () {})
      } catch (err) { /* noop */ }
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
    zone.style.transform = tf.trim()
    zone.style.transformOrigin = cfg.anchor === 'top' || cfg.direction === 'down' ? '50% 0%' : '50% 100%'

    // rebuild all visible lines with the new structure/styles
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
      { nick: 'Bobik069', color: '#ff69b4', badges: [BADGE_MOD], body: 'привіт чат! 💜', av: 'B' },
      { nick: 'Pinuses', color: '#5cb2ff', badges: [], body: 'that timing was clean <img class="emote" src="' + EMOTE + '">', av: 'P' },
      { nick: 'Meme_gavgav', color: '#7cff5c', badges: [BADGE_VIP], body: 'гав гав гав 🐶', av: 'M' },
      { nick: 'I_Love_Vladislav', color: '#ffd75c', badges: [], body: 'Їжте щедрі ґрона! Quick brown fox 0123', av: 'I' },
      { nick: 'Mira_Cat', color: '#c95cff', badges: [BADGE_MOD, BADGE_VIP], body: 'дуже класний оверлей вийшов 🐱', av: 'M' }
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

  applyCfg()
  connect()
  if (preview) startDemo()
})()
</script>
</body>
</html>`
