import { httpForm, httpGet } from './http'
import { Account } from '../types'
import { useAccountsStore } from '../store/accounts'

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
  'user:manage:whispers'
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
  if (!res.ok) throw new Error(`refresh failed: ${res.status}`)
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

/**
 * Returns a valid access token for the account, refreshing (and persisting) if needed.
 * Throws if refresh fails — the account then needs re-authorization.
 */
export async function ensureFreshToken(clientId: string, account: Account): Promise<string> {
  if (account._accessToken) {
    const lastCheck = lastValidatedAt.get(account.id) ?? 0
    if (Date.now() - lastCheck < VALIDATE_INTERVAL_MS) return account._accessToken
    const info = await validateToken(account._accessToken)
    if (info) {
      lastValidatedAt.set(account.id, Date.now())
      return account._accessToken
    }
  }
  if (!account._refreshToken) throw new Error('no refresh token')
  const pair = await refreshTokens(clientId, account._refreshToken)
  const accessTokenEnc = await window.sticki.encrypt(pair.access_token)
  const refreshTokenEnc = await window.sticki.encrypt(pair.refresh_token)
  useAccountsStore.getState().updateAccount(account.id, {
    _accessToken: pair.access_token,
    _refreshToken: pair.refresh_token,
    accessTokenEnc,
    refreshTokenEnc
  })
  lastValidatedAt.set(account.id, Date.now())
  return pair.access_token
}
