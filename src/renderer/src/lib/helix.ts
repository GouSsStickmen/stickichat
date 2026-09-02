import { HttpResponse, httpGet, httpJson, retryAfterMs } from './http'
import { Account, Cheermote } from '../types'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { ensureFreshToken, refreshAccountToken } from './twitchAuth'
import { diagWarn } from './diag'

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
      /**
       * A rejected refresh token is terminal, not transient: nothing this account asks Twitch will
       * ever succeed again until somebody signs in. Only warning to the console meant every Helix
       * feature — follower totals, subscriber counts, stream info, avatars — quietly returned
       * nothing, with the chat still connected on the socket it had already authenticated, so
       * there was no outward sign at all that the account had gone stale.
       */
      useUiStore.getState().markReauthNeeded(account.id, account.login)
      diagWarn('helix', `refresh rejected for ${account.login}: ${String(e)}`)
    }
  } else if (res.ok) {
    // it works again — a re-auth, or a refresh that finally went through
    useUiStore.getState().clearReauthNeeded(account.id)
  }
  noteRateLimit(path, res)
  return res
}

/** Twitch puts the real reason in a `message` field; the status alone rarely explains anything */
export function describeHelixError(res: HttpResponse): string {
  const msg = (res.json as { message?: string } | null)?.message
  if (msg) return String(msg)
  return res.text ? res.text.slice(0, 120) : ''
}

/**
 * One line when the Helix budget is actually running out, and one when a 429 lands.
 *
 * Both are throttled per endpoint: a burst of a hundred rejected calls is one situation, not a
 * hundred, and a log that repeats it a hundred times is how the interesting lines get lost.
 */
const rateNoted = new Map<string, number>()
function noteRateLimit(path: string, res: HttpResponse): void {
  const remaining = Number(res.headers?.['ratelimit-remaining'])
  const now = Date.now()
  const key = `${res.status === 429 ? '429' : 'low'}:${path}`
  const last = rateNoted.get(key) ?? 0
  if (res.status === 429) {
    if (now - last < 30_000) return
    rateNoted.set(key, now)
    const wait = retryAfterMs(res, now)
    diagWarn(
      'helix',
      `429 on ${path}${wait ? ` — clears in ${Math.round(wait / 1000)}s` : ''}: ${describeHelixError(res)}`
    )
    return
  }
  // 800 points/min is the bucket; under a tenth left means something is looping
  if (Number.isFinite(remaining) && remaining < 80) {
    if (now - last < 60_000) return
    rateNoted.set(key, now)
    diagWarn('helix', `rate budget low: ${remaining} left after ${path}`)
  }
}

export interface HelixUser {
  id: string
  login: string
  display_name: string
  profile_image_url: string
  created_at: string
  /** the channel's "About" bio — the closest thing Helix exposes to chat rules */
  description?: string
}

export async function getUsers(
  account: Account,
  by: { logins?: string[]; ids?: string[] }
): Promise<HelixUser[]> {
  const res = await helixRequest(account, 'GET', '/users', { login: by.logins, id: by.ids })
  if (!res.ok) return []
  return ((res.json as { data: HelixUser[] })?.data ?? []) as HelixUser[]
}

/**
 * Channels where the account is a moderator. Returns null when ANY page fails —
 * a partial/empty result must never overwrite a previously known-good cache
 * (a transient 401 during startup token refresh would silently strip mod rights).
 */
