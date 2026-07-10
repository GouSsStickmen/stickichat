import { HttpResponse, httpGet, httpJson } from './http'
import { Account } from '../types'
import { useSettingsStore } from '../store/settings'
import { ensureFreshToken, refreshAccountToken } from './twitchAuth'

const BASE = 'https://api.twitch.tv/helix'

function qs(query: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x))
    else p.append(k, v)
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

async function helixRequest(
  account: Account,
  method: string,
  path: string,
  query: Record<string, string | string[] | undefined> = {},
  body?: unknown
): Promise<HttpResponse> {
  const clientId = useSettingsStore.getState().clientId
  const url = `${BASE}${path}${qs(query)}`

  const doCall = (token: string): Promise<HttpResponse> => {
    const headers = { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
    return method === 'GET' ? httpGet(url, headers) : httpJson(method, url, headers, body)
  }

  let token = account._accessToken ?? ''
  let res = token ? await doCall(token) : { ok: false, status: 401, json: null, text: '' }
  if (res.status === 401) {
    // token expired mid-session — refresh (deduped across any other concurrent callers) and retry once
    try {
      token = await refreshAccountToken(clientId, account)
      res = await doCall(token)
    } catch (e) {
      console.warn('[helix] token refresh failed, keeping original 401', e)
    }
  }
  return res
}

export interface HelixUser {
  id: string
  login: string
  display_name: string
  profile_image_url: string
  created_at: string
}

export async function getUsers(
  account: Account,
  by: { logins?: string[]; ids?: string[] }
): Promise<HelixUser[]> {
  const res = await helixRequest(account, 'GET', '/users', { login: by.logins, id: by.ids })
  if (!res.ok) return []
  return ((res.json as { data: HelixUser[] })?.data ?? []) as HelixUser[]
}

/** channels where the account is a moderator */
export async function getModeratedChannelIds(account: Account): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  for (let i = 0; i < 20; i++) {
    const res = await helixRequest(account, 'GET', '/moderation/channels', {
      user_id: account.id,
      first: '100',
      after: cursor
    })
    if (!res.ok) break
    const j = res.json as { data: { broadcaster_id: string }[]; pagination?: { cursor?: string } }
    ids.push(...(j.data ?? []).map((d) => d.broadcaster_id))
    cursor = j.pagination?.cursor
    if (!cursor) break
  }
  return ids
}

export async function banUser(
  account: Account,
  broadcasterId: string,
  userId: string,
  durationSeconds?: number,
  reason?: string
): Promise<HttpResponse> {
  return helixRequest(
    account,
    'POST',
    '/moderation/bans',
    { broadcaster_id: broadcasterId, moderator_id: account.id },
    { data: { user_id: userId, duration: durationSeconds, reason } }
  )
}

export async function unbanUser(
  account: Account,
  broadcasterId: string,
  userId: string
): Promise<HttpResponse> {
  return helixRequest(account, 'DELETE', '/moderation/bans', {
    broadcaster_id: broadcasterId,
    moderator_id: account.id,
    user_id: userId
  })
}

/** omit messageId to clear the whole chat */
export async function deleteChatMessage(
  account: Account,
  broadcasterId: string,
  messageId?: string
): Promise<HttpResponse> {
  return helixRequest(account, 'DELETE', '/moderation/chat', {
    broadcaster_id: broadcasterId,
    moderator_id: account.id,
    message_id: messageId
  })
}

export async function warnUser(
  account: Account,
  broadcasterId: string,
  userId: string,
  reason: string
): Promise<HttpResponse> {
  return helixRequest(
    account,
    'POST',
    '/moderation/warnings',
    { broadcaster_id: broadcasterId, moderator_id: account.id },
    { data: { user_id: userId, reason } }
  )
}

export async function sendAnnouncement(
  account: Account,
  broadcasterId: string,
  message: string,
  color?: string
): Promise<HttpResponse> {
  return helixRequest(
    account,
    'POST',
    '/chat/announcements',
    { broadcaster_id: broadcasterId, moderator_id: account.id },
    { message, color: color && color !== 'primary' ? color : undefined }
  )
}

