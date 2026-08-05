import { Account } from '../types'
import { ensureFreshToken } from './twitchAuth'
import { useSettingsStore } from '../store/settings'
import { diagSocket } from './diag'

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
  /** the reward's channel-points icon (custom image, or the channel's default points icon) */
  rewardIcon?: string
}

export interface PollEvent {
  channelId: string
  kind: 'poll' | 'prediction'
  title: string
  choices: string[]
}

export interface HypeTrainEvent {
  channelId: string
  kind: 'start' | 'progress' | 'level' | 'end'
  /** 1..5 — the level the train is on right now */
  level: number
  /** points into the CURRENT level */
  value: number
  /** points the current level needs */
  goal: number
  /** unix ms when the train expires unless it is fed */
  expiresAt: number
  /** who just contributed (progress events only) */
  userDisplay?: string
  /** why it stopped: the train finished level 5, or it simply ran out of time */
  endReason?: 'COMPLETED' | 'EXPIRE'
}

export class PubSubClient {
  private ws: WebSocket | null = null
  private closed = false
  /** deliberately off the wire because there are no topics to listen to */
  private idle = false
  private backoff = 1000
  private reconnectTimer: number | null = null
  private pingTimer: number | null = null
  private listened = new Set<string>()
  private getAccount: () => Account | undefined
  private getChannelIds: () => string[]
  private onRedeem: (e: RedemptionEvent) => void
  private onRaid?: (e: RaidEvent) => void
  private onPoll?: (e: PollEvent) => void
  private onHype?: (e: HypeTrainEvent) => void
  /** poll/prediction ids already announced (both topics repeat update events) */
  private announcedPolls = new Set<string>()

  constructor(
    getAccount: () => Account | undefined,
    getChannelIds: () => string[],
    onRedeem: (e: RedemptionEvent) => void,
    onRaid?: (e: RaidEvent) => void,
    onPoll?: (e: PollEvent) => void,
    onHype?: (e: HypeTrainEvent) => void
  ) {
    this.getAccount = getAccount
    this.getChannelIds = getChannelIds
    this.onRedeem = onRedeem
    this.onRaid = onRaid
    this.onPoll = onPoll
    this.onHype = onHype
    this.connect()
  }

  /** is there an account and at least one channel id to LISTEN for? */
  private hasWork(): boolean {
    try {
      return !!this.getAccount() && this.getChannelIds().some((id) => !!id)
    } catch {
      return false
    }
  }

