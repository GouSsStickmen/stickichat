/**
 * Twitch's public GraphQL endpoint. The Helix API does NOT expose a channel's chat rules
 * (the list shown to first-time chatters), so — like Chatterino and other chat tools — we
 * read them from the public GQL endpoint with the well-known web Client-ID. Best-effort:
 * any failure (CORS, schema change, network) returns [] and the caller falls back.
 */
const GQL_URL = 'https://gql.twitch.tv/gql'
const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

const cache = new Map<string, string[]>()

export async function fetchChatRules(login: string): Promise<string[]> {
  const key = login.toLowerCase()
  const cached = cache.get(key)
  if (cached) return cached
  try {
    // go through the main process (window.sticki.fetchJson) — a direct renderer fetch to
    // gql.twitch.tv is blocked by CORS
    const res = await window.sticki.fetchJson(GQL_URL, {
      method: 'POST',
      headers: { 'Client-Id': WEB_CLIENT_ID, 'Content-Type': 'application/json' },
      // login is a validated Twitch login (word chars only), safe to inline
      body: JSON.stringify({
        query: `query { channel(name: "${key}") { chatSettings { rules } } }`
      })
    })
    if (!res.ok) return []
    const json = res.json as { data?: { channel?: { chatSettings?: { rules?: unknown } } } }
    const rules = json?.data?.channel?.chatSettings?.rules
    const list = Array.isArray(rules) ? (rules.filter((r) => typeof r === 'string') as string[]) : []
    if (list.length) cache.set(key, list)
    return list
  } catch {
    return []
  }
}

/** one badge as Twitch's own viewer card lists it */
export interface GqlBadge {
  setId: string
  version: string
  title: string
  url: string
}

const badgeCache = new Map<string, GqlBadge[]>()

/**
 * Every badge Twitch reports for a user, via the public GQL endpoint — the same source the
 * web viewer card's badge grid reads. Helix has no equivalent: it only exposes badge SETS,
 * never which ones a given user owns, so the IRC tag (what they wear in THIS channel) was
 * all we had. Best-effort; any failure returns [].
 *
 * NB: only badges the user currently displays are public. Twitch's full "all badges I ever
 * earned" collection is readable for your OWN account only, so this is the honest maximum.
 */
export async function fetchUserBadges(login: string): Promise<GqlBadge[]> {
  const key = login.toLowerCase()
  const cached = badgeCache.get(key)
  if (cached) return cached
  try {
    const res = await window.sticki.fetchJson(GQL_URL, {
      method: 'POST',
      headers: { 'Client-Id': WEB_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query { user(login: "${key}") { displayBadges { setID version title imageURL(size: DOUBLE) } } }`
      })
    })
    if (!res.ok) return []
    const json = res.json as {
      data?: { user?: { displayBadges?: { setID?: string; version?: string; title?: string; imageURL?: string }[] } }
    }
    const list = (json?.data?.user?.displayBadges ?? [])
      .filter((b) => b.setID && b.imageURL)
      .map((b) => ({
        setId: String(b.setID),
        version: String(b.version ?? '1'),
        title: String(b.title ?? b.setID),
        url: String(b.imageURL)
      }))
    badgeCache.set(key, list)
    return list
  } catch {
    return []
  }
}