export async function sendShoutout(
  account: Account,
  fromBroadcasterId: string,
  toBroadcasterId: string
): Promise<HttpResponse> {
  return helixRequest(account, 'POST', '/chat/shoutouts', {
    from_broadcaster_id: fromBroadcasterId,
    to_broadcaster_id: toBroadcasterId,
    moderator_id: account.id
  })
}

export async function startRaid(
  account: Account,
  fromBroadcasterId: string,
  toBroadcasterId: string
): Promise<HttpResponse> {
  return helixRequest(account, 'POST', '/raids', {
    from_broadcaster_id: fromBroadcasterId,
    to_broadcaster_id: toBroadcasterId
  })
}

export async function cancelRaid(account: Account, broadcasterId: string): Promise<HttpResponse> {
  return helixRequest(account, 'DELETE', '/raids', { broadcaster_id: broadcasterId })
}

export interface ChatSettingsPatch {
  slow_mode?: boolean
  slow_mode_wait_time?: number
  follower_mode?: boolean
  follower_mode_duration?: number
  subscriber_mode?: boolean
  emote_mode?: boolean
  unique_chat_mode?: boolean
}

export async function updateChatSettings(
  account: Account,
  broadcasterId: string,
  patch: ChatSettingsPatch
): Promise<HttpResponse> {
  return helixRequest(
    account,
    'PATCH',
    '/chat/settings',
    { broadcaster_id: broadcasterId, moderator_id: account.id },
    patch
  )
}

/** broadcaster-only */
export async function setModerator(
  account: Account,
  broadcasterId: string,
  userId: string,
  grant: boolean
): Promise<HttpResponse> {
  return helixRequest(account, grant ? 'POST' : 'DELETE', '/moderation/moderators', {
    broadcaster_id: broadcasterId,
    user_id: userId
  })
}

/** broadcaster-only */
export async function setVip(
  account: Account,
  broadcasterId: string,
  userId: string,
  grant: boolean
): Promise<HttpResponse> {
  return helixRequest(account, grant ? 'POST' : 'DELETE', '/channels/vips', {
    broadcaster_id: broadcasterId,
    user_id: userId
  })
}

export async function sendWhisper(
  account: Account,
  toUserId: string,
  message: string
): Promise<HttpResponse> {
  return helixRequest(
    account,
    'POST',
    '/whispers',
    { from_user_id: account.id, to_user_id: toUserId },
    { message }
  )
}

export async function getChatSettings(
  account: Account,
  broadcasterId: string
): Promise<ChatSettingsPatch | null> {
  const res = await helixRequest(account, 'GET', '/chat/settings', {
    broadcaster_id: broadcasterId,
    moderator_id: account.id
  })
  if (!res.ok) return null
  return ((res.json as { data: ChatSettingsPatch[] })?.data ?? [])[0] ?? null
}

export interface Chatter {
  user_id: string
  user_login: string
  user_name: string
}

/** live viewer list; requires the account to be a mod in the channel */
export async function getChatters(
  account: Account,
  broadcasterId: string
): Promise<{ list: Chatter[]; total: number }> {
  const out: Chatter[] = []
  let total = 0
  let cursor: string | undefined
  for (let i = 0; i < 10; i++) {
    const res = await helixRequest(account, 'GET', '/chat/chatters', {
      broadcaster_id: broadcasterId,
      moderator_id: account.id,
      first: '1000',
      after: cursor
    })
    if (!res.ok) break
    const j = res.json as { data: Chatter[]; total?: number; pagination?: { cursor?: string } }
    out.push(...(j.data ?? []))
    if (j.total) total = j.total
    cursor = j.pagination?.cursor
    if (!cursor) break
  }
  return { list: out, total: total || out.length }
}

export interface TwitchUserEmote {
  code: string
  url: string
  provider: 'twitch'
  ownerId: string
  emoteType: string
}

/**
 * All emotes the account can use, including sub emotes. Twitch pages this endpoint in small
 * chunks, so a full load is many sequential round-trips — `onPage` streams partial results
 * after every page so the UI can fill up progressively instead of staring at a spinner.
 */
