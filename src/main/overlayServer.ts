import { createServer, Server, ServerResponse } from 'http'
import { createReadStream } from 'fs'
import { ASSET_SCHEME, assetFile, assetContentType } from './assets'

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

/**
 * Point the overlay page at assets it can actually reach.
 *
 * Uploaded pictures, fonts and badges live as files now, referenced as `sticki-asset://…`. That
 * scheme only exists inside the app; OBS loads this page over plain HTTP from another origin and
 * would render nothing. Swap the references for this server's own route on the way out — the
 * stored config stays canonical, only what goes over the wire is rewritten.
 */
function forTheWire<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.startsWith(`${ASSET_SCHEME}://`)
      ? `/asset/${value.slice(ASSET_SCHEME.length + 3)}`
      : value) as unknown as T
  }
  if (Array.isArray(value)) return value.map(forTheWire) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = forTheWire(v)
    return out as unknown as T
  }
  return value
}

/**
 * The style for one OBS source, found by the profile id baked into its URL.
 *
 * There used to be a fallback to the first overlay whenever that id was not found, and it is why
 * deleting an overlay reshuffled every browser source in OBS: a source whose profile had gone
 * quietly put on somebody else's costume, and since the fallback was always "whichever is first",
 * the whole set appeared to rotate through each other in the order they were created. A URL is a
 * promise that THIS source shows THIS overlay — guessing is worse than admitting it is gone.
 *
 * An EMPTY profile is a different case: that is a URL from before profiles existed, and the first
 * overlay is the only thing it can possibly mean.
 */
function styleFor(profile: string): OverlayStyle | undefined {
  const style = profile ? styles[profile] : Object.values(styles)[0]
  return style ? forTheWire(style) : undefined
}

/** the id was named and is not among the overlays — the source outlived what it pointed at */
function profileMissing(profile: string): boolean {
  return !!profile && !styles[profile]
}

/**
 * How many browser sources are listening to each overlay right now.
 *
 * An overlay that shows nothing in OBS has two very different causes — the page is not running, or
 * it is running and nothing is being sent — and from inside the app they look identical. This is
 * the difference, and it is the first thing to check when a source has gone blank.
 */
export function overlayClients(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of clients) out[c.profile] = (out[c.profile] ?? 0) + 1
  return out
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
    if (profileMissing(c.profile)) {
      // say so out loud rather than leaving it wearing the last look it happened to receive
      try {
        c.res.write('event: gone\ndata: {}\n\n')
      } catch {
        clients.delete(c)
      }
      continue
    }
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
      /**
       * Which page an OBS source gets is decided by the overlay it points at.
       *
       * The kind is resolved here rather than inside one page that branches at runtime, because
       * these share nothing but the SSE connection: a chat log, a particle engine, a progress bar
       * and an alert have different DOM, different CSS and different loops. One page holding all
       * of them would ship every one to every source and grow a condition around each line.
       */
      const kind = (styleFor(url.searchParams.get('profile') ?? '') as { type?: string } | null)?.type
      /**
       * Never cached. Which page an overlay gets depends on its kind, and its kind can change under
       * a source that is already pointed at it — a browser holding yesterday's copy would keep
       * running a page for an overlay that is no longer that shape, and look simply broken.
       */
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, must-revalidate',
        Pragma: 'no-cache'
      })
      res.end(
        kind === 'emotes'
          ? EMOTE_HTML
          : kind === 'goal'
            ? GOAL_HTML
            : kind === 'follow'
              ? ALERT_HTML
              : kind === 'roulette'
                ? WHEEL_HTML
                : OVERLAY_HTML
      )
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
      else if (profileMissing(profile)) res.write('event: gone\ndata: {}\n\n')
      for (const line of backlog.get(channel) ?? []) {
        res.write(`data: ${JSON.stringify(line)}\n\n`)
      }
      const client: SseClient = { channel, profile, res }
      clients.add(client)
      req.on('close', () => clients.delete(client))
      return
    }
    if (url.pathname.startsWith('/asset/')) {
      const file = assetFile(decodeURIComponent(url.pathname.slice('/asset/'.length)))
      if (file) {
        res.writeHead(200, {
          'Content-Type': assetContentType(file),
          // content-addressed: the name changes when the bytes do, so this can never go stale
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*'
        })
        createReadStream(file).pipe(res)
        return
      }
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
  /* the shaped plate's paint and its clip; the filters stay on .plate-bg above it, see
     applyShapedLayer — a clip-path cuts away the drop-shadows of its own element */
  .plate-shape { position: absolute; inset: 0; box-sizing: border-box; }
  /* diagonal sheen for the glass effect — strength comes from --gloss (plateGloss) */
  .has-gloss { position: relative; overflow: hidden; }
  .has-gloss::after { content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: inherit; z-index: 0;
    background: linear-gradient(135deg, rgba(255,255,255,calc(0.34 * var(--gloss, 0))) 0%, rgba(255,255,255,calc(0.07 * var(--gloss, 0))) 38%, transparent 62%); }
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
  /* first-message caption — inside the plate, above the words, in the mark's own colour */
  .firstcap { font-size: 0.72em; font-weight: 700; letter-spacing: 0.03em; line-height: 1.35; opacity: 0.95; }
  /* the mark's own fill layer. It is a LAYER and not the element's background because the plate
     may already be using that background for a picture drawn in a ::before, or may have handed
     its visuals to a .plate-bg entirely — in both cases a background set here is simply covered */
  .content.firsthl { isolation: isolate; }
  .firsthl-bg { position: absolute; inset: 0; z-index: -1; pointer-events: none; border-radius: inherit; }
  /* frame + glow for a MASKED plate, which clips its own outline and shadow away with everything
     else; the wrapper hugs the same box and is not masked */
  .firsthl-ring { position: absolute; inset: 0; z-index: -1; pointer-events: none; }
  /* a few breaths and then still: enough to catch the eye in a moving chat, not a strobe */
  @keyframes fhl-pulse { 0%, 100% { filter: none } 50% { filter: brightness(1.35) saturate(1.15) } }
  .body img.emote { height: var(--emote-h, 1.4em); vertical-align: -0.3em; margin: 0 1px; }
  /* a badge replaced by TEXT: a compact pill that lines up with the image badges */
  .badges .badge-text { display: inline-block; padding: 0 5px; margin: 0 2px; border-radius: 4px;
    background: rgba(255,255,255,.16); color: inherit; font-weight: 700; vertical-align: middle; white-space: nowrap; }
  /* layered ("combo") emotes: the zero-width layers sit centred on the base one */
  /* layers are CENTRED on the base emote — pinned to the top-left, a wider layer hangs off
     the side and the whole stack looks shifted */
  .body .emote-stack { position: relative; display: inline-grid; justify-items: center; align-items: center; vertical-align: -0.3em; }
  .body .emote-stack img.emote { grid-area: 1 / 1; vertical-align: baseline; margin: 0; }
  .body img.chat-gif { display: block; max-width: 100%; max-height: var(--gif-h, 120px); border-radius: 6px; margin: 3px 0; }
  .body .emote-stack img.emote-ov { pointer-events: none; }
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
<style>
  /* the beta's element layer: pinned to the source, never intercepting anything */
  #scene { position: fixed; inset: 0; pointer-events: none; z-index: 5; }
  #gone {
    position: fixed; left: 0; right: 0; top: 0; z-index: 99;
    padding: 8px 12px; font: 600 14px/1.3 'Segoe UI', sans-serif;
    color: #fff; background: rgba(180, 30, 30, 0.92);
  }
  .sc-node { position: absolute; }
  .sc-image { display: block; object-fit: contain; }
  .sc-text { white-space: pre-wrap; }
