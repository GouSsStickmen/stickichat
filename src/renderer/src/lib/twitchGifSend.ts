/**
 * Posting a real Twitch GIF message.
 *
 * This is the one thing in the app that does not go through a documented API, and it is opt-in for
 * that reason. Twitch makes GIF messages with a private GraphQL mutation and gql.twitch.tv refuses
 * third-party tokens outright — an OAuth token issued to this app comes back 401 "token is
 * invalid", and as a Bearer it is simply ignored (currentUser resolves to null) while the same
 * token answers 200 on Helix. So the only credential that works here is a twitch.tv web session,
 * which is why the setting that turns this on says plainly whose account is on the line.
 *
 * The mutation's shape was read off Twitch's own client and confirmed against the endpoint:
 * three required inputs, an error enum and the new message's id back. The title you see in chat
 * ("[Some GIF by Someone]") is written by their server from the GIF id — we do not send it.
 */
import { host } from './platform'

const GQL_URL = 'https://gql.twitch.tv/gql'

/**
 * The mobile client id, not the web one.
 *
 * Measured: with the web id the endpoint demands a Client-Integrity header and answers
 * "failed integrity check"; with the mobile id it goes straight to checking who you are. Twitch
 * can close that difference whenever they like, which is one more reason this is not the default.
 */
const CLIENT_ID = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp'

const MUTATION = `mutation StickiSendGif($input: SendGifMessageInput!) {
  sendGifMessage(input: $input) { error message { id } }
}`

export interface SendGifResult {
  ok: boolean
  /** Twitch's own error code when it refused, for the toast to explain rather than just fail */
  code?: string
}

interface GqlAnswer {
  data?: { sendGifMessage?: { error?: string | null; message?: { id?: string } | null } | null }
  errors?: { message?: string }[]
}

export async function sendGifMessage(
  session: string,
  channelId: string,
  gifId: string,
  gifUrl: string
): Promise<SendGifResult> {
  if (!session || !channelId || !gifId || !gifUrl) return { ok: false, code: 'NOT_CONNECTED' }
  try {
    const res = await host().request(GQL_URL, {
      method: 'POST',
      headers: {
        'Client-Id': CLIENT_ID,
        'Content-Type': 'application/json',
        Authorization: `OAuth ${session}`
      },
      body: JSON.stringify({
        query: MUTATION,
        variables: { input: { channelID: channelId, gifID: gifId, gifURL: gifUrl } }
      })
    })
    // a dead session is the failure worth naming: it is the one the user can fix, by signing in again
    if (res.status === 401) return { ok: false, code: 'SESSION_EXPIRED' }
    if (!res.ok) return { ok: false, code: `HTTP_${res.status}` }
    const json = res.json as GqlAnswer | undefined
    const top = json?.errors?.[0]?.message
    if (top) return { ok: false, code: top === 'unauthenticated' ? 'SESSION_EXPIRED' : top }
    const payload = json?.data?.sendGifMessage
    if (payload?.error) return { ok: false, code: payload.error }
    if (!payload?.message?.id) return { ok: false, code: 'NO_MESSAGE' }
    return { ok: true }
  } catch {
    return { ok: false, code: 'NETWORK' }
  }
}
