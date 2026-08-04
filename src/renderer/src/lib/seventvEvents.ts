import { Emote } from '../types'
import { SevenTvEmote, sevenTvToEmote } from './emoteProviders'
import { diagSocket } from './diag'

/**
 * 7TV EventAPI (wss://events.7tv.io/v3): live emote-set updates, so an emote a broadcaster
 * adds or removes appears/disappears in chat instantly instead of after an app restart.
 *
 * Protocol: server greets with HELLO (op 1) and sends DISPATCH (op 0) events for topics we
 * SUBSCRIBE (op 35) to. We subscribe to `emote_set.update` per channel emote-set id.
 */
const EVENTS_URL = 'wss://events.7tv.io/v3'

export interface SetUpdate {
  channel: string
  added: Emote[]
  /** emote CODES removed from the set */
  removed: string[]
  /** who added/removed them, when 7TV tells us */
  actor?: string
}

interface DispatchBody {
  id?: string
  actor?: { display_name?: string; username?: string }
  pushed?: { value?: SevenTvEmote }[]
  pulled?: { old_value?: { name?: string } }[]
  updated?: { value?: SevenTvEmote; old_value?: { name?: string } }[]
}

/** a cosmetic definition or a grant of one, straight off the EventAPI */
export interface CosmeticEvent {
  kind: 'definition' | 'grant' | 'revoke'
  /** PAINT | BADGE */
  type: string
  /** cosmetic id (definition) or ref_id (grant/revoke) */
  id: string
  /** definition payload, for kind === 'definition' */
  data?: Record<string, unknown>
  /** twitch user id, for grant/revoke */
  twitchId?: string
}

interface CosmeticBody {
  object?: {
    id?: string
    kind?: string
    ref_id?: string
    data?: Record<string, unknown>
    user?: { connections?: { platform?: string; id?: string }[] }
  }
}

export class SevenTvEvents {
  private ws: WebSocket | null = null
  private closed = false
  private backoff = 1000
  private reconnectTimer: number | null = null
  /** setId -> channel login */
  private watched = new Map<string, string>()
  /** twitch channel ids whose COSMETICS we follow (paints/badges of everyone chatting there) */
  private watchedChannels = new Set<string>()
  /** set ids already subscribed on the CURRENT socket */
  private subscribed = new Set<string>()
  private onUpdate: (u: SetUpdate) => void
  private onCosmetic?: (e: CosmeticEvent) => void

  constructor(onUpdate: (u: SetUpdate) => void, onCosmetic?: (e: CosmeticEvent) => void) {
    this.onUpdate = onUpdate
    this.onCosmetic = onCosmetic
  }

  /**
   * Follow the cosmetics (paints/badges) of everyone chatting in a channel — the same
   * channel-scoped subscription Chatterino uses. This is what makes a nick colour change on
   * 7TV appear in chat within seconds instead of whenever a cache happens to expire.
   */
  watchCosmetics(twitchChannelId: string): void {
    if (!twitchChannelId || this.watchedChannels.has(twitchChannelId)) return
    this.watchedChannels.add(twitchChannelId)
    if (!this.ws) this.connect()
    else this.subscribeAll()
  }

  /** track a channel's emote set; connects lazily on the first watch */
  watch(channel: string, setId: string): void {
    if (this.watched.has(setId)) return
    this.watched.set(setId, channel)
    if (!this.ws) this.connect()
    else this.subscribeAll()
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
      ws = new WebSocket(EVENTS_URL)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.subscribed.clear()
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.backoff = 1000
      this.subscribeAll()
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      let msg: { op: number; d?: { type?: string; body?: unknown } }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.op === 0 && msg.d?.type === 'emote_set.update' && msg.d.body) {
        this.handleUpdate(msg.d.body as DispatchBody)
      }
      if (msg.op === 0 && msg.d?.type && /^(cosmetic|entitlement)\./.test(msg.d.type)) {
        this.handleCosmetic(msg.d.type, msg.d.body as CosmeticBody)
      }
      // op 7 = RECONNECT request
      if (msg.op === 7) {
        try {
          ws.close()
        } catch {
          /* noop */
        }
      }
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      diagSocket('7tv', 'closed', `code=${ev.code} clean=${ev.wasClean} reason="${ev.reason || '-'}"`)
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

  private handleUpdate(body: DispatchBody): void {
    const channel = body.id ? this.watched.get(body.id) : undefined
    if (!channel) return
    const added: Emote[] = []
    const removed: string[] = []
    for (const p of body.pushed ?? []) if (p.value) added.push(sevenTvToEmote(p.value))
    for (const p of body.pulled ?? []) if (p.old_value?.name) removed.push(p.old_value.name)
    // renames/replacements arrive as `updated`: drop the old code, add the new one
    for (const u of body.updated ?? []) {
      if (u.old_value?.name) removed.push(u.old_value.name)
      if (u.value) added.push(sevenTvToEmote(u.value))
    }
    const actor = body.actor?.display_name ?? body.actor?.username
    if (added.length || removed.length) this.onUpdate({ channel, added, removed, actor })
  }

  /** cosmetic.create -> a definition; entitlement.create/delete -> who wears it */
  private handleCosmetic(type: string, body?: CosmeticBody): void {
    const obj = body?.object
    if (!obj || !this.onCosmetic) return
    const kindName = String(obj.kind ?? '')
    if (kindName !== 'PAINT' && kindName !== 'BADGE') return

    if (type.startsWith('cosmetic.')) {
      if (!obj.id || !obj.data) return
      this.onCosmetic({ kind: 'definition', type: kindName, id: String(obj.id), data: obj.data })
      return
    }
    // entitlement: find the holder's TWITCH id among their linked platform accounts
    const conn = (obj.user?.connections ?? []).find((c) => c.platform === 'TWITCH')
    if (!conn?.id || !obj.ref_id) return
    this.onCosmetic({
      kind: type.endsWith('.delete') ? 'revoke' : 'grant',
      type: kindName,
      id: String(obj.ref_id),
      twitchId: String(conn.id)
    })
  }

  private subscribeAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    for (const setId of this.watched.keys()) {
      if (this.subscribed.has(setId)) continue
      this.subscribed.add(setId)
      this.ws.send(
        JSON.stringify({ op: 35, d: { type: 'emote_set.update', condition: { object_id: setId } } })
      )
    }
    for (const chanId of this.watchedChannels) {
      const key = `cos:${chanId}`
      if (this.subscribed.has(key)) continue
      this.subscribed.add(key)
      const condition = { platform: 'TWITCH', ctx: 'channel', id: chanId }
      for (const type of ['cosmetic.*', 'entitlement.*']) {
        this.ws.send(JSON.stringify({ op: 35, d: { type, condition } }))
      }
    }
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
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}
