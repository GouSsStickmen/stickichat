import {
  fetch7tvChannel,
  fetch7tvGlobal,
  fetchBttvChannel,
  fetchBttvGlobal,
  fetchFfzChannel,
  fetchFfzGlobal,
  mergeEmotes
} from '../lib/emoteProviders'
import { SevenTvEvents } from '../lib/seventvEvents'
import { getChannelBadges, getChannelEmotes, getCheermotes, getGlobalBadges, getUserEmotes, getUsers } from '../lib/helix'
import type { TwitchUserEmote } from '../lib/helix'
import { Account } from '../types'
import { useAccountsStore } from '../store/accounts'
import { useSettingsStore } from '../store/settings'
import { translate } from '../i18n'
import { useEmotesStore } from '../store/emotes'
import { useChatStore } from '../store/chat'

let globalLoaded = false
const channelLoaded = new Set<string>()
let globalBadgesLoaded = false
const channelBadgesLoaded = new Set<string>()
const cheermotesLoaded = new Set<string>()

export async function loadGlobalEmotes(): Promise<void> {
  if (globalLoaded) return
  globalLoaded = true
  const [ffz, bttv, stv] = await Promise.all([fetchFfzGlobal(), fetchBttvGlobal(), fetch7tvGlobal()])
  useEmotesStore.getState().setGlobalEmotes(mergeEmotes(ffz, bttv, stv))
}

// live 7TV updates: an emote the broadcaster adds/removes appears/disappears instantly
const sevenTvEvents = new SevenTvEvents(({ channel, added, removed, actor }) => {
  // start from an empty map if the initial channel load hasn't landed yet — dropping the
  // event here used to lose the emote until the next restart
  const cur = useEmotesStore.getState().channelEmotes[channel] ?? new Map()
  const next = new Map(cur)
  for (const code of removed) next.delete(code)
  for (const e of added) next.set(e.code, e)
  // bumps the store `version`, which re-tokenizes messages already on screen — the new emote
  // renders immediately instead of waiting for an F5
  useEmotesStore.getState().setChannelEmotes(channel, next)

  if (!useSettingsStore.getState().settings.announceEmoteChanges) return
  const lang = useSettingsStore.getState().settings.language
  const by = actor ? translate(lang, 'info.emoteBy', { user: actor }) : ''
  void import('./chatService').then(({ chatService }) => {
    if (added.length) {
      chatService.localEmoteEvent(
        channel,
        // the url travels with the line: the emote may be gone from the set again by the time
        // anyone scrolls back to this, and the picture is the whole point of the message
        { kind: 'added', actor, emotes: added.map((e) => ({ code: e.code, url: e.url })) },
        translate(lang, 'info.emoteAdded', { emotes: added.map((e) => e.code).join(', ') }) + by
      )
    }
    if (removed.length) {
      chatService.localEmoteEvent(
        channel,
        { kind: 'removed', actor, emotes: removed.map((code) => ({ code, url: cur.get(code)?.url })) },
        translate(lang, 'info.emoteRemoved', { emotes: removed.join(', ') }) + by
      )
    }
  })
}, (e) => {
  // paints/badges pushed by the EventAPI go straight into the cosmetics store
  void import('../lib/seventvCosmetics').then((m) => m.applyLiveCosmetic(e))
})

export async function loadChannelEmotes(channel: string, twitchId: string): Promise<void> {
  if (channelLoaded.has(channel)) return
  channelLoaded.add(channel)
  const [ffz, bttv, stv] = await Promise.all([
    fetchFfzChannel(twitchId),
    fetchBttvChannel(twitchId),
    fetch7tvChannel(twitchId)
  ])
  useEmotesStore.getState().setChannelEmotes(channel, mergeEmotes(ffz, bttv, stv.emotes))
  if (stv.setId) sevenTvEvents.watch(channel, stv.setId)
  // follow paint/badge changes of everyone chatting here, so nick colours update live
  sevenTvEvents.watchCosmetics(twitchId)
}

