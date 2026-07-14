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
