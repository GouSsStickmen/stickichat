import { Account } from '../types'
import { getModeratedChannelIds, getUsers } from '../lib/helix'
import { useAccountsStore } from '../store/accounts'
import { chatService } from './chatService'
import { persistAccountRemoval } from './config'

/** Builds a full Account after a successful device-flow authorization. */
export async function createAccountFromTokens(
  accessToken: string,
  refreshToken: string,
  userId: string,
  login: string
): Promise<Account> {
  const accessTokenEnc = await window.sticki.encrypt(accessToken)
  const refreshTokenEnc = await window.sticki.encrypt(refreshToken)
  const account: Account = {
    id: userId,
    login,
    displayName: login,
    accessTokenEnc,
    refreshTokenEnc,
    moderatedChannelIds: [],
    _accessToken: accessToken,
    _refreshToken: refreshToken
  }
  // enrich with avatar/display name + moderated channels (best effort)
  try {
    const [user] = await getUsers(account, { ids: [userId] })
    if (user) {
      account.displayName = user.display_name
      account.avatarUrl = user.profile_image_url
    }
    account.moderatedChannelIds = (await getModeratedChannelIds(account)) ?? []
  } catch {
    /* non-fatal */
  }
  return account
}

/** Refreshes the cached list of channels the account moderates. */
export async function refreshModeratedChannels(accountId: string): Promise<void> {
  const account = useAccountsStore.getState().accounts.find((a) => a.id === accountId)
  if (!account) return
  try {
    const ids = await getModeratedChannelIds(account)
    // null = API failure — keep the old cache instead of wiping mod rights
    if (!ids) return
    // only write when the set actually changed, so the 2-min poll doesn't churn the store
    // (which would re-render chat panes and trigger a config save every tick)
    const prev = account.moderatedChannelIds
    const changed = ids.length !== prev.length || ids.some((id) => !prev.includes(id))
    if (changed) useAccountsStore.getState().updateAccount(accountId, { moderatedChannelIds: ids })
  } catch {
    /* keep old cache */
  }
}

export function removeAccountEverywhere(accountId: string): void {
  chatService.dropSender(accountId)
  useAccountsStore.getState().removeAccount(accountId)
  // write the removal to disk directly + notify other windows: the standalone settings window
  // has no account-store persistence, so without this the account came back on the next open
  persistAccountRemoval(accountId).catch(() => undefined)
}

/** Is this account allowed to moderate this channel? */
export function canModerate(account: Account | undefined, channel: string, channelId: string): boolean {
  if (!account) return false
  if (account.login.toLowerCase() === channel.toLowerCase()) return true // broadcaster
  return !!channelId && account.moderatedChannelIds.includes(channelId)
}
