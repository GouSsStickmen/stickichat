import { createServer, Server, ServerResponse } from 'http'

/**
 * Local chat-overlay server for OBS Browser Source.
 *
 * GET /overlay?channel=x&profile=id  → transparent, self-contained overlay page
 * GET /events?channel=x&profile=id   → SSE: `cfg` (live style of THAT profile) + chat lines
 *
 * Styles are per named PROFILE — the same chat can be added to several OBS sources with
 * different looks. The renderer pushes ready-made HTML lines and the full profile→style
 * map over IPC; style changes broadcast instantly to the sources using that profile.
 * Listens on 127.0.0.1 only.
 */

export interface OverlayStyle {
  size: number
  font: string
  /** data URL of an uploaded font file — injected as @font-face on the overlay page */
  fontData?: string
  bold: boolean
  textColor: string
  textAlign: string
  outlineWidth: number
  outlineColor: string
  shadowBlur: number
  shadowColor: string
  glowSize: number
  glowColor: string
  bgMode: string // none | fit | line | panel
  bg: string // ready rgba() or '' for transparent
  bgRadius: number
  bgShadowBlur: number
  bgShadowColor: string
  bgImage?: string
  gap: number
  fade: number
  max: number
}

interface SseClient {
  channel: string
  profile: string
  res: ServerResponse
}

interface OverlayLine {
  html: string
  id: string
  /** user id — used for delete-by-user (timeouts) */
  user: string
  /** login — used for the per-profile hidden-users filter (which stores logins) */
  login: string
}

export interface OverlayDelete {
  id?: string
  user?: string
  all?: boolean
}

let server: Server | null = null
let currentPort = 0
let styles: Record<string, OverlayStyle> = {}
const clients = new Set<SseClient>()
/** channel -> last rendered lines, replayed to a client on connect */
const backlog = new Map<string, OverlayLine[]>()
const BACKLOG_LIMIT = 30

function styleFor(profile: string): OverlayStyle | undefined {
  return styles[profile] ?? Object.values(styles)[0]
}

export function overlayPush(channel: string, html: string, id: string, user: string, login: string): void {
  const list = backlog.get(channel) ?? []
  list.push({ html, id, user, login })
  if (list.length > BACKLOG_LIMIT) list.shift()
  backlog.set(channel, list)
  const payload = `data: ${JSON.stringify({ html, id, user, login })}\n\n`
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

export function overlayConfigure(enabled: boolean, port: number, newStyles?: Record<string, OverlayStyle>): void {
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
      // this profile's style first, then the backlog so the overlay isn't empty on connect
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

/** Self-contained overlay page; ALL styling arrives live via the `cfg` SSE event. */
const OVERLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>StickiChat Overlay</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; height: 100%; }
  #chat {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: stretch;
    padding: 8px;
    box-sizing: border-box;
    max-height: 100%;
    color: #fff;
  }
  .line {
    line-height: 1.45;
    overflow-wrap: anywhere;
    padding: 2px 8px;
    animation: in 0.15s ease;
    transition: opacity 0.6s ease;
    box-sizing: border-box;
    position: relative;
  }
  /* custom background image as its own layer so its opacity is independent of the text/plate.
     Works for both the whole-chat panel and per-line plates; sits behind the content.
     isolation:isolate makes a stacking context so the z-index:-1 layer stays BEHIND the text
     but IN FRONT of the transparent page (without it the image fell behind the OBS source). */
  /* #chat is already position:absolute (its bottom anchor must NOT be overridden); just add a
     stacking context. Lines are static, so they need position:relative for the ::before. */
  #chat.has-img { isolation: isolate; }
  .line.has-img { position: relative; isolation: isolate; }
  #chat.has-img::before, .line.has-img::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image: var(--bg-img);
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    opacity: var(--bg-img-op, 1);
    border-radius: inherit;
    z-index: -1;
    pointer-events: none;
  }
  .line img.emote { height: 1.4em; vertical-align: -0.3em; margin: 0 1px; }
  .line img.badge { height: 1.1em; vertical-align: -0.18em; margin-right: 3px; border-radius: 2px; }
  .line .nick { font-weight: 700; }
  .line .sys { font-style: italic; opacity: 0.85; }
  @keyframes in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
