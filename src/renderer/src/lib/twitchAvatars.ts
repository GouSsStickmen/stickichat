import { getUsers } from './helix'
import { useAccountsStore } from '../store/accounts'
import { queueWrite } from './lsWriter'

/**
 * Lazily-fetched Twitch avatar URLs by login, for the OBS overlay's avatar element.
 * Requests are queued and batched (Helix /users takes up to 100 logins), cached in
 * localStorage with a TTL so profile-picture changes eventually show up.
 */

const CACHE_KEY = 'sticki:avatars:v1'
const TTL = 7 * 24 * 3600_000 // refresh weekly
/**
 * How many logins are worth keeping.
 *
 * Nothing ever removed entries here, and every chatter in every channel adds one — after a few
 * weeks this key held 91 909 avatars and 14.3 MB, which is 70% of everything the app stores. The
 * size is what made saving expensive (see `lsWriter`), and almost all of it was dead: logins from
 * streams months ago, most already past the TTL. A few thousand covers everyone who has spoken
 * recently, and dropping one costs a single entry in the next batched fetch.
 */
const MAX_ENTRIES = 5000

interface CacheEntry {
  url: string
  at: number
}

let cache: Record<string, CacheEntry> = {}
try {
  cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
} catch {
  cache = {}
}

/** drop what the TTL has already invalidated, then the oldest of whatever is still over the cap */
function prune(): void {
  const now = Date.now()
  for (const login of Object.keys(cache)) {
    if (now - cache[login].at > TTL) delete cache[login]
  }
  const left = Object.keys(cache)
  if (left.length <= MAX_ENTRIES) return
  left.sort((a, b) => cache[b].at - cache[a].at)
  for (let i = MAX_ENTRIES; i < left.length; i++) delete cache[left[i]]
}

prune()

function saveCache(): void {
  queueWrite(CACHE_KEY, () => {
    prune()
    return JSON.stringify(cache)
  })
}

const queue = new Set<string>()
const waiters = new Map<string, ((url: string | undefined) => void)[]>()
let flushTimer: number | null = null

async function flush(): Promise<void> {
  flushTimer = null
  const logins = [...queue]
  queue.clear()
  if (!logins.length) return
  const account = useAccountsStore.getState().accounts.find((a) => a._accessToken)
  const resolve = (login: string, url: string | undefined): void => {
    for (const w of waiters.get(login) ?? []) w(url)
    waiters.delete(login)
  }
  if (!account) {
    for (const l of logins) resolve(l, undefined)
    return
  }
  try {
    for (let i = 0; i < logins.length; i += 100) {
      const users = await getUsers(account, { logins: logins.slice(i, i + 100) })
      const got = new Set<string>()
      for (const u of users) {
        const login = u.login.toLowerCase()
        got.add(login)
        cache[login] = { url: u.profile_image_url ?? '', at: Date.now() }
        resolve(login, u.profile_image_url)
      }
      // deleted/renamed accounts: negative-cache an empty url so we don't refetch every message
      for (const l of logins.slice(i, i + 100)) {
        if (!got.has(l)) {
          cache[l] = { url: '', at: Date.now() }
          resolve(l, undefined)
        }
      }
    }
    saveCache()
  } catch {
    for (const l of logins) resolve(l, undefined)
  }
}

function enqueue(login: string): void {
  queue.add(login)
  if (flushTimer === null) flushTimer = window.setTimeout(() => void flush(), 400)
}

/** cached avatar url (may be stale within TTL); triggers a background refresh when missing */
export function ensureAvatar(login: string): string | undefined {
  const key = login.toLowerCase()
  const hit = cache[key]
  if (hit && Date.now() - hit.at < TTL) return hit.url || undefined
  enqueue(key)
  return hit?.url || undefined
}

/** async variant: resolves from cache or after the batched fetch lands (overlay push path) */
export function awaitAvatar(login: string): Promise<string | undefined> {
  const key = login.toLowerCase()
  const hit = cache[key]
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.url || undefined)
  return new Promise((res) => {
    const list = waiters.get(key) ?? []
    list.push(res)
    waiters.set(key, list)
    enqueue(key)
  })
}