  private connect(): void {
    if (this.closed) return
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
    // Twitch hangs up on a session that never LISTENs (4110, "session unused"). At launch the
    // account and the channel ids are not known yet, so the socket was being opened with
    // nothing to say and dropped seconds later — endlessly. Wait for a reason; resync() calls
    // back in as soon as there is one.
    if (!this.hasWork()) {
      if (!this.idle) diagSocket('pubsub', 'idle', 'no topics to listen to — staying offline')
      this.idle = true
      return
    }
    this.idle = false
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
      // the backoff is NOT reset here — see listenAll(). An open socket that listens to
      // nothing gets closed again, and resetting on open kept the retry pinned at one second.
      this.listenAll()
      // Twitch drops the socket if it doesn't see a PING at least every 5 minutes
      if (this.pingTimer !== null) clearInterval(this.pingTimer)
      this.pingTimer = window.setInterval(() => this.send({ type: 'PING' }), 240000)
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      let msg: { type: string; error?: string; data?: { topic?: string; message?: string } }
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
      if (msg.type === 'MESSAGE' && msg.data?.topic?.startsWith('polls.')) {
        this.handlePollMessage(msg.data.topic, msg.data.message ?? '')
      }
      if (msg.type === 'MESSAGE' && msg.data?.topic?.startsWith('predictions-channel-v1.')) {
        this.handlePredictionMessage(msg.data.topic, msg.data.message ?? '')
      }
      if (msg.type === 'MESSAGE' && msg.data?.topic?.startsWith('hype-train-events-v1.')) {
        this.handleHypeMessage(msg.data.topic, msg.data.message ?? '')
      }
      // a rejected LISTEN used to vanish without trace: the topic simply never delivered
      // anything and the session was later dropped as unused. ERR_BADAUTH here is the single
      // clearest sign that the token is stale, and it belongs in the report.
      if (msg.type === 'RESPONSE' && msg.error) {
        diagSocket('pubsub', 'LISTEN rejected', msg.error)
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
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      diagSocket('pubsub', 'closed', `code=${ev.code} clean=${ev.wasClean} reason="${ev.reason || '-'}"`)
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
      userInput: r.user_input ?? '',
      // custom reward image when set, else the channel's default channel-points icon
      rewardIcon:
        r.reward?.image?.url_2x ??
        r.reward?.image?.url_1x ??
        r.reward?.default_image?.url_2x ??
        r.reward?.default_image?.url_1x
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

  /** a poll started in one of the open channels */
  private handlePollMessage(topic: string, raw: string): void {
    if (!this.onPoll) return
    const channelId = topic.slice('polls.'.length)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: { type?: string; data?: { poll?: any } }
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    if (payload.type !== 'POLL_CREATE') return
    const poll = payload.data?.poll
    if (!poll?.title) return
    const id = String(poll.poll_id ?? poll.id ?? '')
    if (id && this.announcedPolls.has(id)) return
    if (id) this.announcedPolls.add(id)
    this.onPoll({
      channelId,
      kind: 'poll',
      title: String(poll.title),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      choices: (poll.choices ?? []).map((c: any) => String(c.title ?? '')).filter(Boolean)
    })
  }

  /** a prediction started in one of the open channels */
  private handlePredictionMessage(topic: string, raw: string): void {
    if (!this.onPoll) return
    const channelId = topic.slice('predictions-channel-v1.'.length)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: { type?: string; data?: { event?: any } }
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    if (payload.type !== 'event-created') return
    const ev = payload.data?.event
    if (!ev?.title) return
    const id = String(ev.id ?? '')
    if (id && this.announcedPolls.has(id)) return
    if (id) this.announcedPolls.add(id)
    this.onPoll({
      channelId,
      kind: 'prediction',
      title: String(ev.title),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      choices: (ev.outcomes ?? []).map((o: any) => String(o.title ?? '')).filter(Boolean)
    })
  }

  /**
   * Hype train, live.
   *
   * EventSub has channel.hype_train.*, but its scope is broadcaster-only — it would light up
   * for your own channel and stay dark for every other chat you watch. This viewer topic is
   * what the Twitch page itself listens to, so the train shows up wherever you are.
   *
   * `progression` fires per contribution, `level-up` when the bar fills; both carry the whole
   * progress object, so one mapping covers all of them.
   */
  private handleHypeMessage(topic: string, raw: string): void {
    if (!this.onHype) return
    const channelId = topic.slice('hype-train-events-v1.'.length)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: { type?: string; data?: any }
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    const kinds: Record<string, HypeTrainEvent['kind']> = {
      'hype-train-start': 'start',
      'hype-train-progression': 'progress',
      'hype-train-level-up': 'level',
      'hype-train-end': 'end'
    }
    const kind = kinds[payload.type ?? '']
    if (!kind) return
    const d = payload.data ?? {}
    if (kind === 'end') {
      this.onHype({
        channelId,
        kind,
        level: 0,
        value: 0,
        goal: 0,
        expiresAt: Date.now(),
        endReason: d.ending_reason === 'COMPLETED' ? 'COMPLETED' : 'EXPIRE'
      })
      return
    }
    const p = d.progress ?? {}
    // level-up carries the deadline as an absolute ms timestamp, the others as seconds left
    const expiresAt =
      typeof d.time_to_expire === 'number'
        ? d.time_to_expire
        : Date.now() + Math.max(0, Number(p.remaining_seconds ?? 0)) * 1000
    this.onHype({
      channelId,
      kind,
      level: Number(p.level?.value ?? 1),
      value: Number(p.value ?? 0),
      goal: Number(p.goal ?? p.level?.goal ?? 1),
      expiresAt,
      userDisplay: d.user_display_name || d.user_login || undefined
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
    // a session that actually listens to something has earned a fresh retry delay
    this.backoff = 1000
    for (const id of ids) {
      this.listened.add(id)
      this.send({
        type: 'LISTEN',
        nonce: Math.random().toString(36).slice(2),
        data: {
          topics: [
            `community-points-channel-v1.${id}`,
            `raid.${id}`,
            `polls.${id}`,
            `predictions-channel-v1.${id}`,
            `hype-train-events-v1.${id}`
          ],
          auth_token: token
        }
      })
    }
  }

  /** channels opened/closed or their ids became known — pick up any new topics */
  resync(): void {
    // also the way back from idle: the first known channel id is the reason to dial at all
    if (this.idle || !this.ws || this.ws.readyState > WebSocket.OPEN) {
      if (this.reconnectTimer === null) this.connect()
      return
    }
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