export async function getUserEmotes(
  account: Account,
  onPage?: (partial: TwitchUserEmote[]) => void
): Promise<TwitchUserEmote[]> {
  const out: TwitchUserEmote[] = []
  let cursor: string | undefined
  for (let i = 0; i < 40; i++) {
    const res = await helixRequest(account, 'GET', '/chat/emotes/user', {
      user_id: account.id,
      after: cursor
    })
    if (!res.ok) break
    const j = res.json as {
      data: { id: string; name: string; emote_type: string; owner_id: string; format: string[]; scale: string[] }[]
      template?: string
      pagination?: { cursor?: string }
    }
    const template =
      j.template ?? 'https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}'
    for (const e of j.data ?? []) {
      const scale = e.scale?.includes('2.0') ? '2.0' : (e.scale?.[0] ?? '1.0')
      out.push({
        code: e.name,
        url: template
          .replace('{{id}}', e.id)
          .replace('{{format}}', 'default')
          .replace('{{theme_mode}}', 'dark')
          .replace('{{scale}}', scale),
        provider: 'twitch',
        ownerId: e.owner_id,
        emoteType: e.emote_type
      })
    }
    cursor = j.pagination?.cursor
    if (cursor) onPage?.([...out])
    if (!cursor) break
  }
  return out
}

/** requires moderator:read:followers; account must be a mod (or the broadcaster) of the channel */
export async function getFollowDate(
  account: Account,
  broadcasterId: string,
  userId: string
): Promise<string | null> {
  const res = await helixRequest(account, 'GET', '/channels/followers', {
    broadcaster_id: broadcasterId,
    user_id: userId,
    moderator_id: account.id
  })
  if (!res.ok) return null
  const data = (res.json as { data: { followed_at: string }[] })?.data ?? []
  return data[0]?.followed_at ?? null
}

export interface SubInfo {
  tier: string
  is_gift: boolean
}

/** requires channel:read:subscriptions and the account must BE the broadcaster (mods can't check others) */
export async function getSubInfo(
  account: Account,
  broadcasterId: string,
  userId: string
): Promise<SubInfo | null> {
  const res = await helixRequest(account, 'GET', '/subscriptions', {
    broadcaster_id: broadcasterId,
    user_id: [userId]
  })
  if (!res.ok) return null
  const data = (res.json as { data: SubInfo[] })?.data ?? []
  return data[0] ?? null
}

export interface HelixStream {
  user_login: string
  type: string
  started_at: string
  viewer_count: number
  title: string
}

export interface LiveInfo {
  startedAt: string
  viewers: number
  title: string
}

/** which of the given channels are live right now: login -> stream info */
export async function getLiveChannels(account: Account, logins: string[]): Promise<Map<string, LiveInfo>> {
  const live = new Map<string, LiveInfo>()
  for (let i = 0; i < logins.length; i += 100) {
    const res = await helixRequest(account, 'GET', '/streams', {
      user_login: logins.slice(i, i + 100),
      first: '100'
    })
    if (!res.ok) continue
    for (const s of ((res.json as { data: HelixStream[] })?.data ?? []) as HelixStream[]) {
      live.set(s.user_login.toLowerCase(), {
        startedAt: s.started_at,
        viewers: s.viewer_count ?? 0,
        title: s.title ?? ''
      })
    }
  }
  return live
}

interface HelixBadgeSet {
  set_id: string
  versions: { id: string; image_url_2x: string }[]
}

export async function getGlobalBadges(account: Account): Promise<Record<string, string>> {
  const res = await helixRequest(account, 'GET', '/chat/badges/global')
  return badgesToMap(res)
}

export async function getChannelBadges(
  account: Account,
  broadcasterId: string
): Promise<Record<string, string>> {
  const res = await helixRequest(account, 'GET', '/chat/badges', { broadcaster_id: broadcasterId })
  return badgesToMap(res)
}

function badgesToMap(res: HttpResponse): Record<string, string> {
  if (!res.ok) {
    console.warn('[badges] request failed', res.status, res.json ?? res.text)
    return {}
  }
  const out: Record<string, string> = {}
  for (const set of ((res.json as { data: HelixBadgeSet[] })?.data ?? []) as HelixBadgeSet[]) {
    for (const v of set.versions) out[`${set.set_id}/${v.id}`] = v.image_url_2x
  }
  return out
}

export { ensureFreshToken }
