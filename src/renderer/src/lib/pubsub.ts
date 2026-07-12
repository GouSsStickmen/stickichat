import { Account } from '../types'
import { ensureFreshToken } from './twitchAuth'
import { useSettingsStore } from '../store/settings'

/**
 * Twitch PubSub — two viewer-token topics EventSub can't fully replace:
 *  - `community-points-channel-v1.<id>`: every redemption incl. message-less ones (Chatterino's trick)
 *  - `raid.<id>`: outgoing raids the MOMENT the countdown starts on the Twitch page —
 *    EventSub channel.raid only fires when the raid actually executes
 *
 * Caveat: Twitch is deprecating PubSub in favour of EventSub. When it is finally shut down this
 * listener stops working and the EventSub paths remain as fallback.
 */
const PUBSUB_URL = 'wss://pubsub-edge.twitch.tv'

export interface RaidEvent {
  /** raiding channel (one of ours) */
  channelId: string
  targetLogin: string
  targetDisplay: string
  /** update = countdown tick, go = raid executed, cancel = raid aborted */
  kind: 'update' | 'go' | 'cancel'
}

export interface RedemptionEvent {
  /** redemption id (stable — used for dedupe when persisting) */
  id: string
  channelId: string
  userLogin: string
  userDisplay: string
  rewardTitle: string
  rewardCost: number
  userInput: string
}

export class PubSubClient {
  private ws: WebSocket | null = null
  private closed = false
  private backoff = 1000
  private reconnectTimer: number | null = null
  private pingTimer: number | null = null
  private listened = new Set<string>()
  private getAccount: () => Account | undefined
  private getChannelIds: () => string[]
  private onRedeem: (e: RedemptionEvent) => void
  private onRaid?: (e: RaidEvent) => void

  constructor(
    getAccount: () => Account | undefined,
    getChannelIds: () => string[],
    onRedeem: (e: RedemptionEvent) => void,
    onRaid?: (e: RaidEvent) => void
  ) {
    this.getAccount = getAccount
    this.getChannelIds = getChannelIds
    this.onRedeem = onRedeem
    this.onRaid = onRaid
    this.connect()
  }

  private connect(): void {
    if (this.closed) return
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
      ws = new WebSocket(PUBSUB_URL)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.listened.clear()
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.backoff = 1000
      this.listenAll()
      // Twitch drops the socket if it doesn't see a PING at least every 5 minutes
      if (this.pingTimer !== null) clearInterval(this.pingTimer)
      this.pingTimer = window.setInterval(() => this.send({ type: 'PING' }), 240000)
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      let msg: { type: string; data?: { topic?: string; message?: string } }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.type === 'MESSAGE' && msg.data?.topic?.startsWith('community-points-channel-v1.')) {
        this.handlePointsMessage(msg.data.topic, msg.data.message ?? '')
      }
      if (msg.type === 'MESSAGE' && msg.data?.topic?.startsWith('raid.')) {
        this.handleRaidMessage(msg.data.topic, msg.data.message ?? '')
      }
      // RECONNECT: Twitch asks us to reconnect soon; closing triggers our backoff reconnect
      if (msg.type === 'RECONNECT') {
        try {
          ws.close()
        } catch {
          /* noop */
        }
      }
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

  private handlePointsMessage(topic: string, raw: string): void {
    const channelId = topic.slice('community-points-channel-v1.'.length)
    let payload: {
      type?: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data?: any
    }
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    if (payload.type !== 'reward-redeemed') return
    const r = payload.data?.redemption
    if (!r) return
    this.onRedeem({
      id: r.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      channelId,
      userLogin: (r.user?.login ?? '').toLowerCase(),
      userDisplay: r.user?.display_name || r.user?.login || '?',
      rewardTitle: r.reward?.title ?? '?',
      rewardCost: r.reward?.cost ?? 0,
      userInput: r.user_input ?? ''
    })
  }

  /** outgoing raid updates: fire the countdown ("update") once, then the go event */
  private handleRaidMessage(topic: string, raw: string): void {
    if (!this.onRaid) return
    const channelId = topic.slice('raid.'.length)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: { type?: string; raid?: any }
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    const kinds: Record<string, RaidEvent['kind']> = {
      raid_update_v2: 'update',
      raid_go_v2: 'go',
      raid_cancel_v2: 'cancel'
    }
    const kind = kinds[payload.type ?? '']
    if (!kind) return
    const r = payload.raid
    if (!r?.target_login) return
    this.onRaid({
      channelId,
      targetLogin: String(r.target_login).toLowerCase(),
      targetDisplay: r.target_display_name || r.target_login,
      kind
    })
  }

  private async listenAll(): Promise<void> {
    const account = this.getAccount()
    if (!account) return
    const ids = this.getChannelIds().filter((id) => id && !this.listened.has(id))
    if (ids.length === 0) return
    let token: string
    try {
      token = await ensureFreshToken(useSettingsStore.getState().clientId, account)
    } catch {
      return
    }
    // the socket may have been replaced while awaiting the token
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    for (const id of ids) {
      this.listened.add(id)
      this.send({
        type: 'LISTEN',
        nonce: Math.random().toString(36).slice(2),
        data: { topics: [`community-points-channel-v1.${id}`, `raid.${id}`], auth_token: token }
      })
    }
  }

  /** channels opened/closed or their ids became known — pick up any new topics */
  resync(): void {
    this.listenAll()
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj))
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
    if (this.pingTimer !== null) clearInterval(this.pingTimer)
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}
