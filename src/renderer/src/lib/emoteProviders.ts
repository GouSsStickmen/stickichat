import { httpGet } from './http'
import { Emote, EmoteMap } from '../types'

// ---------- 7TV ----------

interface SevenTvEmote {
  id: string
  name: string
  flags?: number
  data?: {
    animated?: boolean
    flags?: number
    host?: { files?: { name: string; width: number }[] }
  }
}

export type { SevenTvEmote }

export function sevenTvToEmote(e: SevenTvEmote): Emote {
  const ZERO_WIDTH = 1 // ActiveEmoteFlag ZeroWidth
  const baseFile = e.data?.host?.files?.find((f) => f.name.startsWith('1x'))
  return {
    code: e.name,
    url: `https://cdn.7tv.app/emote/${e.id}/2x.webp`,
    provider: '7tv',
    zeroWidth: ((e.flags ?? 0) & ZERO_WIDTH) !== 0 || ((e.data?.flags ?? 0) & 256) !== 0,
    animated: e.data?.animated,
    size: baseFile?.width
  }
}

export async function fetch7tvGlobal(): Promise<Emote[]> {
  const res = await httpGet('https://7tv.io/v3/emote-sets/global')
  if (!res.ok) return []
  const j = res.json as { emotes?: SevenTvEmote[] }
  return (j.emotes ?? []).map(sevenTvToEmote)
}

export async function fetch7tvChannel(twitchId: string): Promise<{ emotes: Emote[]; setId: string | null }> {
  const res = await httpGet(`https://7tv.io/v3/users/twitch/${twitchId}`)
  if (!res.ok) return { emotes: [], setId: null }
  const j = res.json as { emote_set?: { id?: string; emotes?: SevenTvEmote[] } }
  return {
    emotes: (j.emote_set?.emotes ?? []).map(sevenTvToEmote),
    // the active set id — needed to subscribe to live add/remove events
    setId: j.emote_set?.id ?? null
  }
}

// ---------- BTTV ----------

const BTTV_ZERO_WIDTH = new Set([
  'SoSnowy', 'IceCold', 'SantaHat', 'TopHat', 'ReinDeer', 'CandyCane', 'cvMask', 'cvHazmat'
])

interface BttvEmote {
  id: string
  code: string
  animated?: boolean
  imageType?: string
}

function bttvToEmote(e: BttvEmote): Emote {
  return {
    code: e.code,
    url: `https://cdn.betterttv.net/emote/${e.id}/2x`,
    provider: 'bttv',
    zeroWidth: BTTV_ZERO_WIDTH.has(e.code),
    animated: e.animated ?? e.imageType === 'gif'
  }
}

export async function fetchBttvGlobal(): Promise<Emote[]> {
  const res = await httpGet('https://api.betterttv.net/3/cached/emotes/global')
  if (!res.ok) return []
  return ((res.json as BttvEmote[]) ?? []).map(bttvToEmote)
}

export async function fetchBttvChannel(twitchId: string): Promise<Emote[]> {
  const res = await httpGet(`https://api.betterttv.net/3/cached/users/twitch/${twitchId}`)
  if (!res.ok) return []
  const j = res.json as { channelEmotes?: BttvEmote[]; sharedEmotes?: BttvEmote[] }
  return [...(j.channelEmotes ?? []), ...(j.sharedEmotes ?? [])].map(bttvToEmote)
}

// ---------- FFZ ----------

interface FfzEmote {
  name: string
  urls: Record<string, string>
  animated?: Record<string, string> | null
  width?: number
}

interface FfzSetResponse {
  sets?: Record<string, { emoticons?: FfzEmote[] }>
}

function ffzUrl(u: string): string {
  return u.startsWith('//') ? `https:${u}` : u
}

function ffzToEmote(e: FfzEmote): Emote {
  const urls = e.animated ?? e.urls
  const u = urls['2'] ?? urls['1'] ?? Object.values(urls)[0] ?? ''
  return {
    code: e.name,
    url: ffzUrl(u),
    provider: 'ffz',
    animated: !!e.animated,
    size: e.width
  }
}

function ffzCollect(j: FfzSetResponse): Emote[] {
  const out: Emote[] = []
  for (const set of Object.values(j.sets ?? {})) {
    for (const e of set.emoticons ?? []) out.push(ffzToEmote(e))
  }
  return out
}

export async function fetchFfzGlobal(): Promise<Emote[]> {
  const res = await httpGet('https://api.frankerfacez.com/v1/set/global')
  if (!res.ok) return []
  return ffzCollect(res.json as FfzSetResponse)
}

export async function fetchFfzChannel(twitchId: string): Promise<Emote[]> {
  const res = await httpGet(`https://api.frankerfacez.com/v1/room/id/${twitchId}`)
  if (!res.ok) return []
  return ffzCollect(res.json as FfzSetResponse)
}

// ---------- merge ----------

/** later entries win: pass [ffz, bttv, 7tv] so 7tv has priority */
export function mergeEmotes(...lists: Emote[][]): EmoteMap {
  const map: EmoteMap = new Map()
  for (const list of lists) for (const e of list) map.set(e.code, e)
  return map
}
