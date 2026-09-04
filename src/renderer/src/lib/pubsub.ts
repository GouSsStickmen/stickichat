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

/** the five topics one channel is worth */
const topicsFor = (id: string): string[] => [
  `community-points-channel-v1.${id}`,
  `raid.${id}`,
  `polls.${id}`,
  `predictions-channel-v1.${id}`,
  `hype-train-events-v1.${id}`
]

/**
 * How many channels one connection may carry.
 *
 * Twitch allows fifty topics on a socket and no more, and a channel costs five of them, so ten
 * would be the ceiling exactly; nine leaves a topic spare rather than sitting on the line.
 *
 * This is not a tuning knob, it is the bug: with two dozen chats open the app asked one socket for
 * a hundred and forty topics, and Twitch answered ERR_TOO_MANY_TOPICS and took NONE of them beyond
 * its limit. Everything those topics carry — redemptions, raids, polls, predictions, hype trains —
 * simply never arrived for the channels past the first few, and nothing said so anywhere but the
 * diagnostics log. It is what was behind "the prediction started and StickiChat showed no card":
 * a poll can be read back off the stream page, and a prediction cannot, so polls looked fine while
 * predictions vanished.
 */
const CHANNELS_PER_LINK = 9

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
  /**
   * Everything beyond the announcement: the running state, sent on every update.
   *
   * Twitch's own card in the page carries no clock and no bar of any kind, so a countdown could
   * not be read off it however hard it was looked for. These topics carry it exactly: how long is
   * left, how the votes stand, and the moment it is over, which is when the result should show
   * rather than a minute later when their card finally disappears.
   */
  phase: 'create' | 'update' | 'end'
  id: string
  /** unix ms the voting closes at, when the payload says */
  endsAt?: number
  /** ACTIVE / COMPLETED / LOCKED / RESOLVED, as the payload words it */
  status?: string
  /** per choice: what it is called, how much is on it, and how much of that is ours */
  tally?: { title: string; votes: number; mine: number }[]
  /** the outcome that won, once a prediction is resolved */
  winner?: string
  /** who was paid what by that resolution, ourselves included */
  payouts?: { name: string; points: number }[]
}

/**
 * Twitch runs four kinds of hype train and tells you which in a different field depending on
 * the kind, so the flavour is sniffed from whatever the payload happens to carry rather than
 * read from one place that does not exist.
 */
export type HypeTrainKind = 'regular' | 'shared' | 'golden' | 'community'