</style>
<body>
<div id="zone"></div>
<div id="scene"></div>
<div id="fx"></div>
<script>
(function () {
  'use strict'
  var p = new URLSearchParams(location.search)
  var channel = (p.get('channel') || '').toLowerCase()
  var profile = p.get('profile') || ''
  var preview = p.get('preview') === '1'
  var editMode = p.get('edit') === '1'
  // the beta editor uses this page as the backdrop under its own canvas, and draws the elements
  // itself — without this they would be drawn twice, once live and once under the handles
  var noScene = p.get('noscene') === '1'
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
    plateGlowSize: 0, plateGlowColor: '#a970ff', plateBlur: 0, plateSaturate: 100, plateGloss: 0, plateEdgeBlur: 0,
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
    nickPaint: true,
    hlFirstMsg: false, hlFirstMsgColor: '#7a5cff', hlFirstMsgLabel: '',
    hlFirstStream: false, hlFirstStreamColor: '#12b886', hlFirstStreamLabel: '',
    hlFirstMode: 'border', hlFirstSize: 2, hlFirstOpacity: 0.35, hlFirstLabel: false, hlFirstPulse: false,
    decors: [], triggers: [], triggerPreviewId: null, hiddenUsers: [],
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
  /**
   * The same outline, shadow and glow as textShadow(), but as FILTERS.
   *
   * This is what a painted nick needs, and the reason the paints looked like solid coloured bars.
   * A 7TV paint is the element's background clipped to the glyphs, and backgrounds paint BELOW
   * text shadows. The outline is a ring of zero-blur copies of the text in every direction, so
   * their union covers the letters completely — it painted right over the paint, and the glyphs
   * themselves are transparent, so what reached the screen was a solid outline-coloured blob the
   * shape of the name. With the default black outline that read as "the 7TV nicks are black".
   *
   * A filter runs on the finished element instead, so the paint stays on top and still gets its
   * outline. Four zero-blur drop-shadows are enough for a square dilation: each one shadows the
   * result of the previous, so the horizontal pair widens the shape and the vertical pair then
   * grows the already-widened shape into the corners.
   */
  function paintedNickFilter(own) {
    var parts = own ? [own] : []
    var w = cfg.outlineWidth
    if (w > 0) {
      parts.push('drop-shadow(' + w + 'px 0 0 ' + cfg.outlineColor + ')')
      parts.push('drop-shadow(-' + w + 'px 0 0 ' + cfg.outlineColor + ')')
      parts.push('drop-shadow(0 ' + w + 'px 0 ' + cfg.outlineColor + ')')
      parts.push('drop-shadow(0 -' + w + 'px 0 ' + cfg.outlineColor + ')')
    }
    if (cfg.shadowBlur > 0) parts.push('drop-shadow(0 2px ' + cfg.shadowBlur + 'px ' + cfg.shadowColor + ')')
    if (cfg.glowSize > 0) parts.push('drop-shadow(0 0 ' + cfg.glowSize + 'px ' + cfg.glowColor + ')')
    return parts.join(' ')
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
    /**
     * Two nested elements, and the split is the whole point.
     *
     * clip-path is applied to the element AFTER its filters, so a drop-shadow grown around a
     * clipped shape is cut away by the very same shape. The notch plate drew its border and its
     * glow exactly that way and neither of them ever reached the screen — measured at 18 stray
     * pixels against 772 for the same border on a rectangle.
     *
     * So the shape lives on the inner element and the filters on the outer one, which has no clip
     * of its own: the outer renders the already-clipped octagon and grows the shadow around it.
     * Slant needs the same split for the mark's own drop-shadows, and gets it for free.
     */
    var paint = layer.querySelector(':scope > .plate-shape')
    if (!paint) {
      paint = document.createElement('div')
      paint.className = 'plate-shape'
      layer.appendChild(paint)
    }
    layer.style.filter = ''
    el.classList.add('shaped')
    var s = cfg.plateShapeSize == null ? 12 : cfg.plateShapeSize
    var bcol = hexToRgba(cfg.plateBorderColor, cfg.plateBorderOpacity == null ? 1 : cfg.plateBorderOpacity)
    // fill + optional custom image stacked as multiple backgrounds
    var bg = fill(cfg.plateBg)
    var imgs = []
    if (cfg.plateImage) imgs.push("url('" + cfg.plateImage + "')")
    if (bg.indexOf('gradient') !== -1) imgs.push(bg)
    paint.style.backgroundColor = bg.indexOf('gradient') === -1 ? bg : 'transparent'
    paint.style.backgroundImage = imgs.join(', ')
    paint.style.backgroundSize = cfg.plateImageFit === 'contain' ? 'contain' : cfg.plateImageFit === 'stretch' ? '100% 100%' : 'cover'
    paint.style.backgroundPosition = 'center'
    paint.style.backgroundRepeat = 'no-repeat'
    paint.style.opacity = ''
    var r = cfg.plateRadius || [8, 8, 8, 8]
    if (cfg.plateShape === 'slant') {
      // shape size = skew strength (px of horizontal drift, converted to an angle-ish skew)
      var deg = Math.max(-45, Math.min(45, s))
      paint.style.transform = 'skewX(' + -deg + 'deg)'
      paint.style.clipPath = ''
      paint.style.borderRadius = r[0] + 'px ' + r[1] + 'px ' + r[2] + 'px ' + r[3] + 'px'
      paint.style.border = cfg.plateBorderWidth > 0 ? cfg.plateBorderWidth + 'px ' + cfg.plateBorderStyle + ' ' + bcol : ''
      var sh = []
      if (cfg.plateShadowBlur > 0) sh.push((cfg.plateShadowX || 0) + 'px ' + (cfg.plateShadowY == null ? 2 : cfg.plateShadowY) + 'px ' + cfg.plateShadowBlur + 'px ' + cfg.plateShadowColor)
      if (cfg.plateGlowSize > 0) { sh.push('0 0 ' + cfg.plateGlowSize + 'px ' + cfg.plateGlowColor); sh.push('0 0 ' + cfg.plateGlowSize * 2 + 'px ' + cfg.plateGlowColor) }
      paint.style.boxShadow = sh.length ? sh.join(', ') : ''
      // the animated border effect runs on the painted element (its border/glow are the visible ones)
      paint.style.animation = cfg.plateAnim && cfg.plateAnim !== 'none'
        ? 'pa-fx ' + (cfg.plateAnimSpeed || 2) + 's infinite ' + (cfg.plateAnim === 'blink' ? 'step-end' : 'linear')
        : ''
    } else {
      // notch: octagon clip on the inner element; outline + glow as drop-shadows on the OUTER one,
      // where the clip can no longer cut them off
      paint.style.transform = ''
      paint.style.borderRadius = ''
      paint.style.border = ''
      paint.style.boxShadow = ''
      paint.style.animation = ''
      paint.style.clipPath = shapeClip('notch')
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
    // frosted glass behind the plate: blur + a saturation boost is what separates "grey box"
    // from "pane of glass", and the gloss layer adds the diagonal sheen + lit top edge
    var bf = []
    if (active && cfg.plateBlur > 0) bf.push('blur(' + cfg.plateBlur + 'px)')
    if (active && cfg.plateSaturate && cfg.plateSaturate !== 100) bf.push('saturate(' + cfg.plateSaturate + '%)')
    el.style.backdropFilter = bf.length ? bf.join(' ') : ''
    el.style.webkitBackdropFilter = el.style.backdropFilter
    var gloss = active ? (cfg.plateGloss || 0) / 100 : 0
    el.classList.toggle('has-gloss', gloss > 0)
    if (gloss > 0) {
      el.style.setProperty('--gloss', String(gloss))
      // a lit top edge and a shaded bottom one — the tell-tale of a glass surface
      var extra = 'inset 0 1px 0 rgba(255,255,255,' + (0.75 * gloss).toFixed(3) + '), inset 0 -1px 0 rgba(255,255,255,' + (0.18 * gloss).toFixed(3) + ')'
      el.style.boxShadow = el.style.boxShadow ? el.style.boxShadow + ', ' + extra : extra
    } else {
      el.style.removeProperty('--gloss')
    }
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

  /**
   * Which of the three marks are on.
   *
   * They used to be one single-choice field, so an overlay that only carries hlFirstMode is read
   * through it and keeps the look it had. The editor writes all three the moment one is touched.
   */
  function firstFx() {
    if (cfg.hlFirstBorder != null || cfg.hlFirstGlow != null || cfg.hlFirstFill != null) {
      return { border: !!cfg.hlFirstBorder, glow: !!cfg.hlFirstGlow, fill: !!cfg.hlFirstFill }
    }
    var m = cfg.hlFirstMode || 'border'
    return {
      border: m === 'border' || m === 'both',
      glow: m === 'glow' || m === 'both',
      fill: m === 'tint' || m === 'plate'
    }
  }

  /**
   * Mark a first message ON the plate the overlay already has.
   *
   * The mark has to survive whatever the plate is, and that is the whole difficulty: the plate
   * has three different ways of drawing itself, and painting onto the element works for only one
   * of them.
   *
   *   slant / notch   the visuals live on a .plate-bg layer and the .shaped rule wipes the
   *                   element's own background and box-shadow with !important. A fill or a glow
   *                   set here was thrown away — which is exactly what "does not work on some
   *                   presets" was. Those marks go onto that layer instead, as extra backgrounds
   *                   and extra drop-shadows, so they take the polygon's real silhouette.
   *   picture plate   the image is a ::before, so a background set on the element is behind it.
   *                   The fill is therefore its own layer, placed last so it covers the picture.
   *   mask / feather  a mask clips the element's outline and shadow away with everything else,
   *                   so the frame and the glow move to the wrapper, which hugs the same box.
   *
   * When there is no plate at all the mark has nothing to be a frame around — it would shrink to
   * the letters and read as an accident — so it borrows a little padding and a radius first.
   */
  function markFirst(el, wrap, color, label) {
    var fx = firstFx()
    var size = cfg.hlFirstSize == null ? 2 : cfg.hlFirstSize
    // the glow gets its own number: a 2px frame next to a 40px halo is a perfectly reasonable
    // thing to want, and one slider driving both could never say it
    var glow = cfg.hlFirstGlowSize == null ? size * 4 : cfg.hlFirstGlowSize
    var op = cfg.hlFirstOpacity == null ? 0.35 : cfg.hlFirstOpacity
    var boxed = cfg.plateMode === 'fit' || cfg.plateMode === 'line'
    var shape = el.querySelector(':scope > .plate-bg')
    // the shaped plate paints on its inner element and filters on the outer one — the fill has to
    // land on the paint, the frame and the glow on the filters
    var paint = shape ? shape.querySelector(':scope > .plate-shape') : null
    var masked = boxed && !shape && (cfg.plateMask || cfg.plateEdgeBlur > 0)
    el.classList.add('firsthl')
    if (!boxed && (fx.border || fx.fill)) {
      el.style.padding = '2px 7px'
      el.style.borderRadius = '6px'
    }
    if (cfg.hlFirstTextColor) {
      // the message text only: the nick carries who somebody is, and repainting it would throw
      // away their own colour or their 7TV paint
      var body = el.querySelector('.body')
      if (body) body.style.color = cfg.hlFirstTextColor
      var sys = el.querySelector('.sysline')
      if (sys) sys.style.color = cfg.hlFirstTextColor
    }
    if (fx.fill) {
      var wash = hexToRgba(color, op)
      if (paint) {
        var grad = 'linear-gradient(' + wash + ', ' + wash + ')'
        paint.style.backgroundImage = paint.style.backgroundImage
          ? grad + ', ' + paint.style.backgroundImage
          : grad
      } else {
        var bg = document.createElement('div')
        bg.className = 'firsthl-bg'
        bg.style.background = wash
        // last of the negative-z children, so it covers the plate's own picture as well
        el.appendChild(bg)
      }
    }
    if (fx.border || fx.glow) {
      if (shape) {
        // the silhouette is a polygon: an outline would trace the element's rectangle instead.
        // Four tight drop-shadows grow the shape itself, the same trick the painted nicks use
        var f = []
        if (fx.border) {
          f.push('drop-shadow(' + size + 'px 0 0 ' + color + ')')
          f.push('drop-shadow(-' + size + 'px 0 0 ' + color + ')')
          f.push('drop-shadow(0 ' + size + 'px 0 ' + color + ')')
          f.push('drop-shadow(0 -' + size + 'px 0 ' + color + ')')
        }
        if (fx.glow) f.push('drop-shadow(0 0 ' + glow + 'px ' + color + ')')
        shape.style.filter = shape.style.filter ? shape.style.filter + ' ' + f.join(' ') : f.join(' ')
      } else {
        var host = el
        if (masked) {
          host = document.createElement('div')
          host.className = 'firsthl-ring'
          // the wrapper has no radius of its own — borrow the plate's so the ring still fits it
          host.style.borderRadius = el.style.borderRadius
          wrap.appendChild(host)
        }
        // an outline, not a border: it sits OUTSIDE the box, so it never eats a pixel of the
        // plate's own design, never changes the message's size, and Chromium bends it around the
        // plate's border-radius on its own
        if (fx.border) {
          host.style.outline = size + 'px solid ' + color
          host.style.outlineOffset = '0px'
        }
        if (fx.glow) {
          host.style.boxShadow = '0 0 ' + glow + 'px ' + color + ', 0 0 ' + glow * 2 + 'px ' + color +
            (host.style.boxShadow ? ', ' + host.style.boxShadow : '')
        }
      }
    }
    if (cfg.hlFirstPulse) {
      // animation is a LIST — appended, so a plate that already animates keeps doing so
      var pulse = 'fhl-pulse 1.6s ease-in-out 4'
      el.style.animation = el.style.animation ? el.style.animation + ', ' + pulse : pulse
    }
    if (cfg.hlFirstLabel && label) {
      var cap = document.createElement('div')
      cap.className = 'firstcap'
      cap.textContent = label
      cap.style.color = color
      el.insertBefore(cap, el.firstChild)
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
      if (customBadge) badges.appendChild(makeBadgeNode(customBadge))
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
        // replacement: the exact "set/version" key (specific predictions variant) beats
        // the kind-wide key ("predictions" = every variant)
        var ver = d.badgeVers ? d.badgeVers[i] : null
        var rep = null
        if (setId && cfg.badgeReplace) {
          if (ver && cfg.badgeReplace[setId + '/' + ver]) rep = cfg.badgeReplace[setId + '/' + ver]
          else if (cfg.badgeReplace[setId]) rep = cfg.badgeReplace[setId]
        }
        badges.appendChild(makeBadgeNode(rep || d.badges[i]))
      }
      if (!badges.childNodes.length) badges = null
    }
    var nick = document.createElement('span')
    nick.className = 'nick'
    nick.textContent = cfg.nickTransform === 'upper' ? d.nick.toUpperCase() : cfg.nickTransform === 'lower' ? d.nick.toLowerCase() : d.nick
    nick.style.fontWeight = cfg.nickBold ? '700' : '400'
    nick.style.fontStyle = cfg.nickItalic ? 'italic' : 'normal'
    nick.style.fontSize = cfg.nickScale !== 100 ? (cfg.nickScale / 100) + 'em' : ''
    if (cfg.nickPaint !== false && cfg.nickColorMode === 'twitch' && d.paint) {
      // the text is about to be made transparent so the paint shows through it, so the paint has
      // to be complete: a URL paint without its size and repeat paints nothing, and an invisible
      // nick is exactly what "the 7TV nicks are black" looked like
      nick.style.background = d.paint
      if (d.paintSize) nick.style.backgroundSize = d.paintSize
      if (d.paintRepeat) nick.style.backgroundRepeat = d.paintRepeat
      nick.style.webkitBackgroundClip = 'text'
      nick.style.backgroundClip = 'text'
      nick.style.color = 'transparent'
      nick.style.webkitTextFillColor = 'transparent'
      // and the line's text-shadow has to go: see paintedNickFilter
      nick.style.textShadow = 'none'
      var pf = paintedNickFilter(d.paintShadow)
      if (pf) nick.style.filter = pf
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

  /**
   * A badge is normally an image, but a replacement may instead be plain TEXT — stored with a
   * "text:" prefix so the existing {setId: string} config shape didn't have to change. Text
   * badges render as a small pill sized off the same badge-size control.
   */
  function makeBadgeNode(src) {
    var str = String(src || '')
    if (str.indexOf('text:') === 0) {
      var sp = document.createElement('span')
      sp.className = 'badge-text'
      sp.textContent = str.slice(5)
      sp.style.fontSize = Math.max(8, Math.round(cfg.badgeSize * 0.8)) + 'px'
      sp.style.lineHeight = cfg.badgeSize + 'px'
      return sp
    }
    var img = document.createElement('img')
    img.src = str
    img.style.height = cfg.badgeSize + 'px'
    return img
  }

  /**
   * Draw the beta's TEMPLATE elements inside one message plate.
   *
   * The host is the box that hugs the plate — the same one decorations anchor to — so an element
   * pinned to the right edge is pinned to the edge of THIS message, whatever length it turned
   * out to be. That is the whole reason the template is a separate space from the scene: there
   * are thirty of these on screen and they all move.
   *
   * Fields are filled from the line rather than being separate node kinds, because the only
   * thing that differs between a nick and a timestamp is which string to read. The message body
   * is the one that goes in as HTML: it is already built and escaped upstream, emotes and all,
   * and re-escaping it here would print the tags.
   *
   * NOTE: no backticks anywhere in here. This whole page is a TypeScript template literal, and
   * one of them ends it — which is exactly how this function failed to compile the first time.
   */
  function hasTemplate() {
    var c = cfg.sceneCompiled
    return !noScene && !!c && !!c.template && c.template.length > 0
  }

  function addTemplateNodes(host, d) {
    var compiled = cfg.sceneCompiled
    if (!hasTemplate()) return
    for (var i = 0; i < compiled.template.length; i++) {
      var n = compiled.template[i]
      if (n.hidden || n.kind === 'group') continue
      if (n.kind === 'trigger') continue // word triggers are not placed, they are provoked
      var el
      if (n.kind === 'image' || n.kind === 'avatar') {
        el = document.createElement('img')
        if (n.kind === 'image') { if (n.image) el.src = n.image }
        else if (d.avatar) el.src = d.avatar
      } else if (n.kind === 'badges') {
        el = document.createElement('div')
        el.style.display = 'flex'
        el.style.flexDirection = n.direction || 'row'
        el.style.gap = (n.gap || 0) + 'px'
        var list = d.badges || []
        for (var b = 0; b < list.length; b++) {
          var bi = document.createElement('img')
          bi.src = list[b]
          bi.style.width = (n.itemSize || 18) + 'px'
          bi.style.height = (n.itemSize || 18) + 'px'
          el.appendChild(bi)
        }
      } else if (n.kind === 'text') {
        el = document.createElement('div')
        if (n.bind === 'message') el.innerHTML = d.body || ''
        else if (n.bind === 'nick') el.textContent = d.nick || ''
        else if (n.bind === 'timestamp') el.textContent = fmtTs(d.ts)
        else if (n.bind === 'channel') el.textContent = channel
        else if (n.bind === 'event') el.textContent = d.sys || ''
        else el.textContent = n.text || ''
        if (n.bind === 'nick' && n.useChatColor) el.style.color = nickColorFor(d)
        if (n.maxLines) {
          el.style.display = '-webkit-box'
          el.style.webkitBoxOrient = 'vertical'
          el.style.webkitLineClamp = String(n.maxLines)
          el.style.overflow = 'hidden'
        }
      } else {
        el = document.createElement('div')
      }
      el.className = 'sc-node sc-' + n.kind
      el.dataset.node = n.id
      for (var k in n.css) {
        if (n.css[k] === undefined || n.css[k] === null) continue
        try { el.style[k] = n.css[k] } catch (err) { /* a property this build does not know */ }
      }
      host.appendChild(el)
    }
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
      /**
       * /me action: the writer's own colour, and their own paint if they have one.
       *
       * The line already wears their nick two words earlier; tinting the action with a flat
       * approximation of the gradient right beside the gradient itself is the odd one out. The
       * text-shadow has to go for the same reason it goes on the nick — it is drawn over the
       * clipped paint — but there is no filter here: a filter would put a halo around every emote
       * in the message as well.
       */
      if (d.act && cfg.meStyle !== 'plain') {
        if (cfg.nickPaint !== false && cfg.nickColorMode === 'twitch' && d.paint) {
          text.style.background = d.paint
          if (d.paintSize) text.style.backgroundSize = d.paintSize
          if (d.paintRepeat) text.style.backgroundRepeat = d.paintRepeat
          text.style.webkitBackgroundClip = 'text'
          text.style.backgroundClip = 'text'
          text.style.color = 'transparent'
          text.style.webkitTextFillColor = 'transparent'
          text.style.textShadow = 'none'
        } else {
          text.style.color = nickColorFor(d)
        }
      }
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
    /**
     * First-message marks. After the wrapper exists, because a masked plate needs it.
     *
     * The first-EVER one wins, and it has to: somebody's first words in the channel are also,
     * always, their first words this stream. Letting the per-stream mark take them showed the
     * streamer the smaller of the two facts and hid the bigger one — a brand new viewer looked
     * exactly like a regular who had just come back.
     *
     * So "first this stream" means first today and NOT their first ever, which is what the app's
     * own highlight rules have always meant by it. A newcomer therefore belongs to the other
     * category even when only this one is switched on, rather than being quietly mislabelled.
     */
    if (d.kind === 'msg') {
      if (cfg.hlFirstMsg && d.firstMsg) markFirst(content, wrap, cfg.hlFirstMsgColor, cfg.hlFirstMsgLabel)
      else if (cfg.hlFirstStream && d.firstStream && !d.firstMsg) markFirst(content, wrap, cfg.hlFirstStreamColor, cfg.hlFirstStreamLabel)
    }
    addDecors(wrap, 'message')
    // A template REPLACES the classic plate contents rather than sitting over them. Drawing both
    // was the first thing anyone noticed: every nick and every message appeared twice, once where
    // the old settings put it and once where the editor did.
    if (hasTemplate()) {
      content.style.display = 'none'
      wrap.style.width = 'fit-content'
    }
    addTemplateNodes(wrap, d)

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
    // page-flip mode: queue new lines while a flip is mid-flight
    var pageFlipping = cfg.pageFlip && !creditsActive() && !restyling && d.kind !== undefined
    if (pageFlipping && flipping) { flipQueue.push(d); return }
    lines.push(d)
    if (lines.length > cfg.maxMessages + 10) lines.splice(0, lines.length - cfg.maxMessages - 10)
    var el = assemble(d)
    if (cfg.direction === 'down') zone.insertBefore(el, zone.firstChild)
    else zone.appendChild(el)
    // page-flip: the sheet fills by HEIGHT, not message count. Measuring the zone's own box
    // (scrollHeight vs clientHeight) means a fixed-size "page" flips exactly when the newest
    // line overflows it — so a single long message can't spill past the edge. We keep the
    // line on-page only if the page was empty (nothing to flip a lone giant message onto).
    if (pageFlipping) {
      var others = realLineEls().length - 1
      if (others >= 1 && zone.scrollHeight > zone.clientHeight + 1) {
        var oip = indexOfEl(el)
        if (oip !== -1) lines.splice(oip, 1)
        el.remove()
        doPageFlip(d)
        return
      }
    }
    if (!pageFlipping && creditsActive()) {
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
    if (!restyling && d.kind === 'msg' && cfg.triggers && cfg.triggers.length) {
      var tl = String(d.text || '').toLowerCase()
      var nickl = String(d.login || d.nick || '').toLowerCase()
      // ONE reaction per message, and the winner is decided by the MESSAGE, not by the order
      // the triggers were added: whichever trigger word appears EARLIEST in the text fires.
      // With rules on "!" and "?", "привіт? ок!" fires "?" while "ок! так?" fires "!".
      // A nick match sorts before everything (the nick precedes the text); ties keep list order.
      var best = null, bestAt = Infinity
      for (var ti = 0; ti < cfg.triggers.length; ti++) {
        var tg = cfg.triggers[ti]
        if (!tg.image) continue
        var at = Infinity
        var on = tg.on || 'word'
        if (on !== 'word') {
          // A reaction to the OCCASION rather than to a word. It beats every word match, because
          // it is a fact about the whole message rather than about something inside it — and the
          // first-ever case takes precedence over first-this-stream for the same reason the mark
          // does: it is always both, and the bigger fact is the one worth reacting to.
          if (on === 'firstMsg' ? !d.firstMsg : !(d.firstStream && !d.firstMsg)) continue
          at = -2
        } else {
          if (!tg.word || !d.text) continue
          // one trigger can hold MANY words/phrases/nicks — one per line
          // NB: this whole page lives in a TS template literal — regex escapes like \\n get
          // mangled there, so split on the raw newline char code instead
          var words = String(tg.word).split(String.fromCharCode(10))
          for (var wi = 0; wi < words.length; wi++) {
            var w = words[wi].trim().toLowerCase()
            if (!w) continue
            var asNick = w.replace(/^@/, '')
            if (asNick && nickl === asNick) { at = -1; break }
            var idx = tl.indexOf(w)
            if (idx !== -1 && idx < at) at = idx
          }
        }
        if (at < bestAt) { bestAt = at; best = tg }
      }
      if (best) spawnTrigger(best, el.querySelector(':scope > .cwrap'))
    }
    scheduleFit()
  }

  var fxBox = document.getElementById('fx')
  var sceneBox = document.getElementById('scene')

  var goneBox = null
  function gone(on) {
    if (!on) {
      if (goneBox) { goneBox.remove(); goneBox = null }
      return
    }
    if (goneBox) return
    goneBox = document.createElement('div')
    goneBox.id = 'gone'
    goneBox.textContent = 'Цей оверлей видалено в StickiChat. Онови URL джерела в OBS.'
    document.body.appendChild(goneBox)
  }

  /**
   * Draw the beta's scene-space elements.
   *
   * The nodes arrive already compiled — a style object per element — because the placement maths
   * lives in the app, where the editor's canvas uses the very same function. Two implementations
   * would drift, and a preview that lies about where something will be is worse than none.
   *
   * Rebuilt wholesale on every config change. There are a handful of these, they change only when
   * somebody is editing, and a diff would buy nothing but a chance to be subtly wrong.
   */
  function applyScene() {
    var compiled = cfg.sceneCompiled
    sceneBox.textContent = ''
    if (noScene) return
    if (!compiled || !compiled.scene || !compiled.scene.length) return
    for (var i = 0; i < compiled.scene.length; i++) {
      var n = compiled.scene[i]
      if (n.hidden) continue
      // a trigger is not drawn until its word turns up in a message
      if (n.kind === 'trigger') continue
      var el = n.kind === 'image' ? document.createElement('img') : document.createElement('div')
      el.className = 'sc-node sc-' + n.kind
      el.dataset.node = n.id
      if (n.kind === 'image' && n.image) el.src = n.image
      if (n.kind === 'text') el.textContent = n.bind === 'static' ? (n.text || '') : ''
      for (var k in n.css) {
        if (n.css[k] === undefined || n.css[k] === null) continue
        try { el.style[k] = n.css[k] } catch (err) { /* a property this build does not know */ }
      }
      sceneBox.appendChild(el)
    }
  }
  var activeTriggers = {}
  /**
   * Apply a trigger's size/anchor/offsets to its box. Split out of spawnTrigger so the LIVE
   * position preview can re-apply it on every config push without rebuilding the element —
   * rebuilding replayed the entrance animation, which read as the image blinking away every
   * time the editor pushed an update (i.e. on every keystroke while nudging the offsets).
   */
  function positionTrigger(box, tg, onMessage) {
    box.style.width = (tg.size || 96) + 'px'
    var dx = (tg.dx || 0) + 'px', dy = (tg.dy || 0) + 'px'
    var p = tg.pos || 'br'
    // clear whatever the previous position set, or old anchors linger and fight the new ones
    box.style.left = box.style.right = box.style.top = box.style.bottom = ''
    box.style.marginLeft = box.style.marginRight = ''
    box.style.translate = ''
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
      if (p === 'bl' || p === 'br' || p === 'bottom') box.style.bottom = (tg.dy || 0) + 'px'
      else if (p === 'left' || p === 'right') {
        box.style.top = 'calc(50% + ' + (tg.dy || 0) + 'px)'
        box.style.translate = '0 -50%'
      } else box.style.top = (tg.dy || 0) + 'px'
      box.style.zIndex = '5'
    } else if (p === 'tl') { box.style.left = dx; box.style.top = dy }
    else if (p === 'tr') { box.style.right = dx; box.style.top = dy }
    else if (p === 'bl') { box.style.left = dx; box.style.bottom = dy }
    else if (p === 'br') { box.style.right = dx; box.style.bottom = dy }
    else if (p === 'top') { box.style.left = 'calc(50% + ' + dx + ')'; box.style.top = dy; box.style.translate = '-50% 0' }
    else if (p === 'bottom') { box.style.left = 'calc(50% + ' + dx + ')'; box.style.bottom = dy; box.style.translate = '-50% 0' }
    else if (p === 'left') { box.style.left = dx; box.style.top = 'calc(50% + ' + dy + ')'; box.style.translate = '0 -50%' }
    else { box.style.right = dx; box.style.top = 'calc(50% + ' + dy + ')'; box.style.translate = '0 -50%' }
    // slide direction: from the nearest horizontal edge
    box.style.setProperty('--tx', p === 'tl' || p === 'left' || p === 'bl' ? '-60px' : '60px')
  }

  function spawnTrigger(tg, wrap) {
    var onMessage = tg.attach === 'message' && wrap
    if (!onMessage && tg.id !== '__preview__') {
      if (activeTriggers[tg.id]) return // one instance of a screen trigger at a time
      activeTriggers[tg.id] = true
    }
    var box = document.createElement('div')
    box.className = 'tgi'
    positionTrigger(box, tg, onMessage)
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

  // ---------- live position preview for the trigger being edited ----------
  // The box is created ONCE and then only re-styled, so dragging the offsets/size moves and
  // scales it smoothly instead of making it vanish and pop back on every config push.
  var previewBox = null
  var previewId = null
  function syncTriggerPreview() {
    var id = cfg.triggerPreviewId
    var tg = null
    for (var i = 0; id && i < (cfg.triggers || []).length; i++) {
      if (cfg.triggers[i].id === id) { tg = cfg.triggers[i]; break }
    }
    if (!tg || !tg.image) {
      if (previewBox) previewBox.remove()
      previewBox = null
      previewId = null
      return
    }
    var lines = realLineEls()
    var wrap = lines.length ? lines[lines.length - 1].querySelector(':scope > .cwrap') : null
    var onMessage = tg.attach === 'message' && !!wrap
    var host = onMessage ? wrap : fxBox
    // rebuild only when it's really gone (a restyle wipes the lines) or points elsewhere
    if (!previewBox || !previewBox.isConnected || previewId !== id || previewBox.parentNode !== host) {
      if (previewBox) previewBox.remove()
      previewBox = document.createElement('div')
      previewBox.className = 'tgi tgi-preview'
      previewBox.appendChild(document.createElement('img'))
      host.appendChild(previewBox)
      previewId = id
    }
    var pimg = previewBox.firstChild
    if (pimg.getAttribute('src') !== tg.image) pimg.setAttribute('src', tg.image)
    // skip only the ENTRANCE animation (replaying it on every push is what made the image
    // blink); the idle bob stays so the preview matches the real reaction's resting look
    previewBox.style.animation = 'none'
    previewBox.style.opacity = '1'
    pimg.style.animation = 'tg-bob 2.2s ease-in-out 0.6s infinite'
    positionTrigger(previewBox, tg, onMessage)
  }

  // ---------- config application ----------
  function applyCfg() {
    applyScene()
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
    zone.style.setProperty('--gif-h', (cfg.gifMaxHeight || 120) + 'px')

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
    // re-pin the trigger under edit so its offsets update live while the user drags them
    syncTriggerPreview()
  }

  // ---------- SSE ----------
  function connect() {
    var es = new EventSource('/events?channel=' + encodeURIComponent(channel) + '&profile=' + encodeURIComponent(profile))
    es.addEventListener('cfg', function (e) {
      try { cfg = Object.assign(cfg, JSON.parse(e.data)); gone(false); applyCfg() } catch (err) { /* noop */ }
    })
    /**
     * This source points at an overlay that no longer exists.
     *
     * Silence here is what made deleting an overlay so confusing: the source kept whatever look
     * it last received and appeared to have become a different overlay. Better to say it, in the
     * source itself, where the person looking for the problem actually is.
     */
    es.addEventListener('gone', function () { gone(true) })
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
      // two of the samples carry the first-message flags, so the marks can be dialled in while
      // looking at them instead of waiting for a stranger to turn up on stream
      { nick: 'Bobik069', color: '#ff69b4', badges: [BADGE_MOD], body: 'привіт чат! <img class="emoji-img" src="https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/1f49c.png">', av: 'B', first: 'msg' },
      { nick: 'Pinuses', color: '#5cb2ff', badges: [], body: 'that timing was clean <img class="emote" src="' + EMOTE + '">', av: 'P', first: 'stream' },
      { nick: 'Meme_gavgav', color: '#7cff5c', badges: [BADGE_VIP], body: 'гав гав гав <img class="emoji-img" src="https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/1f436.png">', av: 'M' },
      { nick: 'I_Love_Vladyslav', color: '#ffd75c', badges: [], body: 'Їжте щедрі ґрона! Quick brown fox 0123', av: 'I' },
      { nick: 'Ivan_In_My_Ass', color: '#ff8a5c', badges: [], body: 'хто тут головний по мемах?', av: 'I' },
      // one sample wears a 7TV paint, because a paint is a background clipped to the letters and
      // it is the one thing the outline and glow settings can quietly destroy — better to find
      // that out here than on stream
      { nick: 'n1cole_cat', color: '#5cffd7', badges: [BADGE_VIP], body: 'мур-мур <img class="emoji-img" src="https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/1f63a.png"> клас стрим', av: 'N', paint: 'linear-gradient(90deg, #ff5cae 0%, #ffd75c 50%, #5cffe0 100%)' },
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
        paint: s.paint,
        firstMsg: s.first === 'msg',
        firstStream: s.first === 'stream',
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

/**
 * The celebration overlay: emotes from chat scattering over the stream.
 *
 * Its own page rather than a mode of the chat one. They share only the SSE connection — this has
 * no lines, no plates and no layout, just a particle loop over absolutely positioned images, and
 * folding it into the chat page would ship a physics engine to every chat source.
 *
 * Animated emotes need nothing special: the url is the same GIF or WebP chat shows, and an <img>
 * plays it. That is also why the sprites are images and not a canvas — a canvas would have to
 * decode and step every animation by hand.
 *
 * NOTE: like every page here, this lives inside a TypeScript template literal. No backticks, and
 * no dollar-brace, anywhere below.
 */
const EMOTE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>StickiChat Emotes</title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  #stage { position: fixed; inset: 0; overflow: hidden; pointer-events: none; }
  .sp { position: absolute; left: 0; top: 0; will-change: transform, opacity; transform-origin: 50% 50%; }
  .sp img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .sp.shadow img { filter: drop-shadow(0 2px 6px rgba(0,0,0,.55)); }
  #gone { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); background: #b91c1c; color: #fff;
    font: 600 14px/1.4 Inter, Segoe UI, sans-serif; padding: 8px 14px; border-radius: 8px; }
</style>
</head>
<body>
<div id="stage"></div>
<script>
(function () {
  var p = new URLSearchParams(location.search)
  var channel = (p.get('channel') || '').toLowerCase()
  var profile = p.get('profile') || ''
  var preview = p.get('preview') === '1'
  var stage = document.getElementById('stage')

  var cfg = {
    onChat: true, minEmotes: 1, onBits: false, bitsMin: 100, onSubs: false, onRedeems: false,
    words: '', allowUsers: '', perMessage: 3, copies: 1, burstMax: 12,
    maxOnScreen: 60, lifetimeS: 0,
    sizeMin: 48, sizeMax: 96, opacity: 1, shadow: true, rainbow: false,
    motion: 'fall', from: 'top', speedMin: 60, speedMax: 160, spread: 30,
    gravity: 900, bounce: 0.55, spin: 90, wobble: 24, scaleIn: true, fadeOut: true
  }

  var sprites = []
  var W = window.innerWidth, H = window.innerHeight
  window.addEventListener('resize', function () { W = window.innerWidth; H = window.innerHeight })

  function rnd(a, b) { return a + Math.random() * (b - a) }
  function pick(list) { return list[Math.floor(Math.random() * list.length)] }

  /** where a sprite comes from, and which way it is heading, for the chosen motion */
  function launch(sp) {
    var size = sp.size
    var edge = cfg.from === 'random' ? pick(['top', 'bottom', 'left', 'right']) : cfg.from
    var speed = rnd(cfg.speedMin, cfg.speedMax)
    var spread = (cfg.spread || 0) * Math.PI / 180
    var ang
    if (cfg.motion === 'burst') {
      // everything leaves one point in every direction; the "from" setting picks the point
      if (edge === 'center') { sp.x = W / 2 - size / 2; sp.y = H / 2 - size / 2 }
      else if (edge === 'top') { sp.x = W / 2 - size / 2; sp.y = -size }
      else if (edge === 'bottom') { sp.x = W / 2 - size / 2; sp.y = H }
      else if (edge === 'left') { sp.x = -size; sp.y = H / 2 - size / 2 }
      else { sp.x = W; sp.y = H / 2 - size / 2 }
      ang = Math.random() * Math.PI * 2
    } else if (cfg.motion === 'rise') {
      sp.x = rnd(-size / 2, W - size / 2); sp.y = H + rnd(0, size)
      ang = -Math.PI / 2 + rnd(-spread, spread)
    } else if (cfg.motion === 'fall') {
      sp.x = rnd(-size / 2, W - size / 2); sp.y = -size - rnd(0, size)
      ang = Math.PI / 2 + rnd(-spread, spread)
    } else {
      // float / fly / physics all enter from an edge and head across
      if (edge === 'center') { sp.x = W / 2 - size / 2; sp.y = H / 2 - size / 2; ang = Math.random() * Math.PI * 2 }
      else if (edge === 'top') { sp.x = rnd(-size / 2, W - size / 2); sp.y = -size; ang = Math.PI / 2 + rnd(-spread, spread) }
      else if (edge === 'bottom') { sp.x = rnd(-size / 2, W - size / 2); sp.y = H; ang = -Math.PI / 2 + rnd(-spread, spread) }
      else if (edge === 'left') { sp.x = -size; sp.y = rnd(-size / 2, H - size / 2); ang = 0 + rnd(-spread, spread) }
      else { sp.x = W; sp.y = rnd(-size / 2, H - size / 2); ang = Math.PI + rnd(-spread, spread) }
    }
    sp.vx = Math.cos(ang) * speed
    sp.vy = Math.sin(ang) * speed
  }

  function spawn(url) {
    if (sprites.length >= cfg.maxOnScreen) {
      // the oldest leaves so the newest can arrive: a hard cap that drops the NEW one makes a
      // busy chat look broken exactly when it is busiest
      var old = sprites.shift()
      if (old) old.el.remove()
    }
    var size = Math.round(rnd(cfg.sizeMin, cfg.sizeMax))
    var el = document.createElement('div')
    el.className = 'sp' + (cfg.shadow ? ' shadow' : '')
    el.style.width = size + 'px'
    el.style.height = size + 'px'
    el.style.opacity = String(cfg.opacity == null ? 1 : cfg.opacity)
    var img = document.createElement('img')
    img.src = url
    img.alt = ''
    if (cfg.rainbow) img.style.filter = 'hue-rotate(' + Math.floor(Math.random() * 360) + 'deg)'
    el.appendChild(img)
    var sp = {
      el: el, size: size, x: 0, y: 0, vx: 0, vy: 0,
      rot: cfg.spin ? rnd(0, 360) : 0,
      vrot: cfg.spin ? rnd(-cfg.spin, cfg.spin) : 0,
      born: performance.now(),
      wobPhase: Math.random() * Math.PI * 2,
      scale: cfg.scaleIn ? 0.2 : 1
    }
    launch(sp)
    draw(sp)
    stage.appendChild(el)
    sprites.push(sp)
  }

  function draw(sp) {
    sp.el.style.transform = 'translate3d(' + sp.x.toFixed(1) + 'px,' + sp.y.toFixed(1) + 'px,0) rotate(' +
      sp.rot.toFixed(1) + 'deg) scale(' + sp.scale.toFixed(3) + ')'
  }

  var last = performance.now()
  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000)
    last = now
    var life = (cfg.lifetimeS || 0) * 1000
    for (var i = sprites.length - 1; i >= 0; i--) {
      var sp = sprites[i]
      var age = now - sp.born
      if (cfg.motion === 'physics') {
        sp.vy += cfg.gravity * dt
        sp.x += sp.vx * dt
        sp.y += sp.vy * dt
        var floor = H - sp.size
        if (sp.y > floor && sp.vy > 0) { sp.y = floor; sp.vy = -sp.vy * cfg.bounce; sp.vx *= 0.98 }
        if (sp.x < 0 && sp.vx < 0) { sp.x = 0; sp.vx = -sp.vx * cfg.bounce }
        if (sp.x > W - sp.size && sp.vx > 0) { sp.x = W - sp.size; sp.vx = -sp.vx * cfg.bounce }
      } else {
        sp.x += sp.vx * dt
        sp.y += sp.vy * dt
        if (cfg.wobble > 0) {
          sp.wobPhase += dt * 2
          sp.x += Math.sin(sp.wobPhase) * cfg.wobble * dt
        }
      }
      sp.rot += sp.vrot * dt
      if (sp.scale < 1) sp.scale = Math.min(1, sp.scale + dt * 4)
      // fade the last stretch of a timed life; an untimed sprite simply leaves the screen
      if (life > 0 && cfg.fadeOut) {
        var left = life - age
        if (left < 600) sp.el.style.opacity = String(Math.max(0, left / 600) * (cfg.opacity == null ? 1 : cfg.opacity))
      }
      draw(sp)
      var out = sp.y > H + sp.size * 2 || sp.y < -sp.size * 4 || sp.x < -sp.size * 3 || sp.x > W + sp.size * 3
      if ((life > 0 && age > life) || (life === 0 && out)) {
        sp.el.remove()
        sprites.splice(i, 1)
      }
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  function listOf(s) {
    var out = []
    var parts = String(s || '').split(String.fromCharCode(10))
    for (var i = 0; i < parts.length; i++) {
      var v = parts[i].trim().toLowerCase()
      if (v) out.push(v)
    }
    return out
  }

  /** does this line get to throw a party, and with how many emotes */
  function wanted(d) {
    if (d.kind !== 'msg') return null
    var allow = listOf(cfg.allowUsers)
    if (allow.length && allow.indexOf(String(d.login || '').toLowerCase()) === -1) return null
    var emotes = d.emotes || []
    var words = listOf(cfg.words)
    var hitWord = false
    if (words.length && d.text) {
      var tl = String(d.text).toLowerCase()
      for (var i = 0; i < words.length; i++) { if (tl.indexOf(words[i]) !== -1) { hitWord = true; break } }
    }
    var ok = false
    if (cfg.onChat && emotes.length >= (cfg.minEmotes || 1)) ok = true
    if (cfg.onBits && d.bits && (d.bitsAmount || 0) >= (cfg.bitsMin || 0)) ok = true
    if (cfg.onSubs && d.sub) ok = true
    if (cfg.onRedeems && d.redeem) ok = true
    if (hitWord) ok = true
    if (!ok) return null
    if (!emotes.length) return null
    return emotes.slice(0, Math.max(1, cfg.perMessage || 1))
  }

  function celebrate(d) {
    var list = wanted(d)
    if (!list) return
    var budget = Math.max(1, cfg.burstMax || 12)
    var n = 0
    for (var i = 0; i < list.length; i++) {
      for (var c = 0; c < Math.max(1, cfg.copies || 1); c++) {
        if (n >= budget) return
        spawn(list[i])
        n++
      }
    }
  }

  var goneBox = null
  function gone(on) {
    if (!on) { if (goneBox) { goneBox.remove(); goneBox = null } return }
    if (goneBox) return
    goneBox = document.createElement('div')
    goneBox.id = 'gone'
    goneBox.textContent = 'Цей оверлей видалено в StickiChat. Онови URL джерела в OBS.'
    document.body.appendChild(goneBox)
  }

  function connect() {
    var es = new EventSource('/events?channel=' + encodeURIComponent(channel) + '&profile=' + encodeURIComponent(profile))
    es.addEventListener('cfg', function (e) {
      try { cfg = Object.assign(cfg, JSON.parse(e.data)); gone(false) } catch (err) { /* noop */ }
    })
    es.addEventListener('gone', function () { gone(true) })
    es.onmessage = function (e) {
      try { celebrate(JSON.parse(e.data)) } catch (err) { /* noop */ }
    }
    es.onerror = function () { es.close(); setTimeout(connect, 3000) }
  }
  connect()

  if (preview) {
    var DEMO = [
      'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0',
      'https://static-cdn.jtvnw.net/emoticons/v2/1/default/dark/3.0',
      'https://static-cdn.jtvnw.net/emoticons/v2/88/default/dark/3.0',
      'https://static-cdn.jtvnw.net/emoticons/v2/354/default/dark/3.0'
    ]
    setInterval(function () {
      if (cfg.previewDemo === false) return
      celebrate({ kind: 'msg', login: 'demo', text: 'demo', emotes: [pick(DEMO), pick(DEMO)] })
    }, 900)
  }

  window.__oe = { cfg: cfg, spawn: spawn, celebrate: celebrate, sprites: sprites }
})()
</script>
</body>
</html>`

/**
 * The goal overlay: a bar, a ring or plain numbers, moving towards a target.
 *
 * The number itself is not worked out here. The app owns it — it polls Twitch for follower and
 * subscriber totals and adds up cheers it sees in chat — and pushes it down with the config. An
 * OBS source restarts whenever the scene does, and a counter that lived on the page would reset
 * with it; a bar that forgets what it was showing is worse than no bar.
 *
 * NOTE: same rule as every page here — no backticks, no dollar-brace.
 */
const GOAL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>StickiChat Goal</title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font-family: Inter, 'Segoe UI', sans-serif; }
  #wrap { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  #goal { position: relative; }
  #title { font-weight: 700; margin-bottom: 6px; }
  .bar { position: relative; overflow: hidden; box-sizing: border-box; }
  .track { position: absolute; inset: 0; }
  .fillbar { position: absolute; left: 0; top: 0; bottom: 0; width: 0; transition: width var(--anim, 600ms) cubic-bezier(.22,.9,.3,1); }
  .nums { position: relative; display: flex; align-items: center; justify-content: center; height: 100%;
    font-variant-numeric: tabular-nums; font-weight: 700; }
  .outside { text-align: center; margin-top: 6px; font-variant-numeric: tabular-nums; font-weight: 700; }
  svg { display: block; overflow: visible; }
  .ringnums { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
    justify-content: center; font-variant-numeric: tabular-nums; font-weight: 700; }
  @keyframes goal-pulse { 0%, 100% { transform: scale(1) } 45% { transform: scale(1.045) } }
  @keyframes goal-pop { 0% { transform: scale(1) } 30% { transform: scale(1.14) } 60% { transform: scale(0.97) } 100% { transform: scale(1) } }
  @keyframes goal-shake { 0%, 100% { transform: translateX(0) } 20% { transform: translateX(-7px) } 40% { transform: translateX(6px) } 60% { transform: translateX(-4px) } 80% { transform: translateX(2px) } }
  @keyframes goal-flash { 0%, 100% { filter: none } 40% { filter: brightness(1.8) saturate(1.3) } }
  .gain-pulse { animation: goal-pulse 520ms ease-in-out; }
  .gain-pop { animation: goal-pop 480ms cubic-bezier(.2,1.4,.4,1); }
  .gain-shake { animation: goal-shake 460ms ease-in-out; }
  .gain-flash { animation: goal-flash 520ms ease-in-out; }
  /* the amount just gained, drifting up and away */
  @keyframes goal-rise { from { opacity: 0; transform: translate(-50%, 6px) scale(.8) } 20% { opacity: 1 }
    to { opacity: 0; transform: translate(-50%, -34px) scale(1.1) } }
  .gainlbl { position: absolute; left: 50%; top: -6px; transform: translateX(-50%); font-weight: 800;
    pointer-events: none; animation: goal-rise 1200ms ease-out forwards; text-shadow: 0 2px 6px rgba(0,0,0,.6); }
  /* pictures: beside the bar, inside it, or filling it */
  .goalrow { display: flex; align-items: center; gap: 10px; }
  .goalrow.col { flex-direction: column; }
  .goalimg { display: block; flex: 0 0 auto; object-fit: contain; }
  .inimg { position: absolute; top: 50%; transform: translateY(-50%); object-fit: contain; pointer-events: none; }
  .fillimg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
  #gone { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); background: #b91c1c; color: #fff;
    font: 600 14px/1.4 Inter, 'Segoe UI', sans-serif; padding: 8px 14px; border-radius: 8px; }
</style>
<style id="userCss"></style>
</head>
<body>
<div id="wrap"><div id="goal"></div></div>
<script>
(function () {
  var p = new URLSearchParams(location.search)
  var channel = (p.get('channel') || '').toLowerCase()
  var profile = p.get('profile') || ''
  var preview = p.get('preview') === '1'
  var host = document.getElementById('goal')
  var userCss = document.getElementById('userCss')

  var cfg = {
    metric: 'followers', source: 'auto', base: 0, target: 100, progress: 0, countGifts: true,
    title: 'Ціль', doneText: '', font: 'Inter', fontSize: 18, textColor: '#ffffff',
    numbers: 'both', showTitle: true, textInside: false,
    shape: 'bar', width: 420, height: 34, radius: 17, ringWidth: 14,
    customText: '',
    trackFill: { kind: 'solid', color: '#000000', opacity: 0.5 },
    barFill: { kind: 'gradient', color: '#9147ff', color2: '#5cffe0', angle: 90, opacity: 1 },
    doneFill: { kind: 'gradient', color: '#12b886', color2: '#c7f464', angle: 90, opacity: 1 },
    borderWidth: 0, borderColor: '#ffffff', glowSize: 0, glowColor: '#9147ff', fxFromFill: false,
    animMs: 600, pulseOnGain: true, gainFx: 'pulse', gainLabel: true, gainColor: '#ffe066',
    image: '', imagePlace: 'left', imageSize: 56, imageOpacity: 1, doneImage: '',
    customCss: ''
  }
  var lastValue = null

  function hexToRgba(hex, op) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
    if (!m) return 'rgba(0,0,0,' + (op == null ? 1 : op) + ')'
    var n = parseInt(m[1], 16)
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (op == null ? 1 : op) + ')'
  }
  function fill(f) {
    if (!f) return 'transparent'
    if (f.opacity <= 0) return 'transparent'
    if (f.kind === 'gradient') {
      return 'linear-gradient(' + (f.angle || 0) + 'deg, ' + hexToRgba(f.color, f.opacity) + ', ' + hexToRgba(f.color2, f.opacity) + ')'
    }
    return hexToRgba(f.color, f.opacity)
  }
  /** a gradient needs a single colour when it has to be an SVG stroke */
  function flat(f) { return hexToRgba(f && f.color, f && f.opacity == null ? 1 : f.opacity) }

  function value() { return Math.max(0, (cfg.progress || 0) - (cfg.base || 0)) }
  function target() { return Math.max(1, cfg.target || 1) }
  function ratio() { return Math.max(0, Math.min(1, value() / target())) }

  function numbersText() {
    var v = value(), t = target()
    var pct = Math.round(ratio() * 100)
    // the streamer's own wording wins, with the numbers written in wherever they put the tokens
    if (cfg.customText) {
      return String(cfg.customText)
        .split('{value}').join(String(v))
        .split('{target}').join(String(t))
        .split('{left}').join(String(Math.max(0, t - v)))
        .split('{percent}').join(pct + '%')
    }
    if (cfg.numbers === 'none') return ''
    if (cfg.numbers === 'percent') return pct + '%'
    if (cfg.numbers === 'value') return v + ' / ' + t
    return v + ' / ' + t + '  ·  ' + pct + '%'
  }

  /**
   * Wrap the bar (or the ring) with a picture beside it.
   *
   * The inside placements are handled by the caller because they belong to the bar's own box; the
   * ones out here need a row or a column around it, and the wrapper only appears when there is
   * actually something to put in it.
   */
  function placeAround(node, done) {
    var place = cfg.imagePlace
    if (!cfg.image && !(done && cfg.doneImage)) return node
    if (place !== 'left' && place !== 'right' && place !== 'above' && place !== 'below') return node
    var img = makeImage(done)
    if (!img) return node
    var row = document.createElement('div')
    row.className = 'goalrow' + (place === 'above' || place === 'below' ? ' col' : '')
    if (place === 'left' || place === 'above') { row.appendChild(img); row.appendChild(node) }
    else { row.appendChild(node); row.appendChild(img) }
    return row
  }

  /** the goal's picture, placed where the config says */
  function makeImage(done) {
    var src = done && cfg.doneImage ? cfg.doneImage : cfg.image
    if (!src) return null
    var img = document.createElement('img')
    img.src = src
    img.alt = ''
    img.style.opacity = String(cfg.imageOpacity == null ? 1 : cfg.imageOpacity)
    var s = cfg.imageSize || 56
    if (cfg.imagePlace === 'fill') {
      img.className = 'fillimg'
    } else if (cfg.imagePlace === 'inLeft' || cfg.imagePlace === 'inRight') {
      img.className = 'inimg'
      img.style.height = s + 'px'
      if (cfg.imagePlace === 'inLeft') img.style.left = '6px'
      else img.style.right = '6px'
    } else {
      img.className = 'goalimg'
      img.style.height = s + 'px'
      img.style.maxWidth = s * 2 + 'px'
    }
    return img
  }

  function render() {
    var done = value() >= target()
    var barCss = fill(done ? cfg.doneFill : cfg.barFill)
    host.style.font = (cfg.fontSize || 18) + 'px ' + (cfg.font ? "'" + cfg.font + "'" : 'Inter') + ', Inter, sans-serif'
    host.style.color = cfg.textColor || '#fff'
    host.style.setProperty('--anim', (cfg.animMs == null ? 600 : cfg.animMs) + 'ms')
    host.innerHTML = ''

    if (cfg.showTitle && cfg.title) {
      var t = document.createElement('div')
      t.id = 'title'
      t.textContent = cfg.title
      host.appendChild(t)
    }

    var label = done && cfg.doneText ? cfg.doneText : numbersText()

    if (cfg.shape === 'text') {
      var only = document.createElement('div')
      only.className = 'outside'
      only.style.marginTop = '0'
      only.style.fontSize = '1.4em'
      only.textContent = label
      host.appendChild(only)
    } else if (cfg.shape === 'ring') {
      var size = Math.max(40, cfg.width || 200)
      var sw = Math.max(2, cfg.ringWidth || 14)
      var r = (size - sw) / 2
      var c = 2 * Math.PI * r
      var box = document.createElement('div')
      box.style.position = 'relative'
      box.style.width = size + 'px'
      box.style.height = size + 'px'
      var ns = 'http://www.w3.org/2000/svg'
      var svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('width', String(size))
      svg.setAttribute('height', String(size))
      var bg = document.createElementNS(ns, 'circle')
      bg.setAttribute('cx', String(size / 2)); bg.setAttribute('cy', String(size / 2)); bg.setAttribute('r', String(r))
      bg.setAttribute('fill', 'none'); bg.setAttribute('stroke', flat(cfg.trackFill)); bg.setAttribute('stroke-width', String(sw))
      var fg = document.createElementNS(ns, 'circle')
      fg.setAttribute('cx', String(size / 2)); fg.setAttribute('cy', String(size / 2)); fg.setAttribute('r', String(r))
      fg.setAttribute('fill', 'none'); fg.setAttribute('stroke', flat(done ? cfg.doneFill : cfg.barFill))
      fg.setAttribute('stroke-width', String(sw)); fg.setAttribute('stroke-linecap', 'round')
      fg.setAttribute('stroke-dasharray', String(c))
      fg.setAttribute('stroke-dashoffset', String(c * (1 - ratio())))
      fg.setAttribute('transform', 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')')
      fg.style.transition = 'stroke-dashoffset var(--anim, 600ms) cubic-bezier(.22,.9,.3,1)'
      if (cfg.glowSize > 0) svg.style.filter = 'drop-shadow(0 0 ' + cfg.glowSize + 'px ' + cfg.glowColor + ')'
      svg.appendChild(bg); svg.appendChild(fg)
      box.appendChild(svg)
      var rn = document.createElement('div')
      rn.className = 'ringnums'
      rn.textContent = label
      box.appendChild(rn)
      var rimg = makeImage(done)
      if (rimg && cfg.imagePlace === 'fill') box.insertBefore(rimg, box.firstChild)
      host.appendChild(placeAround(box, done))
    } else {
      var bar = document.createElement('div')
      bar.className = 'bar'
      bar.style.width = (cfg.width || 420) + 'px'
      bar.style.height = (cfg.height || 34) + 'px'
      bar.style.borderRadius = (cfg.radius || 0) + 'px'
      /**
       * The outline and the glow can take the bar's own fill.
       *
       * A border is one colour and a box-shadow is one colour, so a gradient bar ringed by either
       * has to pick a single stop out of the gradient and always looks like the wrong one. With
       * the switch on, the ring becomes a painted layer behind the bar and the glow a blurred copy
       * of it, both carrying the same gradient.
       */
      var edge = cfg.fxFromFill ? barCss : null
      var bw = Math.max(0, cfg.borderWidth || 0)
      if (edge && bw > 0) bar.style.background = edge
      if (!edge) {
        if (bw > 0) bar.style.border = bw + 'px solid ' + cfg.borderColor
        if (cfg.glowSize > 0) bar.style.boxShadow = '0 0 ' + cfg.glowSize + 'px ' + cfg.glowColor + ', 0 0 ' + cfg.glowSize * 2 + 'px ' + cfg.glowColor
      }
      var track = document.createElement('div')
      track.className = 'track'
      track.style.background = fill(cfg.trackFill)
      var f = document.createElement('div')
      f.className = 'fillbar'
      f.style.background = barCss
      if (edge && bw > 0) {
        // the ring is the bar's own background; the track and the fill move inside it, in a box
        // of their own so the fill's percentage still measures the part people can see
        var inner = document.createElement('div')
        inner.style.position = 'absolute'
        inner.style.inset = bw + 'px'
        inner.style.overflow = 'hidden'
        inner.style.borderRadius = Math.max(0, (cfg.radius || 0) - bw) + 'px'
        inner.appendChild(track)
        inner.appendChild(f)
        bar.appendChild(inner)
      } else {
        bar.appendChild(track)
        bar.appendChild(f)
      }
      // a picture that fills the bar goes under the fill; one that sits inside it goes over
      var bimg = makeImage(done)
      if (bimg && cfg.imagePlace === 'fill') bar.insertBefore(bimg, bar.firstChild)
      if (cfg.textInside && label) {
        var inn = document.createElement('div')
        inn.className = 'nums'
        inn.textContent = label
        bar.appendChild(inn)
      }
      if (bimg && (cfg.imagePlace === 'inLeft' || cfg.imagePlace === 'inRight')) bar.appendChild(bimg)
      /**
       * A gradient glow has to live outside the bar.
       *
       * The bar clips its own contents so the track keeps its rounded corners, which would cut the
       * halo off at the same edge — so the blurred copy goes in a wrapper around it instead.
       */
      var barBox = bar
      if (edge && cfg.glowSize > 0) {
        barBox = document.createElement('div')
        barBox.style.position = 'relative'
        barBox.style.display = 'inline-block'
        var gl = document.createElement('div')
        gl.style.position = 'absolute'
        gl.style.inset = -Math.round(cfg.glowSize / 3) + 'px'
        gl.style.background = edge
        gl.style.borderRadius = (cfg.radius || 0) + 'px'
        gl.style.filter = 'blur(' + cfg.glowSize + 'px)'
        gl.style.pointerEvents = 'none'
        barBox.appendChild(gl)
        barBox.appendChild(bar)
      }
      host.appendChild(placeAround(barBox, done))
      if (!cfg.textInside && label) {
        var out = document.createElement('div')
        out.className = 'outside'
        out.textContent = label
        host.appendChild(out)
      }
      // The transition needs a start value that the browser has actually seen, so the zero is
      // forced through a synchronous reflow rather than waiting for a frame. A browser source
      // that OBS is not currently drawing gets no frames at all, and the version of this that
      // waited for one left the bar empty until the scene came back.
      f.style.width = '0%'
      void bar.offsetWidth
      f.style.width = (ratio() * 100).toFixed(2) + '%'
    }

    /**
     * The number went up — somebody followed, subscribed or cheered.
     *
     * No separate alert feed is needed for this: the count travels with the config, so a value
     * larger than the last one IS the event, and it still works after the browser source has been
     * restarted mid-stream.
     */
    var fx = cfg.gainFx == null ? (cfg.pulseOnGain ? 'pulse' : 'none') : cfg.gainFx
    if (lastValue !== null && value() > lastValue) {
      var gained = value() - lastValue
      if (fx && fx !== 'none') {
        host.className = ''
        void host.offsetWidth
        host.className = 'gain-' + fx
      }
      if (cfg.gainLabel) {
        var lbl = document.createElement('div')
        lbl.className = 'gainlbl'
        lbl.textContent = '+' + gained
        lbl.style.color = cfg.gainColor || '#ffe066'
        lbl.style.fontSize = Math.round((cfg.fontSize || 18) * 1.1) + 'px'
        host.appendChild(lbl)
        setTimeout(function () { lbl.remove() }, 1300)
      }
    }
    lastValue = value()
    userCss.textContent = cfg.customCss || ''
  }

  var goneBox = null
  function gone(on) {
    if (!on) { if (goneBox) { goneBox.remove(); goneBox = null } return }
    if (goneBox) return
    goneBox = document.createElement('div')
    goneBox.id = 'gone'
    goneBox.textContent = 'Цей оверлей видалено в StickiChat. Онови URL джерела в OBS.'
    document.body.appendChild(goneBox)
  }

  function connect() {
    var es = new EventSource('/events?channel=' + encodeURIComponent(channel) + '&profile=' + encodeURIComponent(profile))
    es.addEventListener('cfg', function (e) {
      try { cfg = Object.assign(cfg, JSON.parse(e.data)); gone(false); render() } catch (err) { /* noop */ }
    })
    es.addEventListener('gone', function () { gone(true) })
    es.onerror = function () { es.close(); setTimeout(connect, 3000) }
  }
  render()
  connect()

  if (preview) {
    // the editor shows it moving, because a bar frozen at one number tells you nothing about
    // whether the colours work — but it can be stopped, because a number that will not sit still
    // is no help either when the numbers themselves are what is being set
    setInterval(function () {
      if (cfg.previewDemo === false) return
      cfg.progress = (cfg.base || 0) + ((value() + Math.ceil(target() / 12)) % (target() + 1))
      render()
    }, 1400)
  }

  window.__oe = { cfg: cfg, render: render }
})()
</script>
</body>
</html>`

/**
 * The follow alert: somebody followed, so something appears, does its thing, and leaves.
 *
 * Built out of slots rather than one canned card — a picture, the follower's avatar, a headline and
 * a second line — because an alert that can only look one way gets used once and then replaced by
 * the usual service. Every slot can be switched off, and the whole thing is positioned, masked and
 * animated by the config.
 *
 * Alerts QUEUE. A raid can land twenty follows in a second, and twenty cards fading through each
 * other is not a celebration, it is a mess; they wait their turn, and the queue has a ceiling so a
 * flood cannot leave the overlay busy for ten minutes.
 *
 * NOTE: same rule as every page here — no backticks, no dollar-brace, anywhere below.
 */
const ALERT_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>StickiChat Alert</title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font-family: Inter, 'Segoe UI', sans-serif; }
  #stage { position: fixed; inset: 0; display: flex; pointer-events: none; }
  #stage.top { align-items: flex-start; }
  #stage.center { align-items: center; }
  #stage.bottom { align-items: flex-end; }
  #stage.left { justify-content: flex-start; }
  #stage.center-x { justify-content: center; }
  #stage.right { justify-content: flex-end; }
  .alert { display: flex; align-items: center; box-sizing: border-box; }
  .alert.imageTop { flex-direction: column; }
  .alert.imageLeft { flex-direction: row; }
  .alert.imageRight { flex-direction: row-reverse; }
  .alert.imageBehind { position: relative; }
  .alert.imageBehind .pic { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; z-index: -1; }
  .words { display: flex; flex-direction: column; align-items: center; }
  .t1, .t2 { margin: 0; line-height: 1.15; white-space: nowrap; }
  .pic { display: block; }
  .av { display: block; object-fit: cover; flex: 0 0 auto; }
  /* ---- entrances ---- */
  @keyframes a-fade { from { opacity: 0 } }
  @keyframes a-slideUp { from { opacity: 0; transform: translateY(60px) } }
  @keyframes a-slideDown { from { opacity: 0; transform: translateY(-60px) } }
  @keyframes a-slideLeft { from { opacity: 0; transform: translateX(80px) } }
  @keyframes a-slideRight { from { opacity: 0; transform: translateX(-80px) } }
  @keyframes a-pop { 0% { opacity: 0; transform: scale(.5) } 70% { transform: scale(1.08) } 100% { opacity: 1; transform: scale(1) } }
  @keyframes a-zoom { from { opacity: 0; transform: scale(1.6) } }
  @keyframes a-bounce { 0% { opacity: 0; transform: translateY(-90px) } 55% { opacity: 1; transform: translateY(0) }
    72% { transform: translateY(-18px) } 88% { transform: translateY(0) } 95% { transform: translateY(-6px) } 100% { transform: translateY(0) } }
  @keyframes a-flip { from { opacity: 0; transform: perspective(700px) rotateX(85deg) } }
  @keyframes a-swing { 0% { opacity: 0; transform: rotate(-14deg) } 60% { opacity: 1; transform: rotate(8deg) }
    80% { transform: rotate(-4deg) } 100% { transform: rotate(0) } }
  @keyframes a-blur { from { opacity: 0; filter: blur(18px) } }
  @keyframes a-glitch { 0% { opacity: 0; transform: translate(-8px, 4px) skewX(12deg) } 20% { opacity: 1; transform: translate(6px, -3px) skewX(-9deg) }
    40% { transform: translate(-4px, 2px) skewX(5deg) } 60% { transform: translate(3px, -1px) skewX(-3deg) } 100% { transform: none } }
  @keyframes a-wipe { from { clip-path: inset(0 100% 0 0) } to { clip-path: inset(0 0 0 0) } }
  /* ---- exits ---- */
  @keyframes o-fade { to { opacity: 0 } }
  @keyframes o-slideUp { to { opacity: 0; transform: translateY(-60px) } }
  @keyframes o-slideDown { to { opacity: 0; transform: translateY(60px) } }
  @keyframes o-slideLeft { to { opacity: 0; transform: translateX(-80px) } }
  @keyframes o-slideRight { to { opacity: 0; transform: translateX(80px) } }
  @keyframes o-pop { 0% { transform: scale(1) } 30% { transform: scale(1.1) } 100% { opacity: 0; transform: scale(.4) } }
  @keyframes o-zoom { to { opacity: 0; transform: scale(1.7) } }
  @keyframes o-bounce { 0% { transform: translateY(0) } 30% { transform: translateY(-20px) } 100% { opacity: 0; transform: translateY(120px) } }
  @keyframes o-flip { to { opacity: 0; transform: perspective(700px) rotateX(-85deg) } }
  @keyframes o-swing { 0% { transform: rotate(0) } 40% { transform: rotate(10deg) } 100% { opacity: 0; transform: rotate(-24deg) } }
  @keyframes o-blur { to { opacity: 0; filter: blur(18px) } }
  @keyframes o-glitch { 0% { transform: none } 30% { transform: translate(7px, -3px) skewX(-10deg) }
    60% { transform: translate(-6px, 3px) skewX(8deg) } 100% { opacity: 0; transform: translate(10px, 0) skewX(-14deg) } }
  @keyframes o-wipe { to { clip-path: inset(0 0 0 100%) } }
  /* ---- the picture's own loop while the alert is up ---- */
  @keyframes l-float { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-12px) } }
  @keyframes l-pulse { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.06) } }
  @keyframes l-spin { to { transform: rotate(360deg) } }
  @keyframes l-shake { 0%, 100% { transform: translateX(0) } 25% { transform: translateX(-5px) } 75% { transform: translateX(5px) } }
  #gone { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); background: #b91c1c; color: #fff;
    font: 600 14px/1.4 Inter, 'Segoe UI', sans-serif; padding: 8px 14px; border-radius: 8px; }
