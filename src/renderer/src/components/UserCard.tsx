import { useEffect, useMemo, useRef, useState } from 'react'
import { useUiStore, UserCardTarget } from '../store/ui'
import { useChatStore } from '../store/chat'
import { useAccountsStore } from '../store/accounts'
import { useSettingsStore } from '../store/settings'
import { lookupBadgeUrl, lookupEmote } from '../store/emotes'
import { canModerate } from '../services/accountService'
import { getFollowDate, getSubInfo, getUsers, HelixUser, SubInfo } from '../lib/helix'
import { banUser, unbanUser, warnUser } from '../lib/helix'
import { useT } from '../i18n'
import { formatDuration, tokenizeMessage } from '../lib/tokenize'
import EmojiGlyph from './EmojiGlyph'

const TIMEOUTS = [60, 600, 3600, 86400]

export default function UserCard({
  target,
  standalone,
  presetMessages
}: {
  target: UserCardTarget
  standalone?: boolean
  presetMessages?: { id: string; timestamp: number; text: string; emotesTag?: string }[]
}): React.JSX.Element {
  const t = useT()
  const close = (): void => {
    if (standalone) window.close()
    else useUiStore.getState().setUserCard(null)
  }
  const accounts = useAccountsStore((s) => s.accounts)
  const account = accounts.find((a) => a.id === target.accountId) ?? accounts[0]
  const isMod = canModerate(account, target.channel, target.channelId)
  const isBroadcasterAccount = account && account.login.toLowerCase() === target.channel.toLowerCase()
  const messages = useChatStore((s) => s.messages[target.channel]) ?? []
  const [info, setInfo] = useState<HelixUser | null>(null)
  const [followedAt, setFollowedAt] = useState<string | null | undefined>(undefined)
  const [subInfo, setSubInfo] = useState<SubInfo | null | undefined>(undefined)
  const ref = useRef<HTMLDivElement>(null)

  // like the chat itself: every buffered message, oldest → newest, pinned to the bottom
  const userMessages = useMemo(
    () => presetMessages ?? messages.filter((m) => m.userId === target.userId && !m.system),
    [messages, target.userId, presetMessages]
  )

  // keep the list glued to the bottom as new messages arrive
  const msgsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = msgsRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [userMessages.length])

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
      if (!standalone && ref.current && !ref.current.contains(e.target as Node)) close()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standalone])

  // draggable: keep an offset from the initial anchor, clamped inside the window using the
  // card's REAL height (a fixed guess let tall cards stick out at the bottom of the chat)
  const [drag, setDrag] = useState({ dx: 0, dy: 0 })
  const [cardH, setCardH] = useState(420)
  useEffect(() => {
    if (ref.current) setCardH(ref.current.offsetHeight)
  }, [info, followedAt, subInfo, userMessages.length])
  const x = Math.max(4, Math.min(target.x + drag.dx, window.innerWidth - 340))
  const y = Math.max(4, Math.min(target.y + drag.dy, window.innerHeight - cardH - 8))
  const toast = useUiStore.getState().toast

  const startDrag = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('button, a, input, img')) return
    e.preventDefault()
    const start = { x: e.clientX - drag.dx, y: e.clientY - drag.dy }
    const onMove = (ev: PointerEvent): void =>
      setDrag({ dx: ev.clientX - start.x, dy: ev.clientY - start.y })
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const emoteLookup = lookupEmote(target.channel)

  const act = async (fn: () => Promise<{ ok: boolean; json: unknown }>, label: string): Promise<void> => {
    const res = await fn()
    toast(
      res.ok ? label : ((res.json as { message?: string })?.message ?? t('mod.actionFail')),
      res.ok ? 'ok' : 'error'
    )
  }

  const ucFontSize = useSettingsStore((s) => s.settings.usercardFontSize)
  const setSettings = useSettingsStore((s) => s.setSettings)

  return (
    <div
      className={`usercard ${standalone ? 'usercard-standalone' : ''}`}
      ref={ref}
      style={standalone ? { fontSize: ucFontSize } : { left: x, top: y }}
    >
      {standalone && (
        <div className="uc-zoom">
          <button onClick={() => setSettings({ usercardFontSize: Math.max(10, ucFontSize - 1) })}>A−</button>
          <button onClick={() => setSettings({ usercardFontSize: Math.min(28, ucFontSize + 1) })}>A+</button>
        </div>
      )}
      <div className="uc-head" onPointerDown={standalone ? undefined : startDrag} style={{ cursor: standalone ? undefined : 'grab' }}>
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
        <button
          title={t('user.viewercard')}
          onClick={() =>
            window.sticki.openExternal(
              `https://www.twitch.tv/popout/${target.channel}/viewercard/${target.login}`
            )
          }
        >
          🗂 {t('user.viewercard')}
        </button>
        {!standalone && (
          <button
            title={t('user.openWindow')}
            onClick={() => {
              const payload = {
                target,
                messages: userMessages.map((m) => ({
                  id: m.id,
                  timestamp: m.timestamp,
                  text: m.text,
                  emotesTag: (m as { emotesTag?: string }).emotesTag
                }))
              }
              window.sticki.openUserCardWindow(`usercard=${encodeURIComponent(JSON.stringify(payload))}`)
              close()
            }}
          >
            ⧉
          </button>
        )}
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
      <div className="uc-msgs" ref={msgsRef}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('user.messagesHere')}</div>
        {userMessages.length === 0 && <div>{t('user.noMessages')}</div>}
        {userMessages.map((m) => {
          const full = m as Partial<import('../types').ChatMessage>
          return (
            <div key={m.id} className="m">
              <span className="uc-ts">{new Date(m.timestamp).toLocaleTimeString()}</span>{' '}
              {full.replyParent && (
                <span className="uc-reply" title={`${full.replyParent.displayName}: ${full.replyParent.text}`}>
                  ↩ @{full.replyParent.displayName}
                </span>
              )}
              <span className="uc-nick" style={{ color: target.color }}>
                {target.displayName}
              </span>
              {': '}
              {tokenizeMessage(m, emoteLookup).map((tk, i) => {
                if (tk.kind === 'emote')
                  return <img key={i} className="uc-emote" src={tk.emote.url} alt={tk.emote.code} loading="lazy" />
                if (tk.kind === 'emoji') return <EmojiGlyph key={i} char={tk.char} />
                if (tk.kind === 'link') return <span key={i}>{tk.label}</span>
                if (tk.kind === 'mention')
                  return (
                    <span key={i} style={{ color: tk.color, fontWeight: 600 }}>
                      {tk.name}
                    </span>
                  )
                return <span key={i}>{tk.text}</span>
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
