import { Account } from '../types'
import { createEventSubSubscription } from './helix'

/**
 * Twitch EventSub over WebSocket. Used for things IRC no longer delivers — whispers
 * (removed from IRC in 2023) and reliable raid detection (a raid started by another mod
 * or from the Twitch dashboard never reaches us over IRC).
 *
 * Lifecycle: connect → `session_welcome` gives a session id → we POST every desired
 * subscription bound to that session → `notification` frames carry the events. On reconnect
 * Twitch issues a fresh session, so all subscriptions are recreated.
 */
const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws'

export interface EventSubDesired {
  /** account whose user token authorizes the subscription POST */
  account: Account
  type: string
  version: string
  condition: Record<string, string>
  /** stable id used to avoid creating the same subscription twice in one session */
  key: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventHandler = (type: string, event: Record<string, any>) => void
type SubErrorHandler = (desired: EventSubDesired, status: number) => void

interface EnvelopeMeta {
  message_type: string
}

export class EventSubClient {
  private ws: WebSocket | null = null
  private sessionId: string | null = null
  private closed = false
  private backoff = 1000
  private reconnectTimer: number | null = null
  private keepaliveTimer: number | null = null
  private keepaliveSec = 30
  private pendingUrl: string | null = null
  /** subscription keys already created for the CURRENT session */
  private created = new Set<string>()
  private getDesired: () => EventSubDesired[]
  private onEvent: EventHandler
  private onSubError?: SubErrorHandler
  private subscribing = false

  constructor(getDesired: () => EventSubDesired[], onEvent: EventHandler, onSubError?: SubErrorHandler) {
    this.getDesired = getDesired
    this.onEvent = onEvent
    this.onSubError = onSubError
    this.connect()
  }

  private connect(): void {
    if (this.closed) return
    const url = this.pendingUrl ?? EVENTSUB_URL
    this.pendingUrl = null
    const old = this.ws
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      try {
        old.close()
      } catch {
        /* noop */
      }
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      this.resetKeepalive()
      let msg: { metadata: EnvelopeMeta; payload: Record<string, unknown> }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      this.handle(msg)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* noop */
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handle(msg: { metadata: EnvelopeMeta; payload: any }): void {
    switch (msg.metadata?.message_type) {
      case 'session_welcome': {
        this.sessionId = msg.payload?.session?.id ?? null
        this.keepaliveSec = msg.payload?.session?.keepalive_timeout_seconds ?? 30
        this.backoff = 1000
        this.created.clear()
        this.subscribeAll()
        break
      }
      case 'session_keepalive':
        break
      case 'session_reconnect':
        this.pendingUrl = msg.payload?.session?.reconnect_url ?? null
        this.connect()
        break
      case 'revocation': {
        const key = msg.payload?.subscription?.type
        if (key) this.created.delete(key)
        break
      }
      case 'notification': {
        const type = msg.payload?.subscription?.type
        const event = msg.payload?.event
        if (type && event) this.onEvent(type, event)
        break
      }
    }
  }

  /** (re)create every desired subscription not yet made for this session */
  private async subscribeAll(): Promise<void> {
    if (!this.sessionId || this.subscribing) return
    this.subscribing = true
    try {
      for (const d of this.getDesired()) {
        if (this.created.has(d.key)) continue
        if (!this.sessionId) break
        try {
          const res = await createEventSubSubscription(d.account, d.type, d.version, d.condition, this.sessionId)
          // 409 = already exists for this session; both mean "it's active now"
          if (res.ok || res.status === 409) {
            this.created.add(d.key)
          } else {
            console.warn('[eventsub] subscribe failed', d.type, res.status, res.json ?? res.text)
            // a 4xx won't fix itself on retry (bad scope / bad condition) — stop hammering it
            // every reconnect; only 5xx / network errors are worth retrying
            if (res.status >= 400 && res.status < 500) this.created.add(d.key)
            this.onSubError?.(d, res.status)
          }
        } catch (e) {
          console.warn('[eventsub] subscribe error', d.type, e)
        }
      }
    } finally {
      this.subscribing = false
    }
  }

  /** desired set changed (accounts/channels) — add anything new to the live session */
  resync(): void {
    this.subscribeAll()
  }

  private resetKeepalive(): void {
    if (this.keepaliveTimer !== null) clearTimeout(this.keepaliveTimer)
    // no frame within 1.5× the keepalive window means the connection is dead
    this.keepaliveTimer = window.setTimeout(() => {
      try {
        this.ws?.close()
      } catch {
        /* noop */
      }
    }, this.keepaliveSec * 1500)
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    if (this.reconnectTimer !== null) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 30000)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    if (this.keepaliveTimer !== null) clearTimeout(this.keepaliveTimer)
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}
