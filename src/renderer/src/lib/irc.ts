import { diagSocket } from './diag'

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
  /**
   * Called on EVERY (re)connect to obtain a fresh token — this is what stops the "silent
   * logout": a reconnect after the token expired fetches a refreshed one instead of
   * re-sending the dead token in a loop. Return undefined if a token can't be produced.
   */
  getToken?: () => Promise<string | undefined>
  /** the login itself was rejected and couldn't be refreshed — needs full re-authorization */
  onAuthFailed?: () => void
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
  // consecutive login rejections; after a couple we stop looping and ask for re-auth
  private authFailures = 0
  private authStopped = false
  /**
   * Keepalive watchdog. A long-idle socket dies silently behind NAT — `readyState` still says
   * OPEN, so everything sent after that goes into the void and nothing arrives.
   *
   * The old numbers were 240s idle / 30s poll / 15s grace, i.e. up to FOUR AND THREE QUARTER
   * MINUTES before a dead socket was noticed. A user on a flaky line reported the chat going
   * blank "for about five minutes" at a time, and their log has a 4m31s hole in exactly the
   * window they named: the network blip lasted seconds, the rest was us sitting on a corpse.
   * Chatterino survives the same line because it probes far more often.
   *
   * 45/10/10 detects it in about a minute. The cost is one PING a minute on a silent channel.
   */
  private static readonly IDLE_BEFORE_PING = 45_000
  private static readonly PONG_GRACE = 10_000
  private static readonly WATCHDOG_TICK = 10_000
  private lastActivity = Date.now()
  private pingSentAt: number | null = null
  private watchdog: number
  ready = false

  constructor(opts: IrcClientOptions) {
    this.opts = opts
    this.connect()
    this.watchdog = window.setInterval(() => {
      if (this.closed || this.authStopped) return
      const now = Date.now()
      if (this.pingSentAt !== null && now - this.pingSentAt > IrcClient.PONG_GRACE) {
        // pinged and heard nothing — the socket is dead, rebuild it now
        diagSocket('irc', 'watchdog timeout', `no PONG in ${IrcClient.PONG_GRACE / 1000}s — reconnecting`)
        this.pingSentAt = null
        this.ready = false
        this.connect()
        return
      }
      if (this.ready && this.pingSentAt === null && now - this.lastActivity > IrcClient.IDLE_BEFORE_PING) {
        this.pingSentAt = now
        this.rawSend('PING :keepalive')
      }
    }, IrcClient.WATCHDOG_TICK)
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
      diagSocket('irc', 'connecting', `${this.opts.nick} · ${this.channels.size} channel(s)`)
      ws = new WebSocket(IRC_URL)
    } catch (e) {
      diagSocket('irc', 'connect threw', String(e))
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = async () => {
      if (this.ws !== ws) return
      this.backoff = 1000
      // authenticated clients re-fetch a fresh token on every connect, so a reconnect after
      // the token expired logs in with a refreshed one instead of the dead one
      let token = this.opts.token
      if (this.opts.getToken) {
        try {
          token = await this.opts.getToken()
        } catch {
          token = undefined
        }
        if (this.ws !== ws) return // socket was replaced while awaiting the token
        if (!token) {
          // no token could be produced — refresh itself failed; stop hammering and surface it
          diagSocket('irc', 'auth stopped', 'no token could be produced — re-authorization needed')
          this.authStopped = true
          this.opts.onAuthFailed?.()
          try {
            ws.close()
          } catch {
            /* noop */
          }
          return
        }
        this.opts.token = token
      }
      const pass = token ? `oauth:${token}` : 'SCHMOOPIIE'
      const nick = token ? this.opts.nick : `justinfan${Math.floor(10000 + Math.random() * 80000)}`
      this.rawSend(`CAP REQ :twitch.tv/tags twitch.tv/commands`)
      this.rawSend(`PASS ${pass}`)
      this.rawSend(`NICK ${nick}`)
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      // ANY traffic proves the connection is alive — clear the keepalive probe
      this.lastActivity = Date.now()
      this.pingSentAt = null
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
          this.authFailures = 0 // a successful login clears the failure streak
          diagSocket(
            'irc',
            'logged in',
            `as ${msg.params[0] ?? '?'} · joining ${this.channels.size} · ${this.sendQueue.length} queued`
          )
          for (const ch of this.channels) this.rawSend(`JOIN #${ch}`)
          for (const q of this.sendQueue) this.rawSend(q)
          this.sendQueue = []
          this.opts.onOpen?.()
          continue
        }
        // Twitch rejects a bad/expired token with an un-channelled NOTICE then drops the socket.
        // Reconnecting re-fetches a fresh token (getToken); but if it keeps failing the refresh
        // token is dead — stop the reconnect loop and ask for a full re-authorization.
        if (
          msg.command === 'NOTICE' &&
          !msg.channel &&
          /login authentication failed|improperly formatted auth|login unsuccessful/i.test(
            msg.trailing ?? ''
          )
        ) {
          this.authFailures++
          diagSocket('irc', 'login rejected', `${msg.trailing ?? ''} (attempt ${this.authFailures})`)
          if (this.opts.getToken && this.authFailures >= 3) {
            this.authStopped = true
            this.opts.onAuthFailed?.()
          }
          continue
        }
        this.opts.onMessage(msg)
      }
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      // the close CODE is the one thing that separates "Twitch asked us to go away" from
      // "the line dropped underneath us", and it never used to be recorded anywhere
      diagSocket(
        'irc',
        'closed',
        `code=${ev.code} clean=${ev.wasClean} reason="${ev.reason || '-'}" idle=${Math.round(
          (Date.now() - this.lastActivity) / 1000
        )}s`
      )
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
    if (this.authStopped) return // login is dead — wait for retryAuth() after re-authorization
    if (this.reconnectTimer !== null) return // only ever one pending reconnect
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 30000)
    diagSocket('irc', 'reconnect scheduled', `in ${delay}ms`)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private rawSend(line: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(line)
  }

  /** send now if the socket is really open, otherwise queue AND kick a reconnect —
   *  previously a half-dead socket silently swallowed the first message after idle */
  private sendOrQueue(line: string): void {
    if (this.ready && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(line)
      return
    }
    this.sendQueue.push(line)
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.ready = false
      if (this.reconnectTimer === null) this.connect()
    }
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

  /**
   * Is this connection actually working right now?
   *
   * Not just `readyState === OPEN` — that is the very thing that lies when a socket dies
   * behind NAT, which is why the watchdog exists at all. A live connection is one that is
   * open, logged in, and has heard something from Twitch recently; the server sends at
   * minimum a PING every few minutes, so silence past the watchdog's own idle threshold
   * means it is not to be trusted.
   */
  isHealthy(): boolean {
    if (this.closed || !this.ready) return false
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    return Date.now() - this.lastActivity < IrcClient.IDLE_BEFORE_PING + IrcClient.PONG_GRACE
  }

  say(channel: string, text: string, replyParentMsgId?: string): void {
    const tag = replyParentMsgId ? `@reply-parent-msg-id=${replyParentMsgId} ` : ''
    this.sendOrQueue(`${tag}PRIVMSG #${channel.toLowerCase()} :${text}`)
  }

  /** manually swap in a fresh token (e.g. right after a successful re-authorization) */
  updateToken(token: string): void {
    this.opts.token = token
  }

  /**
   * Apply a fresh token and reconnect NOW, so a long-lived session is proactively rotated onto
   * a new token before the old one expires — the user never hits the "can't send after a while"
   * dead-token window.
   */
  reconnectWithToken(token: string): void {
    this.opts.token = token
    if (this.closed) return
    this.authStopped = false
    this.authFailures = 0
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.connect()
  }

  /** re-authorization succeeded — clear the failure state and reconnect immediately */
  retryAuth(): void {
    this.authFailures = 0
    if (!this.authStopped) return
    this.authStopped = false
    this.backoff = 1000
    this.connect()
  }

  close(): void {
    this.closed = true
    window.clearInterval(this.watchdog)
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
