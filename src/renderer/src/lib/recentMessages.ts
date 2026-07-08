import { httpGet } from './http'

/**
 * Fetches recent chat history for a channel from the community-run
 * recent-messages service (the same one Chatterino uses).
 * Returns raw IRC lines, oldest first.
 */
export async function fetchRecentMessages(channel: string, limit = 120): Promise<string[]> {
  const res = await httpGet(
    `https://recent-messages.robotty.de/api/v2/recent-messages/${encodeURIComponent(
      channel.toLowerCase()
    )}?limit=${limit}`
  )
  if (!res.ok) return []
  const j = res.json as { messages?: string[] }
  return j.messages ?? []
}
