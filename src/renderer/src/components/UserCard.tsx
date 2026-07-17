import { useEffect, useMemo, useRef, useState } from 'react'
import { getWatchStreak } from '../lib/watchStreaks'
import { useUiStore, UserCardTarget } from '../store/ui'
import { useChatStore } from '../store/chat'
import { useAccountsStore } from '../store/accounts'
import { useSettingsStore } from '../store/settings'
import { lookupBadgeUrl } from '../store/emotes'
import { canModerate } from '../services/accountService'
import { getFollowDate, getSubInfo, getUsers, HelixUser, SubInfo } from '../lib/helix'
import { banUser, unbanUser, warnUser } from '../lib/helix'
import { useT } from '../i18n'
import { formatDuration } from '../lib/tokenize'
import RichText from './RichText'
import { PinButton } from './EmotePicker'
import { localizeApiError } from '../lib/apiErrors'

const TIMEOUTS = [60, 600, 3600, 86400]

/** a UserCard row: a full ChatMessage or a snapshot of one — id/timestamp always present */
type UcMsg = Partial<import('../types').ChatMessage> & { id: string; timestamp: number }

export default function UserCard({
  target,
  standalone,
  presetMessages
}: {
  target: UserCardTarget
  standalone?: boolean
  presetMessages?: UcMsg[]
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
  const [chatRules, setChatRules] = useState<string[]>([])
  const [showBio, setShowBio] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const isChannelOwner = target.userId === target.channelId

  // the broadcaster's own card: fetch the channel's chat rules (the list shown to first-time
  // chatters) — only available via GQL, falls back to the channel bio when empty
  useEffect(() => {
    if (!isChannelOwner) return
    import('../lib/twitchGql').then(({ fetchChatRules }) =>
      fetchChatRules(target.login).then(setChatRules)
    )
  }, [isChannelOwner, target.login])

  // like the chat itself: every buffered message, oldest → newest, pinned to the bottom;
  // moderation lines that TARGET this user (bans/timeouts/deletes with the acting mod) too
  const userMessages = useMemo(() => {
    const live = messages.filter(
      (m) =>
        (m.userId === target.userId && !m.system) ||
        (m.system && m.modTargetUserId === target.userId)
    )
    // standalone window: seed with the snapshot the panel passed (its own fresh reader only
    // backfills recent-messages, so without the seed it shows fewer/no lines than the panel),
    // then merge live arrivals on top, deduped by id
    if (!presetMessages) return live as UcMsg[]
    const byId = new Map<string, UcMsg>()
    for (const m of presetMessages) byId.set(m.id, m)
    for (const m of live) byId.set(m.id, m)
    return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp)
  }, [messages, target.userId, presetMessages])

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

  const act = async (fn: () => Promise<{ ok: boolean; json: unknown }>, label: string): Promise<void> => {
    const res = await fn()
    toast(
      res.ok ? label : (localizeApiError((res.json as { message?: string })?.message ?? '') || t('mod.actionFail')),
      res.ok ? 'ok' : 'error'
    )
  }

  const ucFontSize = useSettingsStore((s) => s.settings.usercardFontSize)
  const setSettings = useSettingsStore((s) => s.setSettings)
  const mutedUsers = useSettingsStore((s) => s.settings.mutedUsers)
  const mutedEntry = mutedUsers.find((u) => u.login === target.login)

  const toggleMuted = (): void => {
    setSettings({
      mutedUsers: mutedEntry
        ? mutedUsers.filter((u) => u.login !== target.login)
        : [...mutedUsers, { login: target.login, mode: 'dim' as const, opacity: 0.3 }]
    })
  }

  return (
    <div
      className={`usercard ${standalone ? 'usercard-standalone' : ''}`}
      ref={ref}
      style={standalone ? { fontSize: ucFontSize } : { left: x, top: y }}
    >
      {standalone && (
        <div className="uc-zoom">
          <PinButton settingKey="usercardPinned" />
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
            {(() => {
              const streak = getWatchStreak(target.channel, target.login)
              return streak !== null ? <span>{`🔥 ${t('user.watchStreak', { n: String(streak) })} · `}</span> : null
            })()}
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
      {/* broadcaster's card: chat rules (first-time-chatter list) and/or the channel bio, with
          a toggle to switch between them when both exist */}
      {isChannelOwner &&
        (() => {
          const hasRules = chatRules.length > 0
          const hasBio = !!info?.description
          if (!hasRules && !hasBio) return null
          // default to rules when we have them; the toggle flips to the bio
          const showRules = hasRules && !showBio
          return (
            <div className="uc-rules">
              <div className="uc-rules-title">
                <span>{showRules ? `📜 ${t('user.channelRules')}` : `ℹ️ ${t('user.channelAbout')}`}</span>
                {hasRules && hasBio && (
                  <button className="ghost uc-rules-toggle" onClick={() => setShowBio((v) => !v)}>
                    {showRules ? t('user.showAbout') : t('user.showRules')}
                  </button>
                )}
              </div>
              {showRules ? (
                <ul className="uc-rules-list">
                  {chatRules.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              ) : (
                <div className="uc-rules-body">{info?.description}</div>
              )}
            </div>
          )
        })()}
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
        <button
          title={t('muted.hint')}
          className={mutedEntry ? 'primary' : ''}
          onClick={toggleMuted}
        >
          {mutedEntry ? `🔊 ${t('user.unmute')}` : `🚫 ${t('user.mute')}`}
        </button>
        {!standalone && (
          <button
            title={t('user.openWindow')}
            onClick={() => {
              // pass the full message objects so the window renders badges/system/reply lines
              // and has the same history the panel is showing right now
              const payload = { target, messages: userMessages }
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
          // moderation lines about this user (who banned/timed out/deleted)
          if (full.system) {
            return (
              <div key={m.id} className="m uc-modact">
                <span className="uc-ts">{new Date(m.timestamp).toLocaleTimeString()}</span>{' '}
                <span className="sysmsg">{full.systemText}</span>
              </div>
            )
          }
          return (
            <div key={m.id} className={`m ${full.deleted ? 'uc-deleted' : ''}`}>
              <span className="uc-ts">{new Date(m.timestamp).toLocaleTimeString()}</span>{' '}
              {full.replyParent && (
                <span className="uc-reply" title={`${full.replyParent.displayName}: ${full.replyParent.text}`}>
                  ↩ @{full.replyParent.displayName}
                </span>
              )}
              {(full.badges ?? []).map((b) => {
                const url = lookupBadgeUrl(target.channel, b.setId, b.version)
                return url ? (
                  <img key={`${b.setId}/${b.version}`} className="badge" src={url} alt={b.setId} draggable={false} />
                ) : null
              })}
              <span className="uc-nick" style={{ color: target.color }}>
                {target.displayName}
              </span>
              {': '}
              {full.deleted && <span className="uc-deleted-tag">🗑 {t('misc.deletedMessage')} </span>}
              <RichText msg={{ text: m.text ?? '', emotesTag: full.emotesTag, channel: target.channel }} />

            </div>
          )
        })}
      </div>
    </div>
  )
}
