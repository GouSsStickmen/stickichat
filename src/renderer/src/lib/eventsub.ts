import { Account } from '../types'
import { createEventSubSubscription, describeHelixError } from './helix'
import { retryAfterMs } from './http'
import { diagInfo, diagSocket, diagWarn } from './diag'

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
  /** channel login this subscription concerns (for per-channel bookkeeping) */
  channelLogin?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventHandler = (type: string, event: Record<string, any>, envelopeId: string) => void
type SubErrorHandler = (desired: EventSubDesired, status: number) => void

interface EnvelopeMeta {
  message_type: string
  message_id?: string
}

export class EventSubClient {
  private ws: WebSocket | null = null
  private sessionId: string | null = null
  private closed = false
  /** deliberately off the wire because there is nothing to subscribe to */
  private idle = false
  private backoff = 1000
  private reconnectTimer: number | null = null
  private keepaliveTimer: number | null = null
  private keepaliveSec = 30
  private pendingUrl: string | null = null
  /** subscription keys already created for the CURRENT session */
  private created = new Set<string>()
  /**
   * Keys that failed with something retryable, and the earliest time to try them again.
   *
   * Without this, a rejected subscription was retried on EVERY resync — and a resync happens
   * each time a channel id becomes known, so opening thirty channels meant thirty passes over
   * every pending subscription. Against Twitch's rate limit that is self-feeding: the 429s
   * caused the retries that caused the 429s, and the log filled with the same warning.
   */
  private retryAt = new Map<string, number>()
  private retryStep = new Map<string, number>()
  /** last status logged per key, so a stuck subscription warns once instead of once per pass */
  private lastWarned = new Map<string, number>()
  private retryTimer: number | null = null
  /**
   * When the CLIENT may next speak to Twitch at all, and how hard it has been refused.
   *
   * A per-key cooldown is not a rate limit. Thirty-four channels means thirty-four raid
   * subscriptions, so however long each key waits there is always one whose turn has just come
   * round: measured on a real session, one rejected POST every 1.2 seconds, for as long as the
   * app stayed open. 429 is not a statement about that subscription, it is a statement about
   * this client — so it has to stop the whole pass, not move one key to the back of the queue.
   */
  private rateLimitedUntil = 0
  private rateStep = 0
  /** last reported "waiting out a backoff" count, so the line marks changes not passes */
  private lastHeld = -1
  /** coalesces the burst of resync() calls that arrives when many channels open at once */
  private resyncTimer: number | null = null
  private getDesired: () => EventSubDesired[]
  private onEvent: EventHandler
  private onSubError?: SubErrorHandler
  private onSubOk?: (desired: EventSubDesired) => void
  private subscribing = false

  constructor(
    getDesired: () => EventSubDesired[],
    onEvent: EventHandler,
    onSubError?: SubErrorHandler,
    onSubOk?: (desired: EventSubDesired) => void
  ) {
    this.getDesired = getDesired
    this.onEvent = onEvent
    this.onSubError = onSubError
    this.onSubOk = onSubOk
    this.connect()
  }

  /** is there anything to subscribe to at all? */
  private hasWork(): boolean {
    try {
      return this.getDesired().length > 0
    } catch {
      return false
    }
  }