export async function getModeratedChannelIds(account: Account): Promise<string[] | null> {
  const ids: string[] = []
  let cursor: string | undefined
  for (let i = 0; i < 20; i++) {
    const res = await helixRequest(account, 'GET', '/moderation/channels', {
      user_id: account.id,
      first: '100',
      after: cursor
    })
    if (!res.ok) return null
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
  const res = await helixRequest(account, 'POST', '/chat/shoutouts', {
    from_broadcaster_id: fromBroadcasterId,
    to_broadcaster_id: toBroadcasterId,
    moderator_id: account.id
  })
  // Twitch's shoutout cooldowns aren't reported by the API, so time them from our own sends
  if (res.ok) {
    const { recordShoutout } = await import('./shoutoutCooldown')
    recordShoutout(fromBroadcasterId, toBroadcasterId)
  }
  return res
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

/*
 * Polls and predictions, the streamer's half.
 *
 * Reading them was already covered — PubSub announces a poll or a prediction starting, and the
 * chat prints an info line. What was missing is the other direction, and unlike GIFs or voting it
 * is fully documented: Helix creates, ends, locks and resolves them with ordinary scoped tokens.
 *
 * The scopes are new, so an account authorized before this existed gets a 401 until it signs in
 * again — helixRequest already flags that account for re-authorization when the refresh fails, and
 * a missing scope is reported by describeHelixError rather than swallowed.
 */

/** one running or finished poll, reduced to what a panel needs to draw */
export interface HelixPoll {
  id: string
  title: string
  status: string
  choices: { id: string; title: string; votes: number }[]
  endsAt: string
}

export interface HelixPrediction {
  id: string
  title: string
  status: string
  outcomes: {
    id: string
    title: string
    users: number
    points: number
    color: string
    /** who bet the most on this outcome, and what it paid them; Twitch sends the top ten */
    top: { name: string; used: number; won: number }[]
  }[]
  locksAt: string
  /** set once resolved, so the panel can say which side was paid */
  winningOutcomeId?: string
}

export async function createPoll(
  account: Account,
  broadcasterId: string,
  title: string,
  choices: string[],
  durationSeconds: number,
  /** 0 means votes are free; anything above turns on paid extra votes at that price */
  pointsPerVote = 0
): Promise<HttpResponse> {
  return helixRequest(account, 'POST', '/polls', {}, {
    broadcaster_id: broadcasterId,
    title,
    choices: choices.map((t) => ({ title: t })),
    duration: durationSeconds,
    channel_points_voting_enabled: pointsPerVote > 0,
    ...(pointsPerVote > 0 ? { channel_points_per_vote: pointsPerVote } : {})
  })
}

/** TERMINATED stops it and shows the result; ARCHIVED hides it from viewers entirely */
export async function endPoll(
  account: Account,
  broadcasterId: string,
  pollId: string,
  status: 'TERMINATED' | 'ARCHIVED'
): Promise<HttpResponse> {
  return helixRequest(account, 'PATCH', '/polls', {}, {
    broadcaster_id: broadcasterId,
    id: pollId,
    status
  })
}

export async function getPolls(account: Account, broadcasterId: string): Promise<HelixPoll[]> {
  const res = await helixRequest(account, 'GET', '/polls', { broadcaster_id: broadcasterId, first: '1' })
  if (!res.ok) return []
  const data = (res.json as { data?: unknown[] } | null)?.data
  if (!Array.isArray(data)) return []
  return data.map((raw) => {
    const p = raw as {
      id: string
      title: string
      status: string
      ended_at?: string
      started_at?: string
      duration?: number
      choices?: { id: string; title: string; votes?: number }[]
    }
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      choices: (p.choices ?? []).map((c) => ({ id: c.id, title: c.title, votes: c.votes ?? 0 })),
      endsAt: p.ended_at ?? ''
    }
  })
}

export async function createPrediction(
  account: Account,
  broadcasterId: string,
  title: string,
  outcomes: string[],
  windowSeconds: number
): Promise<HttpResponse> {
  return helixRequest(account, 'POST', '/predictions', {}, {
    broadcaster_id: broadcasterId,
    title,
    outcomes: outcomes.map((t) => ({ title: t })),
    prediction_window: windowSeconds
  })
}

/**
 * LOCKED closes betting and leaves it open, RESOLVED pays the winning outcome out, CANCELED
 * refunds everyone. Resolving needs the outcome to pay.
 */
export async function endPrediction(
  account: Account,
  broadcasterId: string,
  predictionId: string,
  status: 'LOCKED' | 'RESOLVED' | 'CANCELED',
  winningOutcomeId?: string
): Promise<HttpResponse> {
  return helixRequest(account, 'PATCH', '/predictions', {}, {
    broadcaster_id: broadcasterId,
    id: predictionId,
    status,
    ...(winningOutcomeId ? { winning_outcome_id: winningOutcomeId } : {})
  })
}

export async function getPredictions(
  account: Account,
  broadcasterId: string
): Promise<HelixPrediction[]> {
  const res = await helixRequest(account, 'GET', '/predictions', {
    broadcaster_id: broadcasterId,
    first: '1'
  })
  if (!res.ok) return []
  const data = (res.json as { data?: unknown[] } | null)?.data
  if (!Array.isArray(data)) return []
  return data.map((raw) => {
    const p = raw as {
      id: string
      title: string
      status: string
      locked_at?: string
      winning_outcome_id?: string
      outcomes?: {
        id: string
        title: string
        users?: number
        channel_points?: number
        color?: string
        top_predictors?: {
          user_name?: string
          user_login?: string
          channel_points_used?: number
          channel_points_won?: number
        }[]
      }[]
    }
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      outcomes: (p.outcomes ?? []).map((o) => ({
        id: o.id,
        title: o.title,
        users: o.users ?? 0,
        points: o.channel_points ?? 0,
        color: o.color ?? 'BLUE',
        top: (o.top_predictors ?? []).map((t) => ({
          name: t.user_name ?? t.user_login ?? '?',
          used: t.channel_points_used ?? 0,
          won: t.channel_points_won ?? 0
        }))
      })),
      locksAt: p.locked_at ?? '',
      winningOutcomeId: p.winning_outcome_id ?? undefined
    }
  })
}