export interface HypeTrainEvent {
  channelId: string
  kind: 'start' | 'progress' | 'level' | 'end'
  /** which of the four flavours this train is */
  flavour: HypeTrainKind
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

/**
 * Which flavour of train this is, from whatever the payload happens to say.
 *
 * There is no single field: a golden train is flagged on the config, a shared one is known by
 * having participants from more than one channel, and community trains have been announced
 * under more than one name. So this looks at several places and at the free-text type, and
 * falls back to "regular" — the flavour only decides how it is dressed and whether it is
 * allowed to interrupt you, so guessing wrong is cosmetic rather than broken.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sniffFlavour(d: any): HypeTrainKind {
  const cfg = d?.config ?? {}
  if (d?.is_golden_kappa_train || cfg.is_golden_kappa_train) return 'golden'
  if (d?.is_community_train || cfg.is_community_train) return 'community'
  if (d?.is_shared_train || cfg.is_shared_train || Array.isArray(d?.shared_train_participants))
    return 'shared'
  const label = String(d?.type ?? d?.train_type ?? cfg.type ?? '').toLowerCase()
  if (label.includes('golden') || label.includes('mythic') || label.includes('treasure'))
    return 'golden'
  if (label.includes('community')) return 'community'
  if (label.includes('shared')) return 'shared'
  return 'regular'
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
  /** what kind of hype train each channel is running, kept for the life of that train */
  private trainFlavour = new Map<string, HypeTrainKind>()
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
      // Twitch drops the socket if it doesn't see a PING at least every 5 minutes — but the
      // reason for pinging every MINUTE is the other end of the wire: on a line that recycles
      // idle connections, four minutes of silence is far more than enough for the router to
      // collect the socket, and this one carries redemptions and hype trains, which arrive in
      // bursts with long quiet stretches between them.
      if (this.pingTimer !== null) clearInterval(this.pingTimer)
      this.pingTimer = window.setInterval(() => this.send({ type: 'PING' }), 60000)
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
    const poll = payload.data?.poll
    if (!poll?.title) return
    const id = String(poll.poll_id ?? poll.id ?? '')
    const type = payload.type ?? ''
    const phase =
      type === 'POLL_CREATE' ? 'create' : /COMPLETE|TERMINATE|ARCHIVE/i.test(type) ? 'end' : 'update'
    // the announcement is for the start only; the state goes out on every message
    if (phase === 'create') {
      if (id && this.announcedPolls.has(id)) return
      if (id) this.announcedPolls.add(id)
    }
    const left = Number(
      poll.remaining_duration_milliseconds ?? Number(poll.duration_seconds ?? 0) * 1000
    )
    this.onPoll({
      channelId,
      kind: 'poll',
      phase,
      id,
      title: String(poll.title),
      status: String(poll.status ?? ''),
      endsAt: left > 0 ? Date.now() + left : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      choices: (poll.choices ?? []).map((c: any) => String(c.title ?? '')).filter(Boolean),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tally: (poll.choices ?? []).map((c: any) => ({
        title: String(c.title ?? ''),
        votes: Number(c.votes?.total ?? c.total_voters ?? 0),
        mine: 0
      }))
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
    const ev = payload.data?.event
    if (!ev?.title) return
    const me = this.getAccount()?.id
    const id = String(ev.id ?? '')
    const type = payload.type ?? ''
    const status = String(ev.status ?? '')
    const phase =
      type === 'event-created' ? 'create' : /RESOLVED|CANCELED/i.test(status) ? 'end' : 'update'
    if (phase === 'create') {
      if (id && this.announcedPolls.has(id)) return
      if (id) this.announcedPolls.add(id)
    }
    // predictions say when submissions close rather than how long is left
    const locks = Date.parse(String(ev.locked_at ?? ev.locks_at ?? ''))
    const created = Date.parse(String(ev.created_at ?? ''))
    const window = Number(ev.prediction_window_seconds ?? 0)
    const endsAt = Number.isFinite(locks)
      ? locks
      : Number.isFinite(created) && window > 0
        ? created + window * 1000
        : undefined
    /*
     * The result, once it is resolved: which outcome won and who was paid.
     *
     * Twitch's own card says both, and says them the moment it happens; ours should not make
     * anybody wait for the page to catch up.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcomes: any[] = ev.outcomes ?? []
    const wonId = String(ev.winning_outcome_id ?? '')
    const winning = outcomes.find((o) => String(o.id ?? '') === wonId)
    const payouts = (winning?.top_predictors ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((p: any) => Number(p.result?.points_won ?? 0) > 0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((p: any) => ({
        name: String(p.user_display_name ?? p.user_login ?? ''),
        points: Number(p.result?.points_won ?? 0)
      }))
      .slice(0, 5)
    this.onPoll({
      channelId,
      kind: 'prediction',
      phase,
      id,
      title: String(ev.title),
      status,
      endsAt,
      winner: winning ? String(winning.title ?? '') : undefined,
      payouts: payouts.length ? payouts : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      choices: (ev.outcomes ?? []).map((o: any) => String(o.title ?? '')).filter(Boolean),
      /*
       * How much of each outcome is ours, so the card can behave the way Twitch's does.
       *
       * Once you have backed one side you cannot back another, only add to yours, and the card has
       * to say so rather than offering presses that will be refused. The payload names the top
       * predictors of each outcome, and our own account among them is the answer.
       */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tally: (ev.outcomes ?? []).map((o: any) => ({
        title: String(o.title ?? ''),
        votes: Number(o.total_points ?? o.total_users ?? 0),
        mine: (o.top_predictors ?? [])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((p: any) => String(p.user_id ?? '') === String(me ?? ''))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .reduce((sum: number, p: any) => sum + Number(p.points ?? 0), 0)
      }))
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
    /*
     * The flavour is decided once, at departure, and remembered for the whole train.
     *
     * Only the start message carries the config that says a train is golden, shared or community;
     * every progression and level-up after it carries the progress and nothing else, so sniffing
     * each message afresh reported level 1 as golden and every level after it as an ordinary
     * train, with the wrong dress and the wrong words.
     */
    const sniffed = sniffFlavour(d)
    if (kind === 'start' || !this.trainFlavour.has(channelId)) {
      this.trainFlavour.set(channelId, sniffed)
    } else if (sniffed !== 'regular') {
      this.trainFlavour.set(channelId, sniffed)
    }
    const flavour = this.trainFlavour.get(channelId) ?? sniffed
    if (kind === 'end') {
      this.trainFlavour.delete(channelId)
      this.onHype({
        channelId,
        kind,
        flavour,
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
      flavour,
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
    /*
     * Claimed before the token is awaited, not after it.
     *
     * Every channel that learns its own id calls resync, and a chat window opens two dozen of them
     * within a second or two. Each of those found the same unlistened ids, each waited on the same
     * token, and then every one of them sent the very same LISTEN: measured at eight identical
     * requests for the same forty-five topics on one socket. Claiming first means the second
     * caller finds nothing left to ask for; if the request cannot go after all, the claim is
     * released and the next resync picks the channels up again.
     */
    for (const id of ids) this.listened.add(id)
    const unclaim = (): void => {
      for (const id of ids) this.listened.delete(id)
    }
    let token: string
    try {
      token = await ensureFreshToken(useSettingsStore.getState().clientId, account)
    } catch {
      unclaim()
      return
    }
    // the socket may have been replaced while awaiting the token
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      unclaim()
      return
    }
    // a session that actually listens to something has earned a fresh retry delay
    this.backoff = 1000
    /*
     * One request for the lot, rather than one per channel.
     *
     * Twitch counts the LISTENs a connection sends as well as the topics it holds, and a window
     * with two dozen chats open sent two dozen of them in the same second every time the socket
     * came back. They go together now: this link is never allowed more than a socket may hold, so
     * the whole slice fits in one message.
     */
    this.send({
      type: 'LISTEN',
      nonce: Math.random().toString(36).slice(2),
      data: { topics: ids.flatMap(topicsFor), auth_token: token }
    })
  }

  /**
   * Stop listening to channels that are no longer open.
   *
   * listenAll only ever added: a chat closed in the app kept its topics on this socket, so raids,
   * redemptions and hype trains went on arriving from a channel nobody has open. The topics are
   * the same five that were subscribed to, sent back with UNLISTEN.
   */
  private unlistenGone(): void {
    const want = new Set(this.getChannelIds().filter(Boolean))
    const drop: string[] = []
    for (const id of [...this.listened]) {
      if (want.has(id)) continue
      this.listened.delete(id)
      drop.push(id)
    }
    if (drop.length === 0) return
    this.send({
      type: 'UNLISTEN',
      nonce: Math.random().toString(36).slice(2),
      data: { topics: drop.flatMap(topicsFor) }
    })
  }

  /** channels opened/closed or their ids became known — pick up any new topics */
  resync(): void {
    // also the way back from idle: the first known channel id is the reason to dial at all
    if (this.idle || !this.ws || this.ws.readyState > WebSocket.OPEN) {
      if (this.reconnectTimer === null) this.connect()
      return
    }
    this.unlistenGone()
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

/**
 * As many connections as the open channels need.
 *
 * One socket cannot hold them: fifty topics is the whole allowance, nine channels spend it, and
 * this app is quite happily used with two dozen chats open at once. So the channels are dealt out
 * across several sockets, each of which is an ordinary client that knows only its own share.
 *
 * A channel keeps its seat for as long as it is open. Dealing them out afresh each time — sorted
 * and chunked, say — moves half of them to a different socket the moment one channel is added,
 * and every move is an UNLISTEN and a LISTEN for five topics that were working perfectly well.
 * New channels take the first seat that is free, and a seat is only freed by its channel closing.
 */
export class PubSubPool {
  private links: PubSubClient[] = []
  /** channel id to the link that carries it */
  private seats = new Map<string, number>()
  private closed = false

  constructor(
    private getAccount: () => Account | undefined,
    private getChannelIds: () => string[],
    private onRedeem: (e: RedemptionEvent) => void,
    private onRaid?: (e: RaidEvent) => void,
    private onPoll?: (e: PollEvent) => void,
    private onHype?: (e: HypeTrainEvent) => void
  ) {
    this.resync()
  }

  /** channels opened or closed: re-seat them, add sockets if they need one, then tell every link */
  resync(): void {
    if (this.closed) return
    this.seat()
    for (const link of this.links) link.resync()
  }

  private seat(): void {
    let ids: string[]
    try {
      ids = this.getChannelIds().filter(Boolean)
    } catch {
      return
    }
    const want = new Set(ids)
    for (const id of [...this.seats.keys()]) if (!want.has(id)) this.seats.delete(id)
    const load = new Map<number, number>()
    for (const at of this.seats.values()) load.set(at, (load.get(at) ?? 0) + 1)
    for (const id of ids) {
      if (this.seats.has(id)) continue
      let at = 0
      while ((load.get(at) ?? 0) >= CHANNELS_PER_LINK) at++
      this.seats.set(id, at)
      load.set(at, (load.get(at) ?? 0) + 1)
    }
    const need = this.seats.size === 0 ? 0 : Math.max(...this.seats.values()) + 1
    while (this.links.length < need) {
      const at = this.links.length
      this.links.push(
        new PubSubClient(
          this.getAccount,
          () => [...this.seats.entries()].filter(([, seat]) => seat === at).map(([id]) => id),
          this.onRedeem,
          this.onRaid,
          this.onPoll,
          this.onHype
        )
      )
    }
    // a link left with nothing goes quiet on its own: it drops its topics, Twitch closes the
    // unused session, and connect() refuses to dial again while there is nothing to say
  }

  close(): void {
    this.closed = true
    for (const link of this.links) link.close()
    this.links = []
    this.seats.clear()
  }
}