</style>
<style id="animCss"></style>
<style id="userCss"></style>
</head>
<body>
<div id="stage"></div>
<script>
(function () {
  var p = new URLSearchParams(location.search)
  var channel = (p.get('channel') || '').toLowerCase()
  var profile = p.get('profile') || ''
  var preview = p.get('preview') === '1'
  var stage = document.getElementById('stage')
  var animCss = document.getElementById('animCss')
  var userCss = document.getElementById('userCss')

  var cfg = {
    durationS: 5, animInMs: 600, animOutMs: 500, gapMs: 400, queueMax: 8,
    animIn: 'slideUp', animOut: 'fade', customAnimCss: '', customAnimInName: '', customAnimOutName: '',
    image: '', imageWidth: 220, mask: '', maskShape: 'none', maskFeather: 0, imageLoop: 'float',
    avatarShow: true, avatarSize: 84, avatarRound: true, avatarRing: 3, avatarRingColor: '#9147ff',
    title: 'Новий фоловер!', subtitle: '{user}', font: 'Inter',
    titleSize: 30, subtitleSize: 40, titleColor: '#ffffff', subtitleColor: '#ffffff', nameColor: '#c7a6ff',
    outlineWidth: 0, outlineColor: '#000000', shadowBlur: 14, shadowColor: '#000000',
    anchor: 'center', align: 'center', offsetX: 0, offsetY: 0, layout: 'imageTop', gap: 12,
    imageAnchor: 'center', imageX: 0, imageY: 0, imageRotate: 0, imageOpacity: 1,
    textAnchor: 'center', textX: 0, textY: 0,
    plate: false, plateFill: { kind: 'solid', color: '#18181b', opacity: 0.8 },
    plateMedia: '', plateMediaFit: 'cover', plateMediaOpacity: 1,
    plateShape: 'rect', plateMask: '', plateFxFromFill: false,
    plateRadius: 18, platePadX: 28, platePadY: 20,
    plateBorderWidth: 0, plateBorderColor: '#9147ff', plateGlowSize: 0, plateGlowColor: '#9147ff',
    soundData: '', soundVolume: 0.6, customCss: ''
  }

  function hexToRgba(hex, op) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
    if (!m) return 'rgba(0,0,0,' + (op == null ? 1 : op) + ')'
    var n = parseInt(m[1], 16)
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (op == null ? 1 : op) + ')'
  }
  function fill(f) {
    if (!f || f.opacity <= 0) return 'transparent'
    if (f.kind === 'gradient') {
      return 'linear-gradient(' + (f.angle || 0) + 'deg, ' + hexToRgba(f.color, f.opacity) + ', ' + hexToRgba(f.color2, f.opacity) + ')'
    }
    return hexToRgba(f.color, f.opacity)
  }
  function textFx() {
    var parts = []
    var w = cfg.outlineWidth
    if (w > 0) {
      for (var x = -w; x <= w; x++) for (var y = -w; y <= w; y++) if (x || y) parts.push(x + 'px ' + y + 'px 0 ' + cfg.outlineColor)
    }
    if (cfg.shadowBlur > 0) parts.push('0 2px ' + cfg.shadowBlur + 'px ' + cfg.shadowColor)
    return parts.length ? parts.join(', ') : 'none'
  }
  /** the animation name for a slot; 'custom' hands over to the uploaded keyframes */
  function animName(which) {
    var v = which === 'in' ? cfg.animIn : cfg.animOut
    if (v === 'custom') return (which === 'in' ? cfg.customAnimInName : cfg.customAnimOutName) || ''
    if (!v || v === 'none') return ''
    return (which === 'in' ? 'a-' : 'o-') + v
  }

  /** {user} and a couple of friends, replaced as the words are drawn */
  function fillTokens(s, d) {
    return String(s || '')
      .split('{user}').join(d.nick || d.login || '')
      .split('{channel}').join(channel)
  }

  /**
   * Pin one point of a box to one point of the stage.
   *
   * Free placement has to survive a resolution change: measuring from the CORNER the streamer
   * chose means a mascot pinned bottom-right is still bottom-right at 1440p, which absolute
   * coordinates from the top-left would not be.
   */
  function placeAt(el, anchor, x, y) {
    var a = anchor || 'center'
    var vert = a === 'tl' || a === 'top' || a === 'tr' ? 'top'
      : a === 'bl' || a === 'bottom' || a === 'br' ? 'bottom' : 'mid'
    var horz = a === 'tl' || a === 'left' || a === 'bl' ? 'left'
      : a === 'tr' || a === 'right' || a === 'br' ? 'right' : 'mid'
    el.style.position = 'absolute'
    var tx = '0', ty = '0'
    if (vert === 'top') el.style.top = (y || 0) + 'px'
    else if (vert === 'bottom') el.style.bottom = (-(y || 0)) + 'px'
    else { el.style.top = 'calc(50% + ' + (y || 0) + 'px)'; ty = '-50%' }
    if (horz === 'left') el.style.left = (x || 0) + 'px'
    else if (horz === 'right') el.style.right = (-(x || 0)) + 'px'
    else { el.style.left = 'calc(50% + ' + (x || 0) + 'px)'; tx = '-50%' }
    return 'translate(' + tx + ', ' + ty + ')'
  }

  /** a picture that might be a video — the kind is read off the source, never configured */
  // NB: string tests, not a regex. This page is a TS template literal, and every backslash in a
  // regex literal here is eaten before the browser ever sees it, which turned the pattern into a
  // division and threw on the first plate picture.
  function isVideo(src) {
    var s = String(src || '').toLowerCase().split('?')[0]
    if (s.indexOf('data:video/') === 0) return true
    return s.slice(-4) === '.mp4' || s.slice(-5) === '.webm' || s.slice(-4) === '.mov'
  }
  function mediaEl(src) {
    if (!src) return null
    var el
    if (isVideo(src)) {
      el = document.createElement('video')
      el.autoplay = true; el.loop = true; el.muted = true; el.playsInline = true
      el.setAttribute('playsinline', '')
    } else {
      el = document.createElement('img')
      el.alt = ''
    }
    el.src = src
    return el
  }

  /**
   * The shapes, as clip-paths.
   *
   * Percentages throughout, so one shape fits a picture, a wide plate and a tall one without a
   * separate set of numbers for each — the corner cuts move with the box instead of staying the
   * pixel size they were drawn at.
   */
  function shapeOf(s) {
    if (s === 'circle') return 'circle(50% at 50% 50%)'
    if (s === 'rounded') return 'inset(0 round 18px)'
    if (s === 'pill') return 'inset(0 round 999px)'
    if (s === 'hexagon') return 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)'
    if (s === 'hexflat') return 'polygon(6% 0, 94% 0, 100% 50%, 94% 100%, 6% 100%, 0 50%)'
    if (s === 'star') return 'polygon(50% 0, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)'
    if (s === 'blob') return 'polygon(20% 4%, 74% 0, 100% 28%, 96% 78%, 62% 100%, 16% 92%, 0 54%, 4% 20%)'
    if (s === 'notch') return 'polygon(0 18%, 6% 0, 94% 0, 100% 18%, 100% 82%, 94% 100%, 6% 100%, 0 82%)'
    if (s === 'ribbon') return 'polygon(0 0, 100% 0, 94% 50%, 100% 100%, 0 100%, 6% 50%)'
    if (s === 'ticket') return 'polygon(0 0, 100% 0, 100% 38%, 97% 50%, 100% 62%, 100% 100%, 0 100%, 0 62%, 3% 50%, 0 38%)'
    if (s === 'banner') return 'polygon(0 0, 100% 0, 100% 78%, 50% 100%, 0 78%)'
    if (s === 'shield') return 'polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%)'
    if (s === 'tag') return 'polygon(0 0, 92% 0, 100% 50%, 92% 100%, 0 100%)'
    if (s === 'slant') return 'polygon(5% 0, 100% 0, 95% 100%, 0 100%)'
    return ''
  }

  /**
   * One layer of the plate: the same outline, painted however the caller wants it.
   *
   * The plate is built as stacked copies of one shape rather than a border and a box-shadow,
   * because a border is a colour and a box-shadow is a colour, and neither can be the gradient the
   * plate itself is filled with. Three copies of the shape — blurred, painted, inset — give a glow
   * and an outline that follow the fill.
   */
  function plateLayer(paint, inset) {
    var el = document.createElement('div')
    el.style.position = 'absolute'
    el.style.inset = (inset || 0) + 'px'
    el.style.background = paint
    el.style.pointerEvents = 'none'
    var shape = cfg.plateMask ? '' : shapeOf(cfg.plateShape)
    if (cfg.plateMask) {
      el.style.webkitMaskImage = "url('" + cfg.plateMask + "')"
      el.style.maskImage = "url('" + cfg.plateMask + "')"
      el.style.webkitMaskSize = '100% 100%'
      el.style.maskSize = '100% 100%'
    } else if (shape) {
      el.style.clipPath = shape
    } else {
      el.style.borderRadius = (cfg.plateRadius || 0) + 'px'
    }
    return el
  }

  /**
   * Write the line, giving the follower's name its own colour.
   *
   * Split into text nodes rather than innerHTML: the name comes from Twitch and must never be able
   * to carry markup onto the stream.
   */
  function paintWithName(el, text, d) {
    var name = d.nick || d.login || ''
    var i = name ? text.indexOf(name) : -1
    if (i === -1 || !cfg.nameColor) {
      el.textContent = text
      return
    }
    el.appendChild(document.createTextNode(text.slice(0, i)))
    var b = document.createElement('span')
    b.textContent = name
    b.style.color = cfg.nameColor
    el.appendChild(b)
    el.appendChild(document.createTextNode(text.slice(i + name.length)))
  }

  function buildCard(d) {
    var card = document.createElement('div')
    card.className = 'alert ' + cfg.layout
    card.style.gap = (cfg.gap || 0) + 'px'
    card.style.font = '400 16px ' + (cfg.font ? "'" + cfg.font + "'" : 'Inter') + ', Inter, sans-serif'
    card.style.translate = (cfg.offsetX || 0) + 'px ' + (cfg.offsetY || 0) + 'px'
    if (cfg.plate) {
      card.style.position = card.style.position || 'relative'
      card.style.padding = (cfg.platePadY || 0) + 'px ' + (cfg.platePadX || 0) + 'px'

      // the outline and the glow follow the plate's own fill when asked, so a gradient plate does
      // not end up ringed in one flat colour picked out of it
      var facePaint = fill(cfg.plateFill)
      var edgePaint = cfg.plateFxFromFill ? facePaint : null
      var bw = Math.max(0, cfg.plateBorderWidth || 0)

      if (cfg.plateGlowSize > 0) {
        var glow = plateLayer(edgePaint || cfg.plateGlowColor || '#fff', -Math.round(cfg.plateGlowSize / 3))
        glow.style.filter = 'blur(' + cfg.plateGlowSize + 'px)'
        glow.style.zIndex = '0'
        card.appendChild(glow)
      }
      if (bw > 0) {
        var ring = plateLayer(edgePaint || cfg.plateBorderColor || '#fff', 0)
        ring.style.zIndex = '0'
        card.appendChild(ring)
      }
      var face = plateLayer(facePaint, bw)
      face.style.zIndex = '0'
      face.style.overflow = 'hidden'
      // a picture, GIF or video for the plate, inside the shape and under everything else
      var pm = mediaEl(cfg.plateMedia)
      if (pm) {
        pm.style.position = 'absolute'
        pm.style.inset = '0'
        pm.style.width = '100%'
        pm.style.height = '100%'
        pm.style.objectFit = cfg.plateMediaFit === 'stretch' ? 'fill' : cfg.plateMediaFit || 'cover'
        pm.style.opacity = String(cfg.plateMediaOpacity == null ? 1 : cfg.plateMediaOpacity)
        pm.style.pointerEvents = 'none'
        face.appendChild(pm)
      }
      card.appendChild(face)
    }

    if (cfg.image && cfg.layout !== 'textOnly') {
      var pic = mediaEl(cfg.image)
      pic.className = 'pic'
      if (cfg.layout !== 'imageBehind' && cfg.imageWidth > 0) pic.style.width = cfg.imageWidth + 'px'
      pic.style.opacity = String(cfg.imageOpacity == null ? 1 : cfg.imageOpacity)
      /**
       * The mask. An uploaded PNG is its own alpha; a built-in shape is a clip-path; and the
       * feather has to be a mask rather than part of the clip, because clip-path edges cannot be
       * softened at all.
       */
      if (cfg.mask) {
        pic.style.webkitMaskImage = "url('" + cfg.mask + "')"
        pic.style.maskImage = "url('" + cfg.mask + "')"
        pic.style.webkitMaskSize = '100% 100%'
        pic.style.maskSize = '100% 100%'
      } else if (cfg.maskShape && cfg.maskShape !== 'none') {
        pic.style.clipPath = shapeOf(cfg.maskShape)
        if (cfg.maskFeather > 0) {
          var f = cfg.maskFeather + 'px'
          var g = 'radial-gradient(closest-side, black calc(100% - ' + f + '), transparent 100%)'
          pic.style.webkitMaskImage = g
          pic.style.maskImage = g
        }
      }
      if (cfg.imageLoop && cfg.imageLoop !== 'none') {
        pic.style.animation = 'l-' + cfg.imageLoop + ' ' +
          (cfg.imageLoop === 'spin' ? '6s linear' : '2.4s ease-in-out') + ' infinite'
      }
      // above the plate: the plate layers are positioned, and a static picture would be painted
      // under them however late it was added
      pic.style.position = 'relative'
      pic.style.zIndex = '1'
      card.appendChild(pic)
    }

    var words = document.createElement('div')
    words.className = 'words'
    words.style.gap = Math.round((cfg.gap || 0) / 2) + 'px'
    words.style.textShadow = textFx()

    if (cfg.avatarShow && d.avatar) {
      var av = document.createElement('img')
      av.className = 'av'
      av.src = d.avatar
      av.alt = ''
      av.style.width = (cfg.avatarSize || 84) + 'px'
      av.style.height = (cfg.avatarSize || 84) + 'px'
      av.style.borderRadius = cfg.avatarRound ? '50%' : '10%'
      if (cfg.avatarRing > 0) av.style.border = cfg.avatarRing + 'px solid ' + cfg.avatarRingColor
      words.appendChild(av)
    }

    var t1 = fillTokens(cfg.title, d)
    if (t1) {
      var h1 = document.createElement('div')
      h1.className = 't1'
      h1.style.fontSize = (cfg.titleSize || 30) + 'px'
      h1.style.fontWeight = '700'
      h1.style.color = cfg.titleColor
      paintWithName(h1, t1, d)
      words.appendChild(h1)
    }
    var t2 = fillTokens(cfg.subtitle, d)
    if (t2) {
      var h2 = document.createElement('div')
      h2.className = 't2'
      h2.style.fontSize = (cfg.subtitleSize || 40) + 'px'
      h2.style.fontWeight = '800'
      h2.style.color = cfg.subtitleColor
      paintWithName(h2, t2, d)
      words.appendChild(h2)
    }
    card.appendChild(words)

    /**
     * Free placement.
     *
     * The five arrangements are a flex row or column and cannot express "the mascot leans in from
     * the bottom-right while the words sit high and left". In this mode the card stops being a
     * layout at all and becomes a stage the two blocks are pinned to.
     */
    if (cfg.layout === 'free') {
      card.style.position = 'absolute'
      card.style.inset = '0'
      card.style.display = 'block'
      card.style.translate = ''
      if (pic) {
        var pt = placeAt(pic, cfg.imageAnchor, cfg.imageX, cfg.imageY)
        pic.style.transform = pt + (cfg.imageRotate ? ' rotate(' + cfg.imageRotate + 'deg)' : '')
      }
      var wt = placeAt(words, cfg.textAnchor, cfg.textX, cfg.textY)
      words.style.transform = wt
      words.style.zIndex = '1'
    } else {
      words.style.position = 'relative'
      words.style.zIndex = '1'
      /**
       * In the arranged layouts the same numbers nudge instead of pin.
       *
       * They used to do nothing at all outside free placement, which reads as broken: the fields
       * are right there and dragging them moves nothing. A row or a column can still be leaned on
       * a few pixels, and that is what they now do.
       */
      if (pic) {
        var nudge = []
        if (cfg.imageX || cfg.imageY) nudge.push('translate(' + (cfg.imageX || 0) + 'px, ' + (cfg.imageY || 0) + 'px)')
        if (cfg.imageRotate) nudge.push('rotate(' + cfg.imageRotate + 'deg)')
        if (nudge.length) pic.style.transform = nudge.join(' ')
      }
      if (cfg.textX || cfg.textY) {
        words.style.transform = 'translate(' + (cfg.textX || 0) + 'px, ' + (cfg.textY || 0) + 'px)'
      }
    }
    return card
  }

  function applyStage() {
    stage.className = cfg.layout === 'free'
      ? 'free'
      : (cfg.anchor || 'center') + ' ' + (cfg.align === 'center' ? 'center-x' : cfg.align || 'center-x')
    animCss.textContent = cfg.customAnimCss || ''
    userCss.textContent = cfg.customCss || ''
  }

  /* ---------------------------------- the queue ----------------------------------
   *
   * One clock, checked against the wall, rather than a chain of timers.
   *
   * The chain worked until something delayed it: OBS stops giving a source frames when its scene
   * is not showing, and a browser throttles a page it is not drawing, so the timeout that was
   * meant to take the card away could arrive minutes late — or, if the page was suspended mid
   * chain, never. The flag that says "an alert is on screen" then stayed set and every later
   * follower queued behind a card that was already gone.
   *
   * Deadlines in real time cannot drift like that. A late tick notices that all three moments have
   * passed and catches up in one go, and there is no state that outlives the card it describes.
   */
  var queue = []
  var current = null

  function show(d) {
    // build first, claim the slot second: a card that throws should cost only itself
    var card
    try {
      card = buildCard(d)
    } catch (err) {
      console.error('alert: could not build the card', err)
      return
    }
    var nameIn = animName('in')
    if (nameIn) card.style.animation = nameIn + ' ' + (cfg.animInMs || 600) + 'ms cubic-bezier(.2,.9,.3,1) both'
    stage.appendChild(card)
    if (cfg.soundData) {
      try {
        var au = new Audio(cfg.soundData)
        au.volume = Math.max(0, Math.min(1, cfg.soundVolume == null ? 0.6 : cfg.soundVolume))
        au.play().catch(function () {})
      } catch (err) { /* noop */ }
    }
    var now = Date.now()
    current = {
      card: card,
      nameOut: animName('out'),
      leaveAt: now + (cfg.animInMs || 0) + Math.max(0, (cfg.durationS || 0) * 1000),
      goneAt: 0
    }
  }

  function tick() {
    if (holdCard) return
    if (!current) {
      if (queue.length) show(queue.shift())
      return
    }
    var now = Date.now()
    if (!current.goneAt && now >= current.leaveAt) {
      current.goneAt = now + (current.nameOut ? cfg.animOutMs || 500 : 0) + Math.max(0, cfg.gapMs || 0)
      if (current.nameOut) {
        current.card.style.animation = current.nameOut + ' ' + (cfg.animOutMs || 500) + 'ms ease both'
      }
    }
    if (current.goneAt && now >= current.goneAt) {
      current.card.remove()
      current = null
      if (queue.length) show(queue.shift())
    }
  }
  setInterval(tick, 120)

  function enqueue(d) {
    // a raid can land twenty follows in a second; the ceiling drops the OLDEST one still waiting,
    // so the most recent follower is always among those who actually get seen
    queue.push(d)
    var max = Math.max(1, cfg.queueMax || 8)
    while (queue.length > max) queue.shift()
    tick()
  }

  /**
   * The paused preview: one card that simply stays.
   *
   * With the demo off there was nothing to look at at all, which makes the plate impossible to
   * style — every change had to be judged in the second and a half an alert is up. This holds a
   * sample card on screen and rebuilds it whenever the config changes, so editing the plate is
   * something you watch rather than something you catch.
   */
  var holdCard = null
  var SAMPLE = {
    follow: true, ts: 0, nick: 'Bobik069', login: 'bobik069',
    avatar: 'data:image/svg+xml;base64,' + btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<rect width="64" height="64" fill="#9147ff"/><text x="32" y="43" font-size="34" font-family="Segoe UI"' +
      ' font-weight="700" fill="#fff" text-anchor="middle">B</text></svg>')
  }
  function previewHold() {
    if (!preview) return
    if (holdCard) { holdCard.remove(); holdCard = null }
    if (cfg.previewDemo !== false) return
    queue.length = 0
    if (current) { current.card.remove(); current = null }
    try {
      holdCard = buildCard(SAMPLE)
      // no inline animation here: it would beat anything the custom CSS puts on .alert, and a
      // held card is exactly where somebody is trying to watch their own animation
      stage.appendChild(holdCard)
    } catch (err) {
      console.error('alert: could not build the sample card', err)
    }
  }

  /**
   * Say why nothing is showing.
   *
   * An alert overlay is blank between alerts, so blank-because-broken and blank-because-quiet look
   * exactly alike. Only the page can tell them apart, so it says so.
   */
  var noteBox = null
  function note(text) {
    if (!text) { if (noteBox) { noteBox.remove(); noteBox = null } return }
    if (!noteBox) {
      noteBox = document.createElement('div')
      noteBox.id = 'gone'
      document.body.appendChild(noteBox)
    }
    noteBox.textContent = text
  }
  function gone(on) { note(on ? 'Цей оверлей видалено в StickiChat. Онови URL джерела в OBS.' : '') }

  var gotCfg = false
  function connect() {
    var es = new EventSource('/events?channel=' + encodeURIComponent(channel) + '&profile=' + encodeURIComponent(profile))
    es.addEventListener('cfg', function (e) {
      try {
        gotCfg = true
        cfg = Object.assign(cfg, JSON.parse(e.data))
        gone(false)
        applyStage()
        // every edit lands here, so the held sample card is rebuilt as the plate is being styled
        previewHold()
      } catch (err) { /* noop */ }
    })
    es.addEventListener('gone', function () { gone(true) })
    es.onmessage = function (e) {
      try {
        var d = JSON.parse(e.data)
        // the backlog is replayed on connect, so only something that JUST happened may fire an
        // alert — a source restarting mid-stream must not replay this morning's followers
        if (d && d.follow && Date.now() - (d.ts || 0) < 30000) enqueue(d)
      } catch (err) { /* noop */ }
    }
    es.onerror = function () {
      es.close()
      if (!gotCfg) note('StickiChat не відповідає. Запусти застосунок, тоді онови це джерело в OBS.')
      setTimeout(connect, 3000)
    }
  }
  applyStage()
  connect()

  if (preview) {
    var NAMES = ['Bobik069', 'Pinuses', 'Mira_Cat', 'n1cole_cat']
    var n = 0
    // no first shot before the config lands: until it does there is no way to know the demo was
    // meant to be off, and one alert would fire past a switch that is already set to paused
    setInterval(function () {
      if (!gotCfg || cfg.previewDemo === false) return
      var name = NAMES[n++ % NAMES.length]
      enqueue({
        follow: true, ts: Date.now(), nick: name, login: name.toLowerCase(),
        avatar: 'data:image/svg+xml;base64,' + btoa(
          '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
          '<rect width="64" height="64" fill="#9147ff"/><text x="32" y="43" font-size="34" font-family="Segoe UI"' +
          ' font-weight="700" fill="#fff" text-anchor="middle">' + name[0] + '</text></svg>')
      })
    }, 4000)
  }

  window.__oe = {
    cfg: cfg, enqueue: enqueue, applyStage: applyStage, queue: queue,
    tick: tick, previewHold: previewHold, held: function () { return !!holdCard }
  }
})()
</script>
</body>
</html>`

/**
 * The wheel of fortune.
 *
 * It does not decide anything. The app picks the winner and sends the wedge index with the spin, so
 * two browser sources pointed at the same overlay land identically and the result announced in chat
 * is the word the wheel is showing. All this page does is turn.
 *
 * Wedges are drawn as SVG paths rather than conic-gradient slices because each one has to carry its
 * own label, and possibly its own picture, at its own angle — a gradient can only ever be colour.
 *
 * NOTE: same rule as every page here — no backticks, no dollar-brace, anywhere below.
 */
const WHEEL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>StickiChat Wheel</title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font-family: Inter, 'Segoe UI', sans-serif; }
  #stage { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  #back { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
  #wrap { position: relative; }
  #wheel { transform-origin: 50% 50%; display: block; }
  #hub { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); border-radius: 50%;
    object-fit: cover; pointer-events: none; }
  #pointer { position: absolute; left: 50%; top: -2px; transform: translateX(-50%); pointer-events: none; }
  #result { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); text-align: center;
    font-weight: 800; pointer-events: none; opacity: 0; transition: opacity 240ms ease; white-space: nowrap; }
  #result.on { opacity: 1; }
  @keyframes res-pop { 0% { transform: translate(-50%, -50%) scale(.6) } 60% { transform: translate(-50%, -50%) scale(1.12) }
    100% { transform: translate(-50%, -50%) scale(1) } }
  #result.on { animation: res-pop 420ms cubic-bezier(.2,1.3,.4,1); }
  #gone { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); background: #b91c1c; color: #fff;
    font: 600 14px/1.4 Inter, 'Segoe UI', sans-serif; padding: 8px 14px; border-radius: 8px; }
</style>
<style id="userCss"></style>
</head>
<body>
<div id="stage"><div id="wrap"></div></div>
<script>
(function () {
  var p = new URLSearchParams(location.search)
  var channel = (p.get('channel') || '').toLowerCase()
  var profile = p.get('profile') || ''
  var preview = p.get('preview') === '1'
  var stage = document.getElementById('stage')
  var wrap = document.getElementById('wrap')
  var userCss = document.getElementById('userCss')
  var NS = 'http://www.w3.org/2000/svg'

  var cfg = {
    sections: [], spinS: 6, turns: 5, easing: 'smooth', resultS: 4,
    size: 460, rimWidth: 10, rimColor: '#ffffff', dividerWidth: 2, dividerColor: '#00000055',
    font: 'Inter', fontSize: 20, textRadial: true, pointer: 'triangle', pointerColor: '#ffffff',
    pointerMedia: '', pointerSize: 46,
    hubMedia: '', hubSize: 90, faceMedia: '', faceOpacity: 1,
    backdrop: '', backdropFit: 'cover', backdropOpacity: 1,
    resultShow: true, resultSize: 42, resultColor: '#ffffff',
    spinSoundKind: 'tick', spinSound: '', winSoundKind: 'fanfare', winSound: '',
    soundVolume: 0.6, offsetX: 0, offsetY: 0, customCss: ''
  }
  var angle = 0        // where the wheel currently sits, degrees
  var spinning = false
  var pendingRender = false   // a config that arrived mid-spin and still has to be drawn
  var stopSpinSound = null

  // NB: string tests, not a regex. This page is a TS template literal, and every backslash in a
  // regex literal here is eaten before the browser ever sees it, which turned the pattern into a
  // division and threw on the first plate picture.
  function isVideo(src) {
    var s = String(src || '').toLowerCase().split('?')[0]
    if (s.indexOf('data:video/') === 0) return true
    return s.slice(-4) === '.mp4' || s.slice(-5) === '.webm' || s.slice(-4) === '.mov'
  }

  /** a picture that might be a video — the kind is read off the source, never configured */
  function mediaEl(src, className) {
    if (!src) return null
    var el
    if (isVideo(src)) {
      el = document.createElement('video')
      el.autoplay = true
      el.loop = true
      el.muted = true
      el.playsInline = true
      el.setAttribute('playsinline', '')
    } else {
      el = document.createElement('img')
      el.alt = ''
    }
    el.src = src
    if (className) el.className = className
    return el
  }

  /** the weights, as running angles; a wedge is as wide as it is likely */
  function slices() {
    var list = (cfg.sections || []).filter(function (s) { return s && s.label !== undefined })
    var total = 0
    for (var i = 0; i < list.length; i++) total += Math.max(0.0001, list[i].weight || 1)
    var out = []
    var at = 0
    for (var j = 0; j < list.length; j++) {
      var w = Math.max(0.0001, list[j].weight || 1)
      var span = (w / total) * 360
      out.push({ s: list[j], from: at, to: at + span, mid: at + span / 2, span: span })
      at += span
    }
    return out
  }

  function arcPath(cx, cy, r, a0, a1) {
    var rad = Math.PI / 180
    var x0 = cx + r * Math.cos(a0 * rad), y0 = cy + r * Math.sin(a0 * rad)
    var x1 = cx + r * Math.cos(a1 * rad), y1 = cy + r * Math.sin(a1 * rad)
    var big = a1 - a0 > 180 ? 1 : 0
    return 'M ' + cx + ' ' + cy + ' L ' + x0 + ' ' + y0 +
      ' A ' + r + ' ' + r + ' 0 ' + big + ' 1 ' + x1 + ' ' + y1 + ' Z'
  }

  /**
   * Where a wedge picture sits.
   *
   * The box is square and centred on the wheel by default, so a picture with no settings covers
   * the wedge exactly as before; scale and offset move it inside the clip, which is how a mascot
   * ends up leaning against the rim instead of stretched across the whole slice.
   */
  function mediaBox(sec, size) {
    var scale = Math.max(1, sec.mediaScale == null ? 100 : sec.mediaScale) / 100
    var w = size * scale
    return { x: (size - w) / 2 + (sec.mediaX || 0), y: (size - w) / 2 + (sec.mediaY || 0), w: w }
  }

  /** the same picture-or-video choice the rest of the page makes, clipped to a shape in the svg */
  function clippedMedia(src, clipId, box) {
    var el
    if (isVideo(src)) {
      el = document.createElementNS(NS, 'foreignObject')
      var vid = mediaEl(src)
      vid.style.width = '100%'
      vid.style.height = '100%'
      vid.style.objectFit = 'cover'
      el.appendChild(vid)
    } else {
      el = document.createElementNS(NS, 'image')
      el.setAttribute('href', src)
      el.setAttribute('preserveAspectRatio', 'xMidYMid slice')
    }
    el.setAttribute('x', String(box.x)); el.setAttribute('y', String(box.y))
    el.setAttribute('width', String(box.w)); el.setAttribute('height', String(box.w))
    el.setAttribute('clip-path', 'url(#' + clipId + ')')
    return el
  }

  function render() {
    var size = Math.max(80, cfg.size || 460)
    var r = size / 2
    wrap.innerHTML = ''
    wrap.style.width = size + 'px'
    wrap.style.height = size + 'px'
    wrap.style.translate = (cfg.offsetX || 0) + 'px ' + (cfg.offsetY || 0) + 'px'

    var svg = document.createElementNS(NS, 'svg')
    svg.id = 'wheel'
    svg.setAttribute('width', String(size))
    svg.setAttribute('height', String(size))
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size)
    svg.style.transform = 'rotate(' + angle + 'deg)'

    var defs = document.createElementNS(NS, 'defs')
    svg.appendChild(defs)

    var list = slices()
    // the pointer sits at the top, so wedge 0 starts there rather than at three o'clock
    var base = -90
    /**
     * Four passes, because everything wants to be on top of the colours.
     *
     * A picture across the whole face covers the wedge colours by design — that is what it is for
     * — but it was covering the wedge pictures and the divider lines too, which is not. So the
     * colours go down first, then the face, then each wedge's own picture, then the dividers as
     * lines of their own, then the words. Drawing the dividers with the fills, the way it was,
     * makes them a property of a shape that something else is going to paint over.
     */
    var wedgeArt = document.createElementNS(NS, 'g')
    var dividers = document.createElementNS(NS, 'g')
    var labels = document.createElementNS(NS, 'g')
    for (var i = 0; i < list.length; i++) {
      var sl = list[i]
      var d0 = arcPath(r, r, r - (cfg.rimWidth || 0) / 2, base + sl.from, base + sl.to)
      var path = document.createElementNS(NS, 'path')
      path.setAttribute('d', d0)
      path.setAttribute('fill', sl.s.color || '#333')
      svg.appendChild(path)

      if (cfg.dividerWidth > 0) {
        var line = document.createElementNS(NS, 'path')
        line.setAttribute('d', d0)
        line.setAttribute('fill', 'none')
        line.setAttribute('stroke', cfg.dividerColor || '#0006')
        line.setAttribute('stroke-width', String(cfg.dividerWidth))
        dividers.appendChild(line)
      }

      /**
       * A wedge may carry its own picture, clipped to its own shape.
       *
       * A video goes through foreignObject rather than an svg <image>, because that tag paints one
       * still and nothing moves.
       */
      if (sl.s.media) {
        var cid = 'clip' + i
        var cp = document.createElementNS(NS, 'clipPath')
        cp.setAttribute('id', cid)
        var cpp = document.createElementNS(NS, 'path')
        cpp.setAttribute('d', d0)
        cp.appendChild(cpp)
        defs.appendChild(cp)
        wedgeArt.appendChild(clippedMedia(sl.s.media, cid, mediaBox(sl.s, size)))
      }

      var label = String(sl.s.label == null ? '' : sl.s.label)
      if (label) {
        var t = document.createElementNS(NS, 'text')
        var mid = base + sl.mid
        var rad = Math.PI / 180
        var tr = r * 0.62
        var tx = r + tr * Math.cos(mid * rad)
        var ty = r + tr * Math.sin(mid * rad)
        t.setAttribute('x', String(tx))
        t.setAttribute('y', String(ty))
        t.setAttribute('fill', sl.s.textColor || '#fff')
        t.setAttribute('font-size', String(cfg.fontSize || 20))
        t.setAttribute('font-weight', '700')
        t.setAttribute('font-family', (cfg.font || 'Inter') + ', Inter, sans-serif')
        t.setAttribute('text-anchor', 'middle')
        t.setAttribute('dominant-baseline', 'middle')
        if (cfg.textRadial) {
          // along the radius: readable on a narrow wedge, which upright text stops being fast
          var rot = mid
          if (rot > 90 && rot < 270) rot -= 180
          t.setAttribute('transform', 'rotate(' + rot + ' ' + tx + ' ' + ty + ')')
        }
        t.textContent = label
        labels.appendChild(t)
      }
    }

    /**
     * The wheel's own face: one picture across the whole disc, turning with it.
     *
     * Not the same thing as the backdrop, which stays put behind the wheel. This is for a wheel
     * that was drawn somewhere else and only needs the wedges underneath as geometry.
     */
    if (cfg.faceMedia) {
      var fcp = document.createElementNS(NS, 'clipPath')
      fcp.setAttribute('id', 'clipface')
      var fc = document.createElementNS(NS, 'circle')
      fc.setAttribute('cx', String(r)); fc.setAttribute('cy', String(r))
      fc.setAttribute('r', String(r - (cfg.rimWidth || 0) / 2))
      fcp.appendChild(fc)
      defs.appendChild(fcp)
      var face = clippedMedia(cfg.faceMedia, 'clipface', { x: 0, y: 0, w: size })
      face.setAttribute('opacity', String(cfg.faceOpacity == null ? 1 : cfg.faceOpacity))
      svg.appendChild(face)
    }

    // the wedge pictures, the lines between the wedges and the words all belong above the face
    svg.appendChild(wedgeArt)
    svg.appendChild(dividers)
    svg.appendChild(labels)

    if (cfg.rimWidth > 0) {
      var rim = document.createElementNS(NS, 'circle')
      rim.setAttribute('cx', String(r)); rim.setAttribute('cy', String(r))
      rim.setAttribute('r', String(r - cfg.rimWidth / 2))
      rim.setAttribute('fill', 'none')
      rim.setAttribute('stroke', cfg.rimColor || '#fff')
      rim.setAttribute('stroke-width', String(cfg.rimWidth))
      svg.appendChild(rim)
    }
    wrap.appendChild(svg)

    if (cfg.hubMedia) {
      var hub = mediaEl(cfg.hubMedia)
      if (hub) {
        hub.id = 'hub'
        hub.style.width = (cfg.hubSize || 90) + 'px'
        hub.style.height = (cfg.hubSize || 90) + 'px'
        wrap.appendChild(hub)
      }
    }

    /**
     * The pointer, drawn or supplied.
     *
     * An uploaded one wins over the three shapes: it is pinned by the middle of its top edge, the
     * same place the drawn ones are, so swapping between them does not move where the wheel is
     * being read.
     */
    if (cfg.pointerMedia) {
      var pm2 = mediaEl(cfg.pointerMedia)
      if (pm2) {
        pm2.id = 'pointer'
        pm2.style.width = (cfg.pointerSize || 46) + 'px'
        pm2.style.height = 'auto'
        wrap.appendChild(pm2)
      }
    } else if (cfg.pointer && cfg.pointer !== 'none') {
      var pt = document.createElementNS(NS, 'svg')
      pt.id = 'pointer'
      var pw = cfg.pointerSize || 46
      pt.setAttribute('width', String(pw))
      pt.setAttribute('height', String(Math.round(pw * 52 / 46)))
      pt.setAttribute('viewBox', '0 0 46 52')
      var shape = document.createElementNS(NS, 'path')
      var d = cfg.pointer === 'arrow'
        ? 'M23 50 L6 14 L18 18 L23 2 L28 18 L40 14 Z'
        : cfg.pointer === 'pin'
          ? 'M23 52 C10 30 6 24 6 17 A17 17 0 0 1 40 17 C40 24 36 30 23 52 Z'
          : 'M4 2 H42 L23 44 Z'
      shape.setAttribute('d', d)
      shape.setAttribute('fill', cfg.pointerColor || '#fff')
      shape.setAttribute('stroke', 'rgba(0,0,0,.35)')
      shape.setAttribute('stroke-width', '2')
      pt.appendChild(shape)
      wrap.appendChild(pt)
    }

    var res = document.createElement('div')
    res.id = 'result'
    res.style.fontSize = (cfg.resultSize || 42) + 'px'
    res.style.color = cfg.resultColor || '#fff'
    res.style.fontFamily = (cfg.font || 'Inter') + ', Inter, sans-serif'
    res.style.textShadow = '0 3px 14px rgba(0,0,0,.7)'
    wrap.appendChild(res)

    // the backdrop lives on the stage, not the wheel, so it does not turn with it
    var old = document.getElementById('back')
    if (old) old.remove()
    if (cfg.backdrop) {
      var bg = mediaEl(cfg.backdrop)
      if (bg) {
        bg.id = 'back'
        bg.style.objectFit = cfg.backdropFit === 'stretch' ? 'fill' : cfg.backdropFit || 'cover'
        bg.style.opacity = String(cfg.backdropOpacity == null ? 1 : cfg.backdropOpacity)
        stage.insertBefore(bg, stage.firstChild)
      }
    }
    userCss.textContent = cfg.customCss || ''
  }

  function easingCurve() {
    if (cfg.easing === 'snappy') return 'cubic-bezier(.12,.85,.2,1)'
    if (cfg.easing === 'heavy') return 'cubic-bezier(.1,.62,.12,1)'
    return 'cubic-bezier(.16,.84,.24,1)'
  }

  /* ---------------------------------- sound ----------------------------------
   *
   * The built-in sounds are synthesized rather than shipped as files, and the spin sound is not a
   * loop at all by default: it is one click per wedge going past the pointer, driven by the real
   * rotation. A recording has a length, and a wheel does not — anything looped either runs out or
   * has to be cut, and it drifts out of step with the picture as the wheel slows down. Clicks that
   * follow the wheel cannot drift, and they end exactly when it stops, however long it turned.
   */
  var actx = null
  function audio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)()
      if (actx.state === 'suspended') actx.resume().catch(function () { /* noop */ })
    } catch (err) { actx = null }
    return actx
  }
  function vol() { return Math.max(0, Math.min(1, cfg.soundVolume == null ? 0.6 : cfg.soundVolume)) }

  var noiseBuf = null
  function noise(a) {
    if (noiseBuf) return noiseBuf
    var n = Math.floor(a.sampleRate * 2)
    noiseBuf = a.createBuffer(1, n, a.sampleRate)
    var d = noiseBuf.getChannelData(0)
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1
    return noiseBuf
  }

  /** the peg going past the pointer */
  function click() {
    var a = audio()
    if (!a) return
    var t = a.currentTime
    var osc = a.createOscillator()
    var g = a.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(1500, t)
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.045)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.35 * vol()), t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
    osc.connect(g).connect(a.destination)
    osc.start(t)
    osc.stop(t + 0.08)
  }

  function tone(a, freq, at, dur, type, peak) {
    var osc = a.createOscillator()
    var g = a.createGain()
    osc.type = type || 'sine'
    osc.frequency.setValueAtTime(freq, at)
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    osc.connect(g).connect(a.destination)
    osc.start(at)
    osc.stop(at + dur + 0.05)
  }

  /** the loops: both are continuous by construction, so there is nothing to run out */
  function startWhoosh() {
    var a = audio()
    if (!a) return null
    var src = a.createBufferSource(); src.buffer = noise(a); src.loop = true
    var f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.9
    var g = a.createGain(); g.gain.value = 0.18 * vol()
    var lfo = a.createOscillator(); lfo.frequency.value = 0.6
    var lg = a.createGain(); lg.gain.value = 380
    lfo.connect(lg); lg.connect(f.frequency)
    src.connect(f); f.connect(g); g.connect(a.destination)
    src.start(); lfo.start()
    return function () { try { src.stop(); lfo.stop() } catch (err) { /* noop */ } }
  }

  function startDrumroll() {
    var a = audio()
    if (!a) return null
    var src = a.createBufferSource(); src.buffer = noise(a); src.loop = true
    var f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2400
    var g = a.createGain(); g.gain.value = 0
    var lfo = a.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 24
    var lg = a.createGain(); lg.gain.value = 0.1 * vol()
    var base = a.createConstantSource(); base.offset.value = 0.1 * vol()
    lfo.connect(lg); lg.connect(g.gain); base.connect(g.gain)
    src.connect(f); f.connect(g); g.connect(a.destination)
    src.start(); lfo.start(); base.start()
    return function () { try { src.stop(); lfo.stop(); base.stop() } catch (err) { /* noop */ } }
  }

  /** an uploaded loop, decoded once and looped in the graph so it never gaps at the seam */
  function startCustomLoop(url) {
    var a = audio()
    if (!a) return null
    var node = null
    var dead = false
    fetch(url).then(function (r) { return r.arrayBuffer() })
      .then(function (b) { return a.decodeAudioData(b) })
      .then(function (buf) {
        if (dead) return
        node = a.createBufferSource()
        node.buffer = buf
        node.loop = true
        var g = a.createGain(); g.gain.value = vol()
        node.connect(g); g.connect(a.destination)
        node.start()
      })
      .catch(function () { /* an unreadable upload simply stays silent */ })
    return function () { dead = true; if (node) { try { node.stop() } catch (err) { /* noop */ } } }
  }

  function playWin() {
    var kind = cfg.winSoundKind == null ? (cfg.winSound ? 'custom' : 'fanfare') : cfg.winSoundKind
    if (kind === 'none') return
    if (kind === 'custom') {
      if (!cfg.winSound) return
      try {
        var au = new Audio(cfg.winSound)
        au.volume = vol()
        au.play().catch(function () { /* noop */ })
      } catch (err) { /* noop */ }
      return
    }
    var a = audio()
    if (!a) return
    var t = a.currentTime
    var p = 0.22 * vol()
    if (kind === 'coin') {
      tone(a, 988, t, 0.07, 'square', p)
      tone(a, 1319, t + 0.07, 0.28, 'square', p)
      return
    }
    if (kind === 'chime') {
      tone(a, 784, t, 0.3, 'sine', p)
      tone(a, 1047, t + 0.1, 0.3, 'sine', p)
      tone(a, 1319, t + 0.2, 0.45, 'sine', p)
      return
    }
    // fanfare: a bright major triad, then the octave held
    tone(a, 523, t, 0.16, 'triangle', p)
    tone(a, 659, t + 0.11, 0.16, 'triangle', p)
    tone(a, 784, t + 0.22, 0.18, 'triangle', p)
    tone(a, 1047, t + 0.34, 0.55, 'triangle', p)
    tone(a, 784, t + 0.34, 0.55, 'sine', p * 0.6)
  }

  /**
   * The ticks, read off the real rotation.
   *
   * Chasing the computed transform rather than a timer means the clicks follow whatever easing the
   * wheel was given, and they thin out as it slows exactly the way the wedges do.
   */
  var tickRaf = 0
  function startTicks(list, from) {
    var svg = document.getElementById('wheel')
    if (!svg || !list.length) return null
    var prev = from
    var counted = crossings(from, list)
    var step = function () {
      var m = matrixAngle(svg)
      if (m != null) {
        var k = Math.round((prev - m) / 360)
        var now = m + 360 * k
        if (now < prev) now += 360
        prev = now
        var c = crossings(now, list)
        // a fast wheel can pass several pegs inside one frame; three is as many as an ear reads
        var n = Math.min(3, c - counted)
        counted = c
        for (var i = 0; i < n; i++) click()
      }
      tickRaf = requestAnimationFrame(step)
    }
    tickRaf = requestAnimationFrame(step)
    return function () { if (tickRaf) cancelAnimationFrame(tickRaf); tickRaf = 0 }
  }

  /** how many wedge edges have gone past the pointer by rotation R */
  function crossings(R, list) {
    var n = 0
    for (var i = 0; i < list.length; i++) n += Math.floor((R + list[i].from) / 360)
    return n
  }

  function matrixAngle(el) {
    var tr = getComputedStyle(el).transform
    if (!tr || tr === 'none') return null
    var nums = tr.slice(tr.indexOf('(') + 1, tr.lastIndexOf(')')).split(',')
    if (nums.length < 4) return null
    return Math.atan2(parseFloat(nums[1]), parseFloat(nums[0])) * 180 / Math.PI
  }

  function startSpinSound(list, from) {
    var kind = cfg.spinSoundKind == null ? (cfg.spinSound ? 'custom' : 'tick') : cfg.spinSoundKind
    if (kind === 'none') return null
    if (kind === 'whoosh') return startWhoosh()
    if (kind === 'drumroll') return startDrumroll()
    if (kind === 'custom') return cfg.spinSound ? startCustomLoop(cfg.spinSound) : null
    return startTicks(list, from)
  }

  /**
   * Turn to the wedge the app picked.
   *
   * The wheel turns clockwise, so landing wedge N under the pointer means rotating by whole turns
   * MINUS that wedge's middle angle — going the other way lands on its mirror image, which looks
   * right until somebody checks it against the announcement in chat.
   */
  function spinTo(index, spinMs, turns) {
    var list = slices()
    if (!list.length) return
    var i = Math.max(0, Math.min(index, list.length - 1))
    var mid = list[i].mid
    var current = ((angle % 360) + 360) % 360
    var target = (360 - mid) % 360
    var delta = ((target - current) + 360) % 360
    var from = angle
    angle = angle + Math.max(0, turns || 5) * 360 + delta
    spinning = true

    var svg = document.getElementById('wheel')
    if (svg) {
      svg.style.transition = 'transform ' + spinMs + 'ms ' + easingCurve()
      svg.style.transform = 'rotate(' + angle + 'deg)'
    }
    stopSpinSound = startSpinSound(list, from)
    setTimeout(function () { land(list[i].s.label) }, spinMs)
  }

  function land(label) {
    spinning = false
    if (stopSpinSound) { try { stopSpinSound() } catch (err) { /* noop */ } stopSpinSound = null }
    playWin()
    /**
     * Whatever changed while it was turning happens now.
     *
     * A wedge set to remove itself on winning is dropped from the config the moment the spin is
     * sent, so its new shape arrives while the wheel is mid-turn — exactly when a redraw is
     * forbidden, because rebuilding the svg would throw away the running transition and the wheel
     * would snap to its final angle. The change was simply lost, and the wedge that had just
     * "gone" was still there. It is redrawn once the result has had its moment instead.
     */
    var redraw = function () {
      if (!pendingRender || spinning) return
      pendingRender = false
      render()
    }
    if (!cfg.resultShow) {
      redraw()
      return
    }
    var res = document.getElementById('result')
    if (!res) {
      redraw()
      return
    }
    res.textContent = label || ''
    res.classList.add('on')
    setTimeout(function () {
      res.classList.remove('on')
      redraw()
    }, Math.max(0, (cfg.resultS || 0) * 1000))
  }

  /**
   * Say why the wheel is not there.
   *
   * An overlay that shows nothing looks the same whether it was deleted, whether StickiChat is
   * closed, or whether the page was loaded while the server was down — and only the last of those
   * is fixed by refreshing the source, so the page has to name which one it is.
   */
  var noteBox = null
  function note(text) {
    if (!text) { if (noteBox) { noteBox.remove(); noteBox = null } return }
    if (!noteBox) {
      noteBox = document.createElement('div')
      noteBox.id = 'gone'
      document.body.appendChild(noteBox)
    }
    noteBox.textContent = text
  }
  function gone(on) { note(on ? 'Цей оверлей видалено в StickiChat. Онови URL джерела в OBS.' : '') }

  var seen = {}
  var gotCfg = false
  function connect() {
    var es = new EventSource('/events?channel=' + encodeURIComponent(channel) + '&profile=' + encodeURIComponent(profile))
    es.addEventListener('cfg', function (e) {
      try {
        gotCfg = true
        cfg = Object.assign(cfg, JSON.parse(e.data))
        gone(false)
        // never redraw mid-spin: rebuilding the svg would drop the running transition and the
        // wheel would jump to its final angle instantly. It is not dropped either — land() picks
        // it up once the wheel has stopped and the result has been read
        if (spinning) pendingRender = true
        else render()
      } catch (err) { /* noop */ }
    })
    es.addEventListener('gone', function () { gone(true) })
    es.onmessage = function (e) {
      try {
        var d = JSON.parse(e.data)
        if (!d || !d.wheel) return
        // the backlog replays on connect; a spin from before this source existed is history
        if (Date.now() - (d.ts || 0) > 30000) return
        if (seen[d.wheel.id]) return
        seen[d.wheel.id] = 1
        spinTo(d.wheel.index, d.wheel.spinMs, d.wheel.turns)
      } catch (err) { /* noop */ }
    }
    es.onerror = function () {
      es.close()
      if (!gotCfg) note('StickiChat не відповідає. Запусти застосунок, тоді онови це джерело в OBS.')
      setTimeout(connect, 3000)
    }
  }
  render()
  connect()

  if (preview) {
    var n = 0
    setInterval(function () {
      if (spinning || cfg.previewDemo === false) return
      var list = slices()
      if (!list.length) return
      n = (n + 1) % list.length
      spinTo(n, Math.max(300, (cfg.spinS || 6) * 1000), cfg.turns || 5)
    }, Math.max(2000, ((cfg.spinS || 6) + (cfg.resultS || 4) + 1) * 1000))
  }

  window.__oe = {
    cfg: cfg, render: render, spinTo: spinTo, slices: slices,
    angleOf: function () { return angle },
    playWin: playWin, click: click, startSpinSound: startSpinSound
  }
})()
</script>
</body>
</html>`
