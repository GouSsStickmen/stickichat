import { useEffect, useMemo, useRef, useState } from 'react'
import { useUiStore, UserCardTarget } from '../store/ui'
import { useChatStore } from '../store/chat'
import { useAccountsStore } from '../store/accounts'
import { lookupBadgeUrl } from '../store/emotes'
import { canModerate } from '../services/accountService'
import { getFollowDate, getSubInfo, getUsers, HelixUser, SubInfo } from '../lib/helix'
import { banUser, unbanUser, warnUser } from '../lib/helix'
import { useT } from '../i18n'
import { formatDuration } from '../lib/tokenize'

const TIMEOUTS = [60, 600, 3600, 86400]

export default function UserCard({ target }: { target: UserCardTarget }): React.JSX.Element {
  const t = useT()
  const close = (): void => useUiStore.getState().setUserCard(null)
  const accounts = useAccountsStore((s) => s.accounts)
  const account = accounts.find((a) => a.id === target.accountId) ?? accounts[0]
  const isMod = canModerate(account, target.channel, target.channelId)
  const isBroadcasterAccount = account && account.login.toLowerCase() === target.channel.toLowerCase()
  const messages = useChatStore((s) => s.messages[target.channel]) ?? []
  const [info, setInfo] = useState<HelixUser | null>(null)
  const [followedAt, setFollowedAt] = useState<string | null | undefined>(undefined)
  const [subInfo, setSubInfo] = useState<SubInfo | null | undefined>(undefined)
  const ref = useRef<HTMLDivElement>(null)

  const userMessages = useMemo(
    () => messages.filter((m) => m.userId === target.userId && !m.system).slice(-30).reverse(),
    [messages, target.userId]
  )

  useEffect(() => {
    if (account) getUsers(account, { ids: [target.userId] }).then(([u]) => u && setInfo(u))
  }, [account, target.userId])

  useEffect(() => {
    if (!account || !isMod) return
    getFollowDate(account, target.channelId, target.userId).then(setFollowedAt)
  }, [account, isMod, target.channelId, target.userId])

  useEffect(() => {
    if (!account || !isBroadcasterAccount) return
    getSubInfo(account, target.channelId, target.userId).then(setSubInfo)
  }, [account, isBroadcasterAccount, target.channelId, target.userId])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [])

  const x = Math.min(target.x, window.innerWidth - 336)
  const y = Math.min(target.y, window.innerHeight - 360)
  const toast = useUiStore.getState().toast

  const act = async (fn: () => Promise<{ ok: boolean; json: unknown }>, label: string): Promise<void> => {
    const res = await fn()
    toast(
      res.ok ? label : ((res.json as { message?: string })?.message ?? t('mod.actionFail')),
      res.ok ? 'ok' : 'error'
    )
  }

  return (
    <div className="usercard" ref={ref} style={{ left: x, top: y }}>
      <div className="uc-head">
        {info?.profile_image_url && <img src={info.profile_image_url} alt="" />}
        <div>
          <div className="uc-name" style={{ color: target.color }}>
            {target.displayName}
          </div>
          <div className="uc-sub">
            {target.login}
            {info && (
              <>
                {' · '}
                {t('user.created')}: {new Date(info.created_at).toLocaleDateString()}
              </>
            )}
          </div>
          {target.badges.length > 0 && (
            <div className="uc-badges">
              {target.badges.map((b) => {
                const url = lookupBadgeUrl(target.channel, b.setId, b.version)
                return url ? <img key={b.setId} src={url} alt={b.setId} title={b.setId} /> : null
              })}
            </div>
          )}
          <div className="uc-sub">
            {isMod && followedAt !== undefined && (
              <span>
                {followedAt ? `👣 ${t('user.followedSince')} ${new Date(followedAt).toLocaleDateString()}` : `👣 ${t('user.notFollowing')}`}
              </span>
            )}
            {isBroadcasterAccount && subInfo !== undefined && (
              <span>
                {' · '}
                {subInfo ? `⭐ ${t('user.subscribed')} (T${subInfo.tier[0]}${subInfo.is_gift ? ' 🎁' : ''})` : `${t('user.notSubscribed')}`}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="uc-actions">
        <button
          onClick={() => {
            navigator.clipboard.writeText(target.login)
          }}
        >
          {t('user.copyName')}
        </button>
        <button onClick={() => window.sticki.openExternal(`https://www.twitch.tv/${target.login}`)}>
          ↗ {t('user.openChannel')}
        </button>
      </div>
      {isMod && account && (
        <div className="uc-actions">
          {TIMEOUTS.map((s) => (
            <button
              key={s}
              onClick={() =>
                act(() => banUser(account, target.channelId, target.userId, s), `⏱ ${formatDuration(s)}`)
              }
            >
              ⏱ {formatDuration(s)}
            </button>
          ))}
          <button
            className="danger"
            onClick={() => act(() => banUser(account, target.channelId, target.userId), '🔨')}
          >
            🔨 {t('mod.ban')}
          </button>
          <button onClick={() => act(() => unbanUser(account, target.channelId, target.userId), '✅')}>
            {t('mod.unban')}
          </button>
          <button
            onClick={() =>
              act(() => warnUser(account, target.channelId, target.userId, 'Warning'), '⚠️')
            }
          >
            ⚠️ {t('mod.warn')}
          </button>
        </div>
      )}
      <div className="uc-msgs">
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('user.messagesHere')}</div>
        {userMessages.length === 0 && <div>{t('user.noMessages')}</div>}
        {userMessages.map((m) => (
          <div key={m.id} className="m">
            {new Date(m.timestamp).toLocaleTimeString()} — {m.text}
          </div>
        ))}
      </div>
    </div>
  )
}