/**
 * Allow or deny a message AutoMod is holding.
 *
 * The documented endpoint, with the moderator's own id: Twitch decides from that whether this
 * account may act in that channel, so nothing here needs to know about roles.
 */
export async function manageAutoModMessage(
  account: Account,
  msgId: string,
  action: 'ALLOW' | 'DENY'
): Promise<HttpResponse> {
  return helixRequest(account, 'POST', '/moderation/automod/message', {}, {
    user_id: account.id,
    msg_id: msgId,
    action
  })
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

/**
 * The channel's real moderator and VIP lists. The chatters endpoint reports no roles, and the
 * message buffer only knows about people who have spoken recently — so a VIP who has been
 * quiet (or whose messages were trimmed) looked like a plain viewer. Needs the broadcaster's
 * token (or a moderator token for the mod list); returns [] when the scope isn't granted,
 * and the caller falls back to badges from the buffer.
 */
export async function getRoleLogins(
  account: Account,
  broadcasterId: string,
  kind: 'moderators' | 'vips'
): Promise<string[]> {
  const path = kind === 'moderators' ? '/moderation/moderators' : '/channels/vips'
  const out: string[] = []
  let cursor: string | undefined
  for (let i = 0; i < 10; i++) {
    const params: Record<string, string | undefined> = { broadcaster_id: broadcasterId, first: '100', after: cursor }
    if (kind === 'moderators') params.moderator_id = account.id
    const res = await helixRequest(account, 'GET', path, params)
    if (!res.ok) break
    const j = res.json as { data?: { user_login?: string }[]; pagination?: { cursor?: string } }
    for (const u of j.data ?? []) if (u.user_login) out.push(u.user_login.toLowerCase())
    cursor = j.pagination?.cursor
    if (!cursor) break
  }
  return out
}

export interface TwitchUserEmote {
  code: string
  url: string
  provider: 'twitch'
  ownerId: string
  emoteType: string
  /** this account cannot actually send it (sub-only emote of a channel we're not subbed to) */
  locked?: boolean
  /** subscription tier that unlocks it: '1000' | '2000' | '3000' (absent for other types) */
  tier?: string
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

/**
 * EVERY emote a channel has, regardless of whether this account may use them. `/chat/emotes/user`
 * only returns what you already unlocked, which is why followers/non-subs saw nothing at all for
 * a channel — even its free follower emotes. This endpoint needs no sub, so the picker can list
 * the full set and mark the locked ones.
 */
export async function getChannelEmotes(account: Account, broadcasterId: string): Promise<TwitchUserEmote[]> {
  const res = await helixRequest(account, 'GET', '/chat/emotes', { broadcaster_id: broadcasterId })
  if (!res.ok) return []
  const j = res.json as {
    data?: { id: string; name: string; emote_type?: string; tier?: string; format?: string[]; scale?: string[] }[]
    template?: string
  }
  const template =
    j.template ?? 'https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}'
  return (j.data ?? []).map((e) => {
    const scale = e.scale?.includes('2.0') ? '2.0' : (e.scale?.[0] ?? '1.0')
    return {
      code: e.name,
      url: template
        .replace('{{id}}', e.id)
        .replace('{{format}}', 'default')
        .replace('{{theme_mode}}', 'dark')
        .replace('{{scale}}', scale),
      provider: 'twitch' as const,
      ownerId: broadcasterId,
      emoteType: e.emote_type ?? 'subscriptions',
      // what it takes to unlock it, so the padlock can say so instead of just refusing
      tier: e.tier
    }
  })
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

/**
 * How many followers the channel has, for goal overlays.
 *
 * `total` comes back on the first page, so one row is asked for and the rest is never fetched.
 * Same scope as getFollowDate: the account has to be the broadcaster or one of its mods.
 */
export async function getFollowerTotal(account: Account, broadcasterId: string): Promise<number | null> {
  const res = await helixRequest(account, 'GET', '/channels/followers', {
    broadcaster_id: broadcasterId,
    moderator_id: account.id,
    first: '1'
  })
  if (!res.ok) return null
  const total = (res.json as { total?: number } | null)?.total
  return typeof total === 'number' ? total : null
}

/** subscriber count; channel:read:subscriptions, and only the broadcaster's own channel */
export async function getSubTotal(account: Account, broadcasterId: string): Promise<number | null> {
  const res = await helixRequest(account, 'GET', '/subscriptions', {
    broadcaster_id: broadcasterId,
    first: '1'
  })
  if (!res.ok) return null
  const total = (res.json as { total?: number } | null)?.total
  return typeof total === 'number' ? total : null
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
  /** the broadcaster's id; /streams/followed is matched on this rather than on the login */
  user_id: string
  user_login: string
  type: string
  started_at: string
  viewer_count: number
  title: string
  game_name?: string
}

export interface LiveInfo {
  startedAt: string
  viewers: number
  title: string
  game: string
}

/** the user's chosen chat color (used as the channel accent for PRIMARY announcements) */
export async function getUserChatColors(
  account: Account,
  userIds: string[]
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (let i = 0; i < userIds.length; i += 100) {
    const res = await helixRequest(account, 'GET', '/chat/color', { user_id: userIds.slice(i, i + 100) })
    if (!res.ok) continue
    for (const u of ((res.json as { data: { user_id: string; color: string }[] })?.data ?? [])) {
      if (u.color) out[u.user_id] = u.color
    }
  }
  return out
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
        title: s.title ?? '',
        game: s.game_name ?? ''
      })
    }
  }
  return live
}