  private connect(): void {
    if (this.closed) return
    const url = this.pendingUrl ?? EVENTSUB_URL
    this.pendingUrl = null
    const old = this.ws
    this.ws = null
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      try {
        old.close()
      } catch {
        /* noop */
      }
    }
    // Twitch closes a session that subscribes to nothing within ten seconds (4003, "connection
    // unused"). Opening one with an empty desired set — which is every launch before accounts
    // and channels have loaded, and every session with no valid token — bought exactly that,
    // over and over. Stay off the wire until there is something to ask for; resync() connects.
    if (!this.hasWork()) {
      if (!this.idle) diagSocket('eventsub', 'idle', 'nothing to subscribe to — staying offline')
      this.idle = true
      return
    }
    this.idle = false
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
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      diagSocket('eventsub', 'closed', `code=${ev.code} clean=${ev.wasClean} reason="${ev.reason || '-'}"`)
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
        // NOTE: the backoff is NOT reset here. Getting a welcome frame proves the socket
        // opened, not that the session is any use — and a session that subscribes to nothing
        // is closed again ten seconds later. Resetting on welcome meant the delay was back to
        // one second every single time, so the retry never backed off and the app reconnected
        // roughly every thirteen seconds, forever. It resets when a subscription succeeds.
        this.created.clear()
        // which features this session actually asks for — the first thing worth knowing when
        // someone reports that whispers, raids or the mod feed do nothing
        diagInfo(
          'eventsub',
          `session ready — subscribing to ${this.getDesired().map((d) => d.type).join(', ') || 'nothing'}`
        )
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
        // envelope id is stable across windows — used to dedupe persisted lines
        if (type && event) this.onEvent(type, event, msg.metadata?.message_id ?? '')
        break
      }
    }
  }

  /** put a key on the naughty step; one timer serves whichever cooldown ends first */
  private scheduleRetry(key: string, waitMs: number): void {
    this.retryAt.set(key, Date.now() + waitMs)
    this.armRetryTimer()
  }

  private armRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.closed || (this.retryAt.size === 0 && this.rateLimitedUntil === 0)) return
    // whichever comes later: the first key's own turn, or the client being allowed to speak
    const nextKey = this.retryAt.size ? Math.min(...this.retryAt.values()) : this.rateLimitedUntil
    const delay = Math.max(1000, Math.max(nextKey, this.rateLimitedUntil) - Date.now())
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      void this.subscribeAll().finally(() => this.armRetryTimer())
    }, delay)
  }

  /** (re)create every desired subscription not yet made for this session */
  private async subscribeAll(): Promise<void> {
    if (!this.sessionId || this.subscribing) return
    this.subscribing = true
    let held = 0
    try {
      for (const d of this.getDesired()) {
        if (this.created.has(d.key)) continue
        if (!this.sessionId) break
        // the whole client is serving a rate limit — nothing goes out until it lifts
        if (Date.now() < this.rateLimitedUntil) {
          held++
          continue
        }
        // still serving its cooldown — do not spend a request (or a log line) on it
        const wait = (this.retryAt.get(d.key) ?? 0) - Date.now()
        if (wait > 0) {
          held++
          continue
        }
        try {
          const res = await createEventSubSubscription(d.account, d.type, d.version, d.condition, this.sessionId)
          // 409 = already exists for this session; both mean "it's active now"
          if (res.ok || res.status === 409) {
            if (this.retryStep.has(d.key)) {
              diagInfo('eventsub', `${d.type} for ${d.account.login} succeeded after backing off`)
            }
            this.created.add(d.key)
            this.retryAt.delete(d.key)
            this.retryStep.delete(d.key)
            this.lastWarned.delete(d.key)
            // THIS is what makes a session worth having — only now is the retry delay safe
            // to reset (see the note in session_welcome)
            this.backoff = 1000
            // Twitch is taking requests again
            this.rateStep = 0
            this.rateLimitedUntil = 0
            this.onSubOk?.(d)
          } else {
            console.warn('[eventsub] subscribe failed', d.type, res.status, res.json ?? res.text)
            // a 4xx won't fix itself on retry (bad scope / bad condition) — stop hammering it
            // every reconnect; only 5xx / network errors / 429 are worth retrying.
            //
            // 429 is the exception, and it was once treated as fatal: "too many requests" is
            // precisely the one that DOES fix itself, and marking it done meant a rate limit
            // could silently disable raid detection for the rest of the session.
            const retryable = res.status === 429 || res.status >= 500 || res.status === 0
            if (!retryable) {
              this.created.add(d.key)
            } else {
              /**
               * Wait at least as long as the server asked — and at least as long as OUR OWN
               * backoff, which is the half that was missing.
               *
               * `ratelimit-reset` says when the request bucket refills, not when this
               * subscription will start being accepted. On a repeating 429 it is a fraction of
               * a second away, and taking it verbatim REPLACED the exponential backoff with
               * "try again next second" — permanently. With thirty channels open that is
               * thirty rejected POSTs a second, and the log from one session had four thousand
               * of them in eleven minutes, still going. The hint is a floor, not a ceiling.
               */
              const step = Math.min((this.retryStep.get(d.key) ?? 0) + 1, 6)
              this.retryStep.set(d.key, step)
              const wanted = retryAfterMs(res)
              const backoff = Math.max(Math.min(5000 * 2 ** (step - 1), 5 * 60_000), wanted)
              this.scheduleRetry(d.key, backoff)
              if (res.status === 429) {
                // shut the whole client up, not just this key (see rateLimitedUntil)
                this.rateStep = Math.min(this.rateStep + 1, 6)
                const gate = Math.max(Math.min(5000 * 2 ** (this.rateStep - 1), 5 * 60_000), wanted)
                this.rateLimitedUntil = Date.now() + gate
                this.armRetryTimer()
              }
              // one line per NEW situation, not one per attempt
              if (this.lastWarned.get(d.key) !== res.status) {
                this.lastWarned.set(d.key, res.status)
                const why = describeHelixError(res)
                diagWarn(
                  'eventsub',
                  `${d.type} for ${d.account.login}: HTTP ${res.status}${why ? ` (${why})` : ''}` +
                    ` — retry in ${Math.round(backoff / 1000)}s${wanted ? ' (asked by Twitch)' : ''}`
                )
              }
            }
            this.onSubError?.(d, res.status)
          }
        } catch (e) {
          console.warn('[eventsub] subscribe error', d.type, e)
          // a network failure here is indistinguishable from "the feature is broken" from the
          // outside, and it used to leave nothing behind at all
          this.scheduleRetry(d.key, 15000)
          diagWarn('eventsub', `${d.type} for ${d.account.login} threw: ${String(e)} — retry in 15s`)
        }
      }
      // only when it moves: unchanged, this was a line a second for the life of the session
      if (held !== this.lastHeld) {
        this.lastHeld = held
        if (held) {
          diagInfo('eventsub', `${held} subscription(s) waiting out a backoff, not retried this pass`)
        }
      }
      // a channel that was closed (or a subscription that finally landed) must not keep the
      // retry timer alive for the rest of the session
      const wanted = new Set(this.getDesired().map((d) => d.key))
      for (const key of [...this.retryAt.keys()]) {
        if (!wanted.has(key) || this.created.has(key)) {
          this.retryAt.delete(key)
          this.retryStep.delete(key)
          this.lastWarned.delete(key)
        }
      }
    } finally {
      this.subscribing = false
    }
  }

  /**
   * The desired set changed (accounts/channels) — add anything new to the live session.
   *
   * Coalesced, because the trigger is per channel: opening thirty chats means thirty ROOMSTATE
   * frames arriving within a second, and each one used to start its own pass over every pending
   * subscription. That burst is what earned the rate limit in the first place; waiting a beat
   * turns thirty passes into one.
   */
  resync(): void {
    if (this.closed) return
    if (this.resyncTimer !== null) return
    this.resyncTimer = window.setTimeout(() => {
      this.resyncTimer = null
      // this is also how we come back from idle: the first channel or account to appear is what
      // gives the socket a reason to exist
      if (this.idle || !this.ws || this.ws.readyState > WebSocket.OPEN) {
        if (this.reconnectTimer === null) this.connect()
        return
      }
      void this.subscribeAll()
    }, 400)
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
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    if (this.resyncTimer !== null) clearTimeout(this.resyncTimer)
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}