export async function loadGlobalBadges(): Promise<void> {
  if (globalBadgesLoaded) return
  const account = useAccountsStore.getState().accounts[0]
  if (!account) return
  globalBadgesLoaded = true
  const map = await getGlobalBadges(account)
  if (Object.keys(map).length === 0) {
    // failed (expired token etc.) — don't cache the failure, allow a retry later
    globalBadgesLoaded = false
    return
  }
  useEmotesStore.getState().setGlobalBadges(map)
}

export async function loadChannelBadges(channel: string, twitchId: string): Promise<void> {
  if (channelBadgesLoaded.has(channel)) return
  const account = useAccountsStore.getState().accounts[0]
  if (!account) return
  channelBadgesLoaded.add(channel)
  const map = await getChannelBadges(account, twitchId)
  if (Object.keys(map).length === 0) {
    channelBadgesLoaded.delete(channel)
    return
  }
  useEmotesStore.getState().setChannelBadges(channel, map)
}

/** channel + global cheermotes (bit icons) for a channel */
export async function loadCheermotes(channel: string, twitchId: string): Promise<void> {
  if (cheermotesLoaded.has(channel)) return
  const account = useAccountsStore.getState().accounts[0]
  if (!account) return
  cheermotesLoaded.add(channel)
  const list = await getCheermotes(account, twitchId)
  if (list.length === 0) {
    cheermotesLoaded.delete(channel)
    return
  }
  useEmotesStore.getState().setCheermotes(channel, list)
}

/** Re-fetch all badges (global + every known channel). Called after a (re-)authorization. */
export function reloadAllBadges(): void {
  globalBadgesLoaded = false
  channelBadgesLoaded.clear()
  loadGlobalBadges()
  const { channelIds } = useChatStore.getState()
  for (const [channel, id] of Object.entries(channelIds)) {
    if (id) loadChannelBadges(channel, id)
  }
}

const twitchEmotesLoading = new Set<string>()
const twitchEmotesLoaded = new Set<string>()
const ownerNamesLoading = new Set<string>()

// The user-emote list takes dozens of sequential Helix pages (~seconds). Every new window is a
// fresh renderer with empty stores, so without a cross-window cache the standalone picker
// re-downloads everything on each open. localStorage is shared by all windows of the app.
const TWITCH_EMOTES_TTL = 60 * 60 * 1000
const twitchEmotesCacheKey = (accountId: string): string => `sticki:twitchEmotes:${accountId}`

interface TwitchEmotesCache {
  at: number
  list: TwitchUserEmote[]
  names: Record<string, string>
}

function readTwitchEmotesCache(accountId: string): TwitchEmotesCache | null {
  try {
    const raw = localStorage.getItem(twitchEmotesCacheKey(accountId))
    const parsed = raw ? (JSON.parse(raw) as TwitchEmotesCache) : null
    return parsed?.list?.length ? parsed : null
  } catch {
    return null
  }
}

/** lazily loads all twitch emotes usable by the account (incl. sub emotes) */
/**
 * The channel's own emote sets, merged into the account's usable list with a `locked` flag on
 * anything the account can't actually send. Without this, a viewer with no sub saw NOTHING for
 * the channel — not even its free follower emotes — because /chat/emotes/user only returns
 * emotes you already unlocked.
 */
const channelEmoteSetsLoaded = new Set<string>()

export async function loadTwitchChannelEmotes(account: Account, channelId: string): Promise<void> {
  const key = `${account.id}:${channelId}`
  if (channelEmoteSetsLoaded.has(key)) return
  channelEmoteSetsLoaded.add(key)
  const all = await getChannelEmotes(account, channelId)
  if (!all.length) {
    channelEmoteSetsLoaded.delete(key)
    return
  }
  const st = useEmotesStore.getState()
  const mine = st.twitchByAccount[account.id] ?? []
  const usable = new Set(mine.map((e) => e.code))
  // Only SUBSCRIPTION/bits tiers are actually gated. Follower emotes (and anything Twitch
  // labels otherwise) are free to use, so padlocking every emote missing from our own list
  // was wrong — /chat/emotes/user simply hadn't been refreshed for them.
  const GATED = new Set(['subscriptions', 'bitstier'])
  const extra = all
    .filter((e) => !usable.has(e.code))
    .map((e) => ({ ...e, locked: GATED.has(e.emoteType) }))
  if (!extra.length) return
  st.setTwitchEmotes(account.id, [...mine, ...extra])
  void loadEmoteOwnerNames(account, [channelId])
}