/** one channel this account follows, with whatever it is doing right now */
export interface FollowedChannel {
  id: string
  login: string
  name: string
  followedAt: string
  live?: { title: string; game: string; viewers: number; startedAt: string }
}

/**
 * Everything this account follows, and which of them are on air.
 *
 * Two calls rather than one because Twitch splits them: /channels/followed lists the follows
 * whether or not they are live, and /streams/followed returns only the live ones but with the
 * title, category and viewer count. Merging gives a list that can say "offline" out loud instead
 * of quietly omitting anyone.
 */
export async function getFollowedChannels(account: Account): Promise<FollowedChannel[]> {
  const out: FollowedChannel[] = []
  let cursor = ''
  // a few hundred is normal; the cap stops a runaway loop rather than a real account
  for (let page = 0; page < 10; page++) {
    const res = await helixRequest(account, 'GET', '/channels/followed', {
      user_id: account.id,
      first: '100',
      ...(cursor ? { after: cursor } : {})
    })
    if (!res.ok) break
    const json = res.json as {
      data?: { broadcaster_id: string; broadcaster_login: string; broadcaster_name: string; followed_at: string }[]
      pagination?: { cursor?: string }
    } | null
    for (const f of json?.data ?? []) {
      out.push({
        id: f.broadcaster_id,
        login: (f.broadcaster_login ?? '').toLowerCase(),
        name: f.broadcaster_name || f.broadcaster_login,
        followedAt: f.followed_at
      })
    }
    cursor = json?.pagination?.cursor ?? ''
    if (!cursor) break
  }

  const liveById = new Map<string, FollowedChannel['live']>()
  let lc = ''
  for (let page = 0; page < 10; page++) {
    const res = await helixRequest(account, 'GET', '/streams/followed', {
      user_id: account.id,
      first: '100',
      ...(lc ? { after: lc } : {})
    })
    if (!res.ok) break
    const json = res.json as {
      data?: HelixStream[]
      pagination?: { cursor?: string }
    } | null
    for (const st of json?.data ?? []) {
      liveById.set(st.user_id, {
        title: st.title ?? '',
        game: st.game_name ?? '',
        viewers: st.viewer_count ?? 0,
        startedAt: st.started_at
      })
    }
    lc = json?.pagination?.cursor ?? ''
    if (!lc) break
  }
  for (const f of out) f.live = liveById.get(f.id)

  // live first, biggest audience at the top, then everyone else by name
  return out.sort((a, b) => {
    if (!!a.live !== !!b.live) return a.live ? -1 : 1
    if (a.live && b.live) return b.live.viewers - a.live.viewers
    return a.name.localeCompare(b.name)
  })
}

