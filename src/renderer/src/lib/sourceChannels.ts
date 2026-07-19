import { getUsers } from './helix'
import { useAccountsStore } from '../store/accounts'
import { useChatStore } from '../store/chat'

/**
 * Twitch SHARED CHAT: relayed messages carry the origin broadcaster's id. This resolves
 * that id to a channel name (open channels first, then one Helix lookup, cached).
 */
const cache = new Map<string, string>()
const pending = new Set<string>()

export function getSourceChannelName(id: string): string | null {
  const hit = cache.get(id)
  if (hit) return hit
  const ids = useChatStore.getState().channelIds
  for (const login of Object.keys(ids)) {
    if (ids[login] === id) {
      cache.set(id, login)
      return login
    }
  }
  if (!pending.has(id)) {
    pending.add(id)
    const account = useAccountsStore.getState().accounts.find((a) => a._accessToken)
    if (account) {
      getUsers(account, { ids: [id] })
        .then((users) => {
          const u = users[0]
          if (u) {
            cache.set(id, u.display_name || u.login)
            window.dispatchEvent(new CustomEvent('sticki:srcchan'))
          }
        })
        .catch(() => pending.delete(id))
    }
  }
  return null
}
