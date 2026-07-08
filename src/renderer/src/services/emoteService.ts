import {
  fetch7tvChannel,
  fetch7tvGlobal,
  fetchBttvChannel,
  fetchBttvGlobal,
  fetchFfzChannel,
  fetchFfzGlobal,
  mergeEmotes
} from '../lib/emoteProviders'
import { getChannelBadges, getGlobalBadges, getUserEmotes, getUsers } from '../lib/helix'
import { Account } from '../types'
import { useAccountsStore } from '../store/accounts'
import { useEmotesStore } from '../store/emotes'

let globalLoaded = false
const channelLoaded = new Set<string>()
let globalBadgesLoaded = false
const channelBadgesLoaded = new Set<string>()

export async function loadGlobalEmotes(): Promise<void> {
  if (globalLoaded) return
  globalLoaded = true
  const [ffz, bttv, stv] = await Promise.all([fetchFfzGlobal(), fetchBttvGlobal(), fetch7tvGlobal()])
  useEmotesStore.getState().setGlobalEmotes(mergeEmotes(ffz, bttv, stv))
}

export async function loadChannelEmotes(channel: string, twitchId: string): Promise<void> {
  if (channelLoaded.has(channel)) return
  channelLoaded.add(channel)
  const [ffz, bttv, stv] = await Promise.all([
    fetchFfzChannel(twitchId),
    fetchBttvChannel(twitchId),
    fetch7tvChannel(twitchId)
  ])
  useEmotesStore.getState().setChannelEmotes(channel, mergeEmotes(ffz, bttv, stv))
}

export async function loadGlobalBadges(): Promise<void> {
  if (globalBadgesLoaded) return
  const account = useAccountsStore.getState().accounts[0]
  if (!account) return
  globalBadgesLoaded = true
  useEmotesStore.getState().setGlobalBadges(await getGlobalBadges(account))
}

export async function loadChannelBadges(channel: string, twitchId: string): Promise<void> {
  if (channelBadgesLoaded.has(channel)) return
  const account = useAccountsStore.getState().accounts[0]
  if (!account) return
  channelBadgesLoaded.add(channel)
  useEmotesStore.getState().setChannelBadges(channel, await getChannelBadges(account, twitchId))
}

const twitchEmotesLoading = new Set<string>()
const ownerNamesLoading = new Set<string>()

/** lazily loads all twitch emotes usable by the account (incl. sub emotes) */
export async function loadTwitchUserEmotes(account: Account): Promise<void> {
  const st = useEmotesStore.getState()
  if (st.twitchByAccount[account.id] || twitchEmotesLoading.has(account.id)) return
  twitchEmotesLoading.add(account.id)
  try {
    const list = await getUserEmotes(account)
    useEmotesStore.getState().setTwitchEmotes(account.id, list)
    await loadEmoteOwnerNames(account, list.map((e) => e.ownerId))
  } finally {
    twitchEmotesLoading.delete(account.id)
  }
}

/** resolves twitch user ids -> display names, used to label emote groups by channel */
export async function loadEmoteOwnerNames(account: Account, ids: string[]): Promise<void> {
  const known = useEmotesStore.getState().ownerNames
  const missing = [...new Set(ids)].filter(
    (id) => id && id !== '0' && !known[id] && !ownerNamesLoading.has(id)
  )
  if (missing.length === 0) return
  missing.forEach((id) => ownerNamesLoading.add(id))
  try {
    const names: Record<string, string> = {}
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100)
      const users = await getUsers(account, { ids: batch })
      for (const u of users) names[u.id] = u.display_name
    }
    useEmotesStore.getState().setOwnerNames(names)
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
}