</style>
</head>
<body>
<div id="chat"></div>
<script>
  const p = new URLSearchParams(location.search)
  const channel = (p.get('channel') || '').toLowerCase()
  const profile = p.get('profile') || ''
  const chat = document.getElementById('chat')
  // live config pushed by the app; sensible defaults until the first cfg event lands
  let cfg = { size: 16, font: '', fontData: '', bold: false, textColor: '#ffffff', textAlign: 'left',
              outlineWidth: 2, outlineColor: '#000000', shadowBlur: 0, shadowColor: '#000000',
              glowSize: 0, glowColor: '#a970ff', bgMode: 'none', bg: '', bgRadius: 8,
              bgShadowBlur: 0, bgShadowColor: '#000000', bgImage: '', bgImageOpacity: 1,
              hiddenUsers: [], gap: 2, fade: 0, max: 15 }
  const fontFace = document.createElement('style')
  document.head.appendChild(fontFace)

  function textShadow() {
    const parts = []
    const w = cfg.outlineWidth
    if (w > 0) {
      for (let x = -w; x <= w; x++)
        for (let y = -w; y <= w; y++)
          if (x || y) parts.push(x + 'px ' + y + 'px 0 ' + cfg.outlineColor)
    }
    if (cfg.shadowBlur > 0) parts.push('0 2px ' + cfg.shadowBlur + 'px ' + cfg.shadowColor)
    if (cfg.glowSize > 0) {
      parts.push('0 0 ' + cfg.glowSize + 'px ' + cfg.glowColor)
      parts.push('0 0 ' + cfg.glowSize * 2 + 'px ' + cfg.glowColor)
    }
    return parts.length ? parts.join(', ') : 'none'
  }

  function applyCfg() {
    fontFace.textContent = cfg.fontData
      ? "@font-face { font-family: '" + (cfg.font || 'OverlayFont').replace(/'/g, '') + "'; src: url('" + cfg.fontData + "'); }"
      : ''
    chat.style.fontFamily = cfg.font ? "'" + cfg.font.replace(/'/g, '') + "', 'Segoe UI', sans-serif" : "'Segoe UI', sans-serif"
    chat.style.fontSize = cfg.size + 'px'
    chat.style.fontWeight = cfg.bold ? '600' : '400'
    chat.style.color = cfg.textColor
    chat.style.gap = cfg.gap + 'px'
    chat.style.textAlign = cfg.textAlign
    chat.style.alignItems = cfg.bgMode === 'fit'
      ? (cfg.textAlign === 'center' ? 'center' : cfg.textAlign === 'right' ? 'flex-end' : 'flex-start')
      : 'stretch'
    // leave room for large drop shadows / glow so they aren't clipped by the window edge
    // (body overflow:hidden used to cut off shadows once the blur exceeded the 8px padding)
    const room = Math.max(8, cfg.bgShadowBlur || 0, cfg.shadowBlur || 0, cfg.glowSize || 0)
    chat.style.padding = room + 'px'
    // panel: one backdrop under the whole chat column
    if (cfg.bgMode === 'panel') {
      chat.style.background = cfg.bg || 'transparent'
      chat.style.borderRadius = cfg.bgRadius + 'px'
      chat.style.boxShadow = cfg.bgShadowBlur > 0 ? '0 4px ' + cfg.bgShadowBlur + 'px ' + cfg.bgShadowColor : 'none'
      applyImage(chat)
    } else {
      chat.style.background = 'transparent'
      chat.style.borderRadius = '0'
      chat.style.boxShadow = 'none'
      applyImage(chat, true)
    }
    for (const el of [...chat.children]) {
      // a live hidden-users edit should drop lines already on screen
      if (isHidden(el.dataset.login)) { el.remove(); continue }
      styleLine(el)
    }
  }

  // sets/clears the custom-image layer (a ::before) on an element via CSS variables
  function applyImage(el, clear) {
    if (clear || !cfg.bgImage) {
      el.classList.remove('has-img')
      el.style.removeProperty('--bg-img')
      el.style.removeProperty('--bg-img-op')
      return
    }
    el.classList.add('has-img')
    el.style.setProperty('--bg-img', "url('" + cfg.bgImage + "')")
    el.style.setProperty('--bg-img-op', String(cfg.bgImageOpacity == null ? 1 : cfg.bgImageOpacity))
  }

  function styleLine(div) {
    div.style.textShadow = textShadow()
    const perLine = cfg.bgMode === 'fit' || cfg.bgMode === 'line'
    div.style.background = perLine ? (cfg.bg || 'transparent') : 'transparent'
    div.style.borderRadius = perLine ? cfg.bgRadius + 'px' : '0'
    div.style.boxShadow = perLine && cfg.bgShadowBlur > 0 ? '0 2px ' + cfg.bgShadowBlur + 'px ' + cfg.bgShadowColor : 'none'
    div.style.width = cfg.bgMode === 'fit' ? 'fit-content' : ''
    div.style.maxWidth = '100%'
    // per-message plates can carry the custom image too (transparent-capable)
    applyImage(div, !perLine)
  }

  function isHidden(login) {
    return login && (cfg.hiddenUsers || []).indexOf(String(login).toLowerCase()) !== -1
  }

  function append(d) {
    // per-profile hidden users: this overlay skips them even though other profiles show them
    if (isHidden(d.login)) return
    const div = document.createElement('div')
    div.className = 'line'
    if (d.id) div.dataset.id = d.id
    if (d.user) div.dataset.user = d.user
    if (d.login) div.dataset.login = d.login
    styleLine(div)
    div.innerHTML = d.html
    chat.appendChild(div)
    while (chat.children.length > cfg.max) chat.removeChild(chat.firstChild)
    if (cfg.fade > 0) {
      setTimeout(() => { div.style.opacity = '0' }, cfg.fade * 1000)
      setTimeout(() => { div.remove() }, cfg.fade * 1000 + 700)
    }
  }

  function connect() {
    const es = new EventSource('/events?channel=' + encodeURIComponent(channel) + '&profile=' + encodeURIComponent(profile))
    es.addEventListener('cfg', (e) => {
      try { cfg = Object.assign(cfg, JSON.parse(e.data)); applyCfg() } catch {}
    })
    // messages deleted / users timed out in chat disappear from the overlay too
    es.addEventListener('del', (e) => {
      try {
        const d = JSON.parse(e.data)
        for (const el of [...chat.children]) {
          if (d.all || (d.id && el.dataset.id === d.id) || (d.user && el.dataset.user === d.user)) el.remove()
        }
      } catch {}
    })
    es.onmessage = (e) => {
      try { append(JSON.parse(e.data)) } catch {}
    }
    es.onerror = () => { es.close(); setTimeout(connect, 3000) }
  }
  applyCfg()
  connect()
</script>
</body>
</html>`
