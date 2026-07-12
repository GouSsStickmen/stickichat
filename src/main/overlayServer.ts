import { createServer, Server, ServerResponse } from 'http'

/**
 * Local chat-overlay server for OBS Browser Source.
 *
 * GET /overlay?channel=x  → transparent, self-contained overlay page
 * GET /events?channel=x   → SSE stream: `cfg` events (live style config) + chat lines
 *
 * The renderer pushes ready-made HTML lines and the CURRENT style over IPC; style changes
 * are broadcast to every connected source immediately — no OBS refresh needed.
 * Listens on 127.0.0.1 only.
 */

export interface OverlayStyle {
  size: number
  font: string
  /** data URL of an uploaded font file — injected as @font-face on the overlay page */
  fontData?: string
  fade: number
  max: number
  gap: number
  bold: boolean
  textColor: string
  outlineWidth: number
  outlineColor: string
  bg: string // ready rgba() or '' for transparent
}

interface SseClient {
  channel: string
  res: ServerResponse
}

interface OverlayLine {
  html: string
  id: string
  user: string
}

export interface OverlayDelete {
  id?: string
  user?: string
  all?: boolean
}

let server: Server | null = null
let currentPort = 0
let currentStyle: OverlayStyle | null = null
const clients = new Set<SseClient>()
/** channel -> last rendered lines, replayed to a client on connect */
const backlog = new Map<string, OverlayLine[]>()
const BACKLOG_LIMIT = 30

export function overlayPush(channel: string, html: string, id: string, user: string): void {
  const list = backlog.get(channel) ?? []
  list.push({ html, id, user })
  if (list.length > BACKLOG_LIMIT) list.shift()
  backlog.set(channel, list)
  const payload = `data: ${JSON.stringify({ html, id, user })}\n\n`
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

function broadcastStyle(): void {
  if (!currentStyle) return
  const payload = `event: cfg\ndata: ${JSON.stringify(currentStyle)}\n\n`
  for (const c of clients) {
    try {
      c.res.write(payload)
    } catch {
      clients.delete(c)
    }
  }
}

export function overlayConfigure(enabled: boolean, port: number, style?: OverlayStyle): void {
  if (style) {
    currentStyle = style
    broadcastStyle()
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
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      })
      res.write(':ok\n\n')
      // current style first, then the backlog so the overlay isn't empty after a scene switch
      if (currentStyle) res.write(`event: cfg\ndata: ${JSON.stringify(currentStyle)}\n\n`)
      for (const line of backlog.get(channel) ?? []) {
        res.write(`data: ${JSON.stringify(line)}\n\n`)
      }
      const client: SseClient = { channel, res }
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
    padding: 8px;
    box-sizing: border-box;
    max-height: 100%;
    color: #fff;
  }
  .line {
    line-height: 1.45;
    overflow-wrap: anywhere;
    padding: 2px 6px;
    border-radius: 6px;
    animation: in 0.15s ease;
    transition: opacity 0.6s ease;
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
  const chat = document.getElementById('chat')
  // live config pushed by the app; sensible defaults until the first cfg event lands
  let cfg = { size: 16, font: '', fontData: '', fade: 0, max: 15, gap: 2, bold: false,
              textColor: '#ffffff', outlineWidth: 2, outlineColor: '#000000', bg: '' }
  const fontFace = document.createElement('style')
  document.head.appendChild(fontFace)

  function outlineShadow(w, color) {
    if (!w) return 'none'
    const s = []
    for (let x = -w; x <= w; x++)
      for (let y = -w; y <= w; y++)
        if (x || y) s.push(x + 'px ' + y + 'px 0 ' + color)
    return s.join(', ')
  }

  function applyCfg() {
    // uploaded fonts arrive as a data URL and become a @font-face rule
    fontFace.textContent = cfg.fontData
      ? "@font-face { font-family: '" + (cfg.font || 'OverlayFont').replace(/'/g, '') + "'; src: url('" + cfg.fontData + "'); }"
      : ''
    chat.style.fontFamily = cfg.font ? "'" + cfg.font.replace(/'/g, '') + "', 'Segoe UI', sans-serif" : "'Segoe UI', sans-serif"
    chat.style.fontSize = cfg.size + 'px'
    chat.style.fontWeight = cfg.bold ? '600' : '400'
    chat.style.color = cfg.textColor
    chat.style.gap = cfg.gap + 'px'
    for (const el of chat.children) styleLine(el)
  }

  function styleLine(div) {
    div.style.textShadow = outlineShadow(cfg.outlineWidth, cfg.outlineColor)
    div.style.background = cfg.bg || 'transparent'
  }

  function append(d) {
    const div = document.createElement('div')
    div.className = 'line'
    if (d.id) div.dataset.id = d.id
    if (d.user) div.dataset.user = d.user
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
    const es = new EventSource('/events?channel=' + encodeURIComponent(channel))
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
