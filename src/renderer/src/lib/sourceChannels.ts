import { getUsers } from './helix'
import { useAccountsStore } from '../store/accounts'
import { useChatStore } from '../store/chat'

/**
 * Twitch SHARED CHAT: relayed messages carry the origin broadcaster's id. This resolves
 * that id to a channel name + avatar (one cached Helix lookup; open channels get their
 * name instantly while the avatar loads).
 */
export interface SourceChannelInfo {
  name: string
  avatar?: string
}

const cache = new Map<string, SourceChannelInfo>()
const pending = new Set<string>()

function fetchInfo(id: string): void {
  if (pending.has(id)) return
  pending.add(id)
  const account = useAccountsStore.getState().accounts.find((a) => a._accessToken)
  if (!account) {
    pending.delete(id)
    return
  }
  getUsers(account, { ids: [id] })
    .then((users) => {
      const u = users[0]
      if (u) {
        cache.set(id, { name: u.display_name || u.login, avatar: u.profile_image_url })
        window.dispatchEvent(new CustomEvent('sticki:srcchan'))
      }
    })
    .catch(() => pending.delete(id))
}

export function getSourceChannelInfo(id: string): SourceChannelInfo | null {
  const hit = cache.get(id)
  if (hit?.avatar) return hit
  fetchInfo(id) // avatar still missing — resolve (or upgrade a name-only entry)
  if (hit) return hit
  const ids = useChatStore.getState().channelIds
  for (const login of Object.keys(ids)) {
    if (ids[login] === id) {
      const info = { name: login }
      cache.set(id, info)
      return info
    }
  }
  return null
}
