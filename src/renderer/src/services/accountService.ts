import { Account } from '../types'
import { getModeratedChannelIds, getUsers } from '../lib/helix'
import { useAccountsStore } from '../store/accounts'
import { chatService } from './chatService'

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
    if (ids) useAccountsStore.getState().updateAccount(accountId, { moderatedChannelIds: ids })
  } catch {
    /* keep old cache */
  }
}

export function removeAccountEverywhere(accountId: string): void {
  chatService.dropSender(accountId)
  useAccountsStore.getState().removeAccount(accountId)
}

/** Is this account allowed to moderate this channel? */
export function canModerate(account: Account | undefined, channel: string, channelId: string): boolean {
  if (!account) return false
  if (account.login.toLowerCase() === channel.toLowerCase()) return true // broadcaster
  return !!channelId && account.moderatedChannelIds.includes(channelId)
}
