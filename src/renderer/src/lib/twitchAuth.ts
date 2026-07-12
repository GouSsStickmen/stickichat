import { httpForm, httpGet } from './http'
import { Account } from '../types'
import { useAccountsStore } from '../store/accounts'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { translate } from '../i18n'
import { persistAccountTokens } from '../services/config'

export const TWITCH_SCOPES = [
  'chat:read',
  'chat:edit',
  'user:read:chat',
  'user:read:moderated_channels',
  'user:read:emotes',
  'moderator:manage:banned_users',
  'moderator:manage:chat_messages',
  'moderator:manage:announcements',
  'moderator:manage:shoutouts',
  'moderator:manage:warnings',
  'moderator:manage:chat_settings',
  'moderator:read:chatters',
  'moderator:read:followers',
  'channel:read:subscriptions',
  'channel:manage:raids',
  'channel:manage:moderators',
  'channel:manage:vips',
  // whispers: EventSub user.whisper.message needs the READ scope specifically; manage alone
  // was not enough, which is why inbound whispers never arrived
  'user:read:whispers',
  'user:manage:whispers',
  // EventSub channel.moderate v2 ("who banned/timed out/deleted") requires read access to
  // EVERY moderation surface; the manage:* scopes above cover most, these fill the gaps
  'moderator:read:blocked_terms',
  'moderator:read:unban_requests',
  'moderator:read:moderators',
  'moderator:read:vips'
].join(' ')

export interface DeviceCodeInfo {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface TokenPair {
  access_token: string
  refresh_token: string
}

export async function startDeviceFlow(clientId: string): Promise<DeviceCodeInfo> {
  const res = await httpForm('https://id.twitch.tv/oauth2/device', {
    client_id: clientId,
    scopes: TWITCH_SCOPES
  })
  if (!res.ok) throw new Error(`device flow start failed: ${res.status} ${res.text}`)
  return res.json as DeviceCodeInfo
}

/** Polls until the user authorizes, the code expires, or `cancelled()` returns true. */
export async function pollDeviceToken(
  clientId: string,
  device: DeviceCodeInfo,
  cancelled: () => boolean
): Promise<TokenPair> {
  const deadline = Date.now() + device.expires_in * 1000
  const intervalMs = Math.max(device.interval, 5) * 1000
  for (;;) {
    if (cancelled()) throw new Error('cancelled')
    if (Date.now() > deadline) throw new Error('code expired')
    await new Promise((r) => setTimeout(r, intervalMs))
    if (cancelled()) throw new Error('cancelled')
    const res = await httpForm('https://id.twitch.tv/oauth2/token', {
      client_id: clientId,
      scopes: TWITCH_SCOPES,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
    if (res.ok) return res.json as TokenPair
    const msg = ((res.json as { message?: string })?.message ?? '').toLowerCase()
    if (msg.includes('pending')) continue
    if (msg.includes('slow')) continue
    throw new Error(`authorization failed: ${res.status} ${res.text}`)
  }
}

export async function refreshTokens(clientId: string, refreshToken: string): Promise<TokenPair> {
  const res = await httpForm('https://id.twitch.tv/oauth2/token', {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  })
  if (!res.ok) throw new Error(`refresh failed: ${res.status} ${JSON.stringify(res.json ?? res.text)}`)
  return res.json as TokenPair
}

export interface ValidateInfo {
  login: string
  user_id: string
  client_id: string
  expires_in: number
}

export async function validateToken(token: string): Promise<ValidateInfo | null> {
  const res = await httpGet('https://id.twitch.tv/oauth2/validate', {
    Authorization: `OAuth ${token}`
  })
  if (!res.ok) return null
  return res.json as ValidateInfo
}

// avoids hitting /oauth2/validate on every single chat send — that round-trip was
// adding a real, noticeable delay before messages went out
const lastValidatedAt = new Map<string, number>()
const VALIDATE_INTERVAL_MS = 20 * 60 * 1000

// Twitch rotates refresh tokens: once one refresh succeeds, the old refresh_token is dead.
// Several Helix calls firing at once (e.g. global + per-channel badges on connect) would each
// see a 401 and independently race to refresh with the same now-stale token — only the first
// succeeds, the rest get a 400. Dedupe concurrent refreshes per account into one shared call.
const refreshInFlight = new Map<string, Promise<string>>()
const reauthToastAt = new Map<string, number>()

/** the refresh token itself was rejected — only a full re-authorization can fix this */
function notifyReauthNeeded(account: Account): void {
  const now = Date.now()
  if (now - (reauthToastAt.get(account.id) ?? 0) < 5 * 60 * 1000) return
  reauthToastAt.set(account.id, now)
  const lang = useSettingsStore.getState().settings.language
  useUiStore.getState().toast(translate(lang, 'auth.reauthNeeded', { login: account.login }), 'error')
}

async function refreshAndPersist(clientId: string, account: Account): Promise<string> {
  const existing = refreshInFlight.get(account.id)
  if (existing) return existing

  const run = (async (): Promise<string> => {
    const fresh = useAccountsStore.getState().accounts.find((a) => a.id === account.id) ?? account
    if (!fresh._refreshToken) {
      notifyReauthNeeded(account)
      throw new Error('no refresh token')
    }
    let pair: TokenPair
    try {
      pair = await refreshTokens(clientId, fresh._refreshToken)
    } catch (e) {
      if (String(e).includes('Invalid refresh token')) notifyReauthNeeded(account)
      throw e
    }
    const accessTokenEnc = await window.sticki.encrypt(pair.access_token)
    const refreshTokenEnc = await window.sticki.encrypt(pair.refresh_token)
    useAccountsStore.getState().updateAccount(account.id, {
      _accessToken: pair.access_token,
      _refreshToken: pair.refresh_token,
      accessTokenEnc,
      refreshTokenEnc
    })
    lastValidatedAt.set(account.id, Date.now())
    // Twitch just invalidated the old refresh token — write the new one to disk NOW,
    // from any window. Utility windows have no store persistence, and even the main
    // window's debounced save can be lost to a crash, leaving a dead token on disk.
    await persistAccountTokens(account.id)
    return pair.access_token
  })()

  refreshInFlight.set(account.id, run)
  try {
    return await run
  } finally {
    refreshInFlight.delete(account.id)
  }
}

/**
 * Returns a valid access token for the account, refreshing (and persisting) if needed.
 * Throws if refresh fails — the account then needs re-authorization.
 */
export async function ensureFreshToken(clientId: string, account: Account): Promise<string> {
  if (account._accessToken && !refreshInFlight.has(account.id)) {
    const lastCheck = lastValidatedAt.get(account.id) ?? 0
    if (Date.now() - lastCheck < VALIDATE_INTERVAL_MS) return account._accessToken
    const info = await validateToken(account._accessToken)
    if (info) {
      lastValidatedAt.set(account.id, Date.now())
      return account._accessToken
    }
  }
  return refreshAndPersist(clientId, account)
}

/** Refreshes (deduped across concurrent callers) and returns the new access token. */
export async function refreshAccountToken(clientId: string, account: Account): Promise<string> {
  return refreshAndPersist(clientId, account)
}
