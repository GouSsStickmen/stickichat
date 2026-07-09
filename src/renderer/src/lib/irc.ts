export interface IrcMessage {
  raw: string
  tags: Record<string, string>
  prefix: string
  nick: string
  command: string
  params: string[]
  /** trailing parameter (message text) */
  trailing: string
  channel: string // without '#', if first param is a channel
}

const TAG_UNESCAPE: Record<string, string> = {
  '\\:': ';',
  '\\s': ' ',
  '\\\\': '\\',
  '\\r': '\r',
  '\\n': '\n'
}

function unescapeTag(value: string): string {
  return value.replace(/\\[:s\\rn]/g, (m) => TAG_UNESCAPE[m] ?? m)
}

export function parseIrcLine(line: string): IrcMessage | null {
  if (!line) return null
  let rest = line
  const tags: Record<string, string> = {}

  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ')
    if (sp === -1) return null
    const tagStr = rest.slice(1, sp)
    rest = rest.slice(sp + 1)
    for (const part of tagStr.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) tags[part] = ''
      else tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1))
    }
  }

  let prefix = ''
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ')
    if (sp === -1) return null
    prefix = rest.slice(1, sp)
    rest = rest.slice(sp + 1)
  }

  let trailing = ''
  const colon = rest.indexOf(' :')
  let paramStr = rest
  if (colon !== -1) {
    trailing = rest.slice(colon + 2)
    paramStr = rest.slice(0, colon)
  }
  const params = paramStr.split(' ').filter(Boolean)
  const command = params.shift() ?? ''

  // recent-messages.robotty.de (and occasionally raw IRC) can omit the
  // leading ':' for a single-word trailing param (e.g. a lone emote like
  // "uhoh"), which would otherwise silently drop the message body.
  if (!trailing && ['PRIVMSG', 'NOTICE', 'USERNOTICE', 'CLEARCHAT'].includes(command) && params.length >= 2) {
    trailing = params.pop()!
  }

  const nick = prefix.includes('!') ? prefix.slice(0, prefix.indexOf('!')) : prefix
  const channel = params[0]?.startsWith('#') ? params[0].slice(1) : ''

  return { raw: line, tags, prefix, nick, command, params, trailing, channel }
}

export interface IrcClientOptions {
  nick: string
  /** oauth token WITHOUT the 'oauth:' prefix; omit for anonymous */
  token?: string
  onMessage: (msg: IrcMessage) => void
  onOpen?: () => void
  onClose?: () => void
}

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443'

/**
 * A single IRC connection. Auto-reconnects with backoff and rejoins channels.
 */
export class IrcClient {
  private ws: WebSocket | null = null
  private channels = new Set<string>()
  private closed = false
  private backoff = 1000
  private opts: IrcClientOptions
  private sendQueue: string[] = []
  private reconnectTimer: number | null = null
  ready = false

  constructor(opts: IrcClientOptions) {
    this.opts = opts
    this.connect()
  }

  private connect(): void {
    if (this.closed) return
    // Neuter the previous socket completely before replacing it. A stale socket whose
    // handlers stay alive keeps scheduling reconnects and keeps delivering messages —
    // connections multiply and every chat line starts arriving N times.
    const old = this.ws
    if (old) {
      old.onopen = null
      old.onmessage = null
      old.onclose = null
      old.onerror = null
      try {
        old.close()
      } catch {
        /* noop */
      }
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(IRC_URL)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.backoff = 1000
      const pass = this.opts.token ? `oauth:${this.opts.token}` : 'SCHMOOPIIE'
      const nick = this.opts.token
        ? this.opts.nick
        : `justinfan${Math.floor(10000 + Math.random() * 80000)}`
      this.rawSend(`CAP REQ :twitch.tv/tags twitch.tv/commands`)
      this.rawSend(`PASS ${pass}`)
      this.rawSend(`NICK ${nick}`)
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      const data = String(ev.data)
      for (const line of data.split('\r\n')) {
        if (!line) continue
        const msg = parseIrcLine(line)
        if (!msg) continue
        if (msg.command === 'PING') {
          this.rawSend(`PONG :${msg.trailing}`)
          continue
        }
        if (msg.command === '001') {
          this.ready = true
          for (const ch of this.channels) this.rawSend(`JOIN #${ch}`)
          for (const q of this.sendQueue) this.rawSend(q)
          this.sendQueue = []
          this.opts.onOpen?.()
          continue
        }
        this.opts.onMessage(msg)
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ready = false
      this.opts.onClose?.()
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      // close THIS socket specifically — this.ws may already point to a newer one
      try {
        ws.close()
      } catch {
        /* noop */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    if (this.reconnectTimer !== null) return // only ever one pending reconnect
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 30000)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private rawSend(line: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(line)
  }

  /** send now if ready, otherwise queue until registered */
  private sendOrQueue(line: string): void {
    if (this.ready) this.rawSend(line)
    else this.sendQueue.push(line)
  }

  join(channel: string): void {
    const ch = channel.toLowerCase()
    if (this.channels.has(ch)) return
    this.channels.add(ch)
    this.sendOrQueue(`JOIN #${ch}`)
  }

  part(channel: string): void {
    const ch = channel.toLowerCase()
    if (!this.channels.delete(ch)) return
    this.sendOrQueue(`PART #${ch}`)
  }

  isJoined(channel: string): boolean {
    return this.channels.has(channel.toLowerCase())
  }

  say(channel: string, text: string, replyParentMsgId?: string): void {
    const tag = replyParentMsgId ? `@reply-parent-msg-id=${replyParentMsgId} ` : ''
    this.sendOrQueue(`${tag}PRIVMSG #${channel.toLowerCase()} :${text}`)
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}