export async function loadTwitchUserEmotes(account: Account): Promise<void> {
  // guard on a "fully loaded" flag, not store presence: pages stream into the store while
  // loading, and a mid-way failure must stay retryable instead of freezing a partial list
  if (twitchEmotesLoaded.has(account.id) || twitchEmotesLoading.has(account.id)) return
  twitchEmotesLoading.add(account.id)
  try {
    const cached = readTwitchEmotesCache(account.id)
    if (cached) {
      useEmotesStore.getState().setTwitchEmotes(account.id, cached.list)
      useEmotesStore.getState().setOwnerNames(cached.names ?? {})
      if (Date.now() - cached.at < TWITCH_EMOTES_TTL) {
        twitchEmotesLoaded.add(account.id)
        return
      }
      // stale: keep showing the cached list, silently re-fetch below
    }
    const list = await getUserEmotes(account, (partial) => {
      // stream pages in so the picker fills progressively — but never shrink an
      // already-shown cached list down to a partial page
      if (!cached) {
        useEmotesStore.getState().setTwitchEmotes(account.id, partial)
        loadEmoteOwnerNames(account, partial.map((e) => e.ownerId))
      }
    })
    if (list.length === 0) return // failed — keep cache/partial state, retry later
    useEmotesStore.getState().setTwitchEmotes(account.id, list)
    twitchEmotesLoaded.add(account.id)
    await loadEmoteOwnerNames(account, list.map((e) => e.ownerId))
    try {
      localStorage.setItem(
        twitchEmotesCacheKey(account.id),
        JSON.stringify({
          at: Date.now(),
          list,
          names: useEmotesStore.getState().ownerNames
        } satisfies TwitchEmotesCache)
      )
    } catch {
      /* storage full/unavailable — cache is best-effort */
    }
  } finally {
    twitchEmotesLoading.delete(account.id)
  }
}

/** resolves twitch user ids -> display names, used to label emote groups by channel */
export async function loadEmoteOwnerNames(account: Account, ids: string[]): Promise<void> {
  const st = useEmotesStore.getState()
  const known = st.ownerNames
  const knownAvatars = st.ownerAvatars
  // fetch when EITHER the name or the avatar is missing (older sessions cached names but not
  // avatars, which left the Twitch-tab owner rail without pictures)
  const missing = [...new Set(ids)].filter(
    (id) => id && id !== '0' && !ownerNamesLoading.has(id) && (!known[id] || !knownAvatars[id])
  )
  if (missing.length === 0) return
  missing.forEach((id) => ownerNamesLoading.add(id))
  try {
    const names: Record<string, string> = {}
    const avatars: Record<string, string> = {}
    const logins: Record<string, string> = {}
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100)
      const users = await getUsers(account, { ids: batch })
      for (const u of users) {
        names[u.id] = u.display_name
        logins[u.id] = u.login
        if (u.profile_image_url) avatars[u.id] = u.profile_image_url
      }
    }
    useEmotesStore.getState().setOwnerNames(names)
    useEmotesStore.getState().setOwnerLogins(logins)
    useEmotesStore.getState().setOwnerAvatars(avatars)
  } finally {
    missing.forEach((id) => ownerNamesLoading.delete(id))
  }
}

/** allow re-fetch on demand (e.g. settings button in the future) */
export function resetEmoteCache(): void {
  globalLoaded = false
  channelLoaded.clear()
  globalBadgesLoaded = false
  channelBadgesLoaded.clear()
  cheermotesLoaded.clear()
}

/** F5: force re-fetch EVERYTHING emote/badge-related for every known channel */
export function reloadAllEmotes(): void {
  resetEmoteCache()
  loadGlobalEmotes()
  loadGlobalBadges()
  const { channelIds } = useChatStore.getState()
  for (const [channel, id] of Object.entries(channelIds)) {
    if (!id) continue
    loadChannelEmotes(channel, id)
    loadChannelBadges(channel, id)
    loadCheermotes(channel, id)
  }
}
