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
import { getChannelBadges, getCheermotes, getGlobalBadges, getUserEmotes, getUsers } from '../lib/helix'
import type { TwitchUserEmote } from '../lib/helix'
import { Account } from '../types'
import { useAccountsStore } from '../store/accounts'
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
const sevenTvEvents = new SevenTvEvents(({ channel, added, removed }) => {
  const cur = useEmotesStore.getState().channelEmotes[channel]
  if (!cur) return
  const next = new Map(cur)
  for (const code of removed) next.delete(code)
  for (const e of added) next.set(e.code, e)
  useEmotesStore.getState().setChannelEmotes(channel, next)
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
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100)
      const users = await getUsers(account, { ids: batch })
      for (const u of users) {
        names[u.id] = u.display_name
        if (u.profile_image_url) avatars[u.id] = u.profile_image_url
      }
    }
    useEmotesStore.getState().setOwnerNames(names)
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