interface HelixBadgeSet {
  set_id: string
  versions: { id: string; image_url_2x: string; image_url_4x?: string; title?: string }[]
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

/**
 * Create an EventSub WebSocket subscription. Returns the raw HttpResponse so the caller can
 * tell a real failure from a harmless 409 (subscription already exists for this session).
 */
export async function createEventSubSubscription(
  account: Account,
  type: string,
  version: string,
  condition: Record<string, string>,
  sessionId: string
): Promise<HttpResponse> {
  return helixRequest(account, 'POST', '/eventsub/subscriptions', {}, {
    type,
    version,
    condition,
    transport: { method: 'websocket', session_id: sessionId }
  })
}

interface HelixCheermote {
  prefix: string
  tiers: {
    min_bits: number
    color: string
    images?: { dark?: { animated?: Record<string, string>; static?: Record<string, string> } }
  }[]
}

/** channel + global cheermotes (bit icons). broadcasterId gives channel-specific ones too. */
export interface HelixClip {
  id: string
  title: string
  thumbnail_url: string
  broadcaster_name: string
  creator_name: string
  view_count: number
}

/** clip metadata for inline link previews */
export async function getClips(account: Account, ids: string[]): Promise<HelixClip[]> {
  if (!ids.length) return []
  const res = await helixRequest(account, 'GET', '/clips', { id: ids })
  if (!res.ok) return []
  return (res.json as { data?: HelixClip[] })?.data ?? []
}

export async function getCheermotes(account: Account, broadcasterId: string): Promise<Cheermote[]> {
  const res = await helixRequest(account, 'GET', '/bits/cheermotes', { broadcaster_id: broadcasterId })
  if (!res.ok) return []
  const data = ((res.json as { data: HelixCheermote[] })?.data ?? []) as HelixCheermote[]
  return data.map((c) => ({
    prefix: c.prefix.toLowerCase(),
    tiers: c.tiers
      .map((t) => ({
        min: t.min_bits,
        // prefer the 2x animated icon, fall back to static
        url: t.images?.dark?.animated?.['2'] ?? t.images?.dark?.static?.['2'] ?? '',
        color: t.color
      }))
      .sort((a, b) => b.min - a.min)
  }))
}

function badgesToMap(res: HttpResponse): Record<string, string> {
  if (!res.ok) {
    console.warn('[badges] request failed', res.status, res.json ?? res.text)
    return {}
  }
  const out: Record<string, string> = {}
  for (const set of ((res.json as { data: HelixBadgeSet[] })?.data ?? []) as HelixBadgeSet[]) {
    for (const v of set.versions) {
      out[`${set.set_id}/${v.id}`] = v.image_url_2x
      // human-readable badge names for the hover preview, stored under a parallel key
      if (v.title) out[`${set.set_id}/${v.id}:title`] = v.title
      // the 4x art for the enlarged hover preview
      if (v.image_url_4x) out[`${set.set_id}/${v.id}:4x`] = v.image_url_4x
    }
  }
  return out
}

export { ensureFreshToken }
