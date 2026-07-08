import { memo, useMemo, useRef, useState } from 'react'
import { Account, ChatMessage, MOD_ONLY_TYPES, Settings } from '../types'
import { tokenizeMessage, Token, fallbackColor, ensureReadable, hexToRgba, formatDuration } from '../lib/tokenize'
import { lookupBadgeUrl, lookupEmote } from '../store/emotes'
import { lookupUserColor } from '../store/chat'
import { highlightRuleMatches } from '../lib/highlight'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { runModButton } from '../services/modActions'
import { banUser, deleteChatMessage } from '../lib/helix'
import BtnIcon from './BtnIcon'
import { ReplyTarget, InsertEventDetail } from './InputBox'
import { JumpEventDetail } from './MessageList'
import { useT } from '../i18n'

interface Props {
  msg: ChatMessage
  index: number
  paneId: string
  account: Account | undefined
  channelId: string
  isMod: boolean
  paneAccountId: string | null
  settings: Settings
  emoteVersion: number
  onReply: (target: ReplyTarget) => void
  flash: boolean
}

function formatTime(ts: number, withSeconds: boolean): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (!withSeconds) return `${hh}:${mm}`
  return `${hh}:${mm}:${String(d.getSeconds()).padStart(2, '0')}`
}

function TokenView({ token, paneId }: { token: Token; paneId: string }): React.JSX.Element {
  switch (token.kind) {
    case 'text':
      return <>{token.text}</>
    case 'link':
      return (
        <a
          href={token.url}
          onClick={(e) => {
            e.preventDefault()
            window.sticki.openExternal(token.url)
          }}
        >
          {token.url}
        </a>
      )
    case 'mention': {
      const login = token.name.replace(/^@/, '').replace(/[^\w]+$/, '')
      const insertMention = (e: React.MouseEvent): void => {
        e.preventDefault()
        window.dispatchEvent(
          new CustomEvent<InsertEventDetail>('sticki:insert', { detail: { paneId, text: `@${login} ` } })
        )
      }
      return (
        <span
          className="mention-token"
          style={{ color: token.color }}
          title={login}
          onClick={() => {
            navigator.clipboard.writeText(login)
          }}
          onContextMenu={insertMention}
        >
          {token.name}
        </span>
      )
    }
    case 'emote': {
      const insert = (e: React.MouseEvent): void => {
        e.preventDefault()
        window.dispatchEvent(
          new CustomEvent<InsertEventDetail>('sticki:insert', {
            detail: { paneId, text: `${token.emote.code} ` }
          })
        )
      }
      return (
        <span
          className="emote-wrap"
          title={[token.emote, ...token.overlays].map((e) => e.code).join(' ')}
          onContextMenu={insert}
          onMouseEnter={(e) =>
            useUiStore
              .getState()
              .setEmotePreview({ url: token.emote.url, code: token.emote.code, x: e.clientX, y: e.clientY })
          }
          onMouseMove={(e) => {
            const cur = useUiStore.getState().emotePreview
            if (cur) useUiStore.getState().setEmotePreview({ ...cur, x: e.clientX, y: e.clientY })
          }}
          onMouseLeave={() => useUiStore.getState().setEmotePreview(null)}
        >
          <img src={token.emote.url} alt={token.emote.code} loading="lazy" />
          {token.overlays.map((o, i) => (
            <img key={i} src={o.url} alt={o.code} loading="lazy" />
          ))}
        </span>
      )
    }
  }
}

// swipe zones (px): 40‑90 delete, 90‑342 timeout tiers, beyond — ban
const SWIPE_DELETE_START = 40
const SWIPE_TIMEOUT_START = 90
const SWIPE_TIER_WIDTH = 42
const SWIPE_TIERS = [60, 300, 600, 1800, 3600, 86400]
const SWIPE_BAN_START = SWIPE_TIMEOUT_START + SWIPE_TIER_WIDTH * SWIPE_TIERS.length

const ANNOUNCE_COLORS: Record<string, string> = {
  primary: '#9147ff',
  blue: '#1e90ff',
  green: '#2ecc71',
  orange: '#ff8c1a',
  purple: '#a970ff'
}

interface SwipeAction {
  kind: 'delete' | 'timeout' | 'ban'
  seconds?: number
  label: string
  color: string
}

function swipeActionFor(
  dx: number,
  labels: { delete: string; ban: string },
  deleteOnly = false
): SwipeAction | null {
  if (dx < SWIPE_DELETE_START) return null
  if (deleteOnly || dx < SWIPE_TIMEOUT_START)
    return { kind: 'delete', label: `🗑 ${labels.delete}`, color: 'var(--warning)' }
  if (dx < SWIPE_BAN_START) {
    const tier = Math.min(SWIPE_TIERS.length - 1, Math.floor((dx - SWIPE_TIMEOUT_START) / SWIPE_TIER_WIDTH))
    const secs = SWIPE_TIERS[tier]
    return { kind: 'timeout', seconds: secs, label: `⏱ ${formatDuration(secs)}`, color: 'var(--accent-strong)' }
  }
  return { kind: 'ban', label: `🔨 ${labels.ban}`, color: 'var(--danger)' }
}

function MessageViewInner({
  msg,
  index,
  paneId,
  account,
  channelId,
  isMod,
  paneAccountId,
  settings,
  emoteVersion,
  onReply,
  flash
}: Props): React.JSX.Element {
  const t = useT()
  const modButtons = useSettingsStore((s) => s.modButtons)
  const highlightRules = useSettingsStore((s) => s.highlightRules)
  const [dragX, setDragX] = useState(0)
  const draggingRef = useRef(false)

  const tokens = useMemo(
    () =>
      msg.system === 'info'
        ? []
        : tokenizeMessage(
            msg,
            lookupEmote(msg.channel),
            (login) => lookupUserColor(msg.channel, login),
            settings.theme === 'dark'
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [msg, emoteVersion, settings.theme]
  )

  const isMention = settings.highlightMentions && !!msg.isMention

  const customBg = useMemo(() => {
    if (isMention || msg.system) return undefined
    const rule = highlightRules.find((r) => highlightRuleMatches(msg, r, settings.caseSensitiveNicks))
    return rule ? hexToRgba(rule.color, rule.opacity) : undefined
  }, [highlightRules, msg, isMention, settings.caseSensitiveNicks])

  if (msg.system === 'info') {
    return (
      <div className="msg">
        {settings.showTimestamps && <span className="ts">{formatTime(msg.timestamp, settings.timestampSeconds)}</span>}
        <span className="sysmsg">{msg.systemText}</span>
      </div>
    )
  }

  const dark = settings.theme === 'dark'
  const color = ensureReadable(msg.color || fallbackColor(msg.login), dark)
  const classes = ['msg']
  if (settings.alternatingBackground && index % 2 === 1) classes.push('alt')
  if (isMention) classes.push('mention')
  if (msg.isFirstMsg) classes.push('first-msg')
  else if (msg.isFirstInSession) classes.push('first-in-session')
  if (msg.deleted) classes.push('deleted')
  if (msg.historical) classes.push('historical')
  if (flash) classes.push('flash')
  if (msg.system === 'usernotice') classes.push('usernotice')
  if (dragX > 0) classes.push('swiping')

  const canAct = !!account && !!msg.userId
  // moderators/broadcasters can't be timed out or banned by another mod — only their messages can be deleted
  const targetIsProtected = msg.badges.some(
    (b) => b.setId === 'moderator' || b.setId === 'lead_moderator' || b.setId === 'broadcaster'
  )
  const visibleButtons = modButtons
    .filter((b) => b.scope === 'message')
    .filter((b) => {
      const modOnly = MOD_ONLY_TYPES.has(b.type)
      if (modOnly && !isMod) return false
      if (modOnly && targetIsProtected && b.type !== 'delete') return false
      return true
    })
  const swipeEnabled = isMod && canAct && !msg.deleted
  const toast = useUiStore.getState().toast

  const openUserCard = (e: React.MouseEvent): void => {
    useUiStore.getState().setUserCard({
      channel: msg.channel,
      channelId,
      userId: msg.userId,
      login: msg.login,
      displayName: msg.displayName,
      color,
      badges: msg.badges,
      accountId: paneAccountId,
      x: e.clientX,
      y: e.clientY
    })
  }

  const swipeLabels = { delete: t('swipe.delete'), ban: t('swipe.ban') }

  const executeSwipe = async (dx: number): Promise<void> => {
    const action = swipeActionFor(dx, swipeLabels, targetIsProtected)
    if (!action || !account) return
    const res =
      action.kind === 'delete'
        ? await deleteChatMessage(account, channelId, msg.id)
        : await banUser(account, channelId, msg.userId, action.seconds)
    if (res.ok) toast(`${action.label} — ${msg.login}`, 'ok')
    else toast((res.json as { message?: string })?.message ?? t('mod.actionFail'), 'error')
  }

  const startSwipe = (e: React.PointerEvent, immediate: boolean): void => {
    if (!swipeEnabled || e.button !== 0) return
    if (!immediate) {
      const target = e.target as HTMLElement
      if (target.closest('button, a, input, textarea, select, .hover-actions, .nick, .swipe-grip')) return
    } else {
      e.preventDefault()
    }
    const start = { x: e.clientX, y: e.clientY }
    let active = immediate
    if (immediate) {
      draggingRef.current = true
      document.getSelection()?.removeAllRanges()
    }
    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      if (!active) {
        if (dx > 30 && Math.abs(dx) > Math.abs(dy) * 2) {
          active = true
          draggingRef.current = true
          document.getSelection()?.removeAllRanges()
        } else if (Math.abs(dy) > 24 || dx < -24) {
          cleanup()
          return
        }
      }
      const cap = targetIsProtected ? SWIPE_TIMEOUT_START - 1 : SWIPE_BAN_START + 40
      if (active) setDragX(Math.max(0, Math.min(dx, cap)))
    }
    const onUp = (ev: PointerEvent): void => {
      cleanup()
      if (active) {
        draggingRef.current = false
        executeSwipe(ev.clientX - start.x)
      }
      setDragX(0)
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onPointerDown = (e: React.PointerEvent): void => startSwipe(e, false)

  const insertNick = (e: React.MouseEvent): void => {
    e.preventDefault()
    window.dispatchEvent(
      new CustomEvent<{ paneId: string; text: string }>('sticki:insert', {
        detail: { paneId, text: `@${msg.login} ` }
      })
    )
  }

  const swipeAction = dragX > 0 ? swipeActionFor(dragX, swipeLabels, targetIsProtected) : null

  const jumpToParent = (): void => {
    if (!msg.replyParent?.msgId) return
    window.dispatchEvent(
      new CustomEvent<JumpEventDetail>('sticki:jump', {
        detail: { channel: msg.channel, msgId: msg.replyParent.msgId }
      })
    )
  }

  return (
    <div className="msg-outer">
      {swipeAction && (
        <div className="swipe-overlay" style={{ background: swipeAction.color }}>
          {swipeAction.label}
        </div>
      )}
      <div
        className={classes.join(' ')}
        style={
          {
            background: msg.announceColor ? undefined : customBg,
            '--announce-accent': msg.announceColor ? ANNOUNCE_COLORS[msg.announceColor] : undefined,
            transform: dragX > 0 ? `translateX(${dragX}px)` : undefined
          } as React.CSSProperties
        }
        onPointerDown={onPointerDown}
      >
        {swipeEnabled && (
          <span
            className="swipe-grip"
            title={t('swipe.hint')}
            onPointerDown={(e) => startSwipe(e, true)}
          >
            ⠿
          </span>
        )}
        {msg.system === 'usernotice' && msg.systemText && (
          <span className="usernotice-tag">{msg.announceColor ? '📢' : '★'} {msg.systemText}</span>
        )}
        {msg.replyParent && (
          <span
            className={`reply-ref ${msg.replyParent.msgId ? 'clickable' : ''}`}
            title={`${msg.replyParent.displayName}: ${msg.replyParent.text}\n${msg.replyParent.msgId ? t('reply.jump') : ''}`}
            onClick={jumpToParent}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              window.dispatchEvent(
                new CustomEvent<InsertEventDetail>('sticki:insert', {
                  detail: { paneId, text: `@${msg.replyParent!.login} ` }
                })
              )
            }}
          >
            ↩ @{msg.replyParent.displayName}: {msg.replyParent.text}
          </span>
        )}
        {settings.showTimestamps && (
          <span className="ts">{formatTime(msg.timestamp, settings.timestampSeconds)}</span>
        )}
        {msg.badges.map((b) => {
          const url = lookupBadgeUrl(msg.channel, b.setId, b.version)
          return url ? <img key={`${b.setId}/${b.version}`} className="badge" src={url} alt={b.setId} draggable={false} /> : null
        })}
        <span className="nick" style={{ color }} onClick={openUserCard} onContextMenu={insertNick}>
          {msg.displayName}
          {msg.displayName.toLowerCase() !== msg.login ? ` (${msg.login})` : ''}
        </span>
        {msg.isAction ? ' ' : ': '}
        <span className="msg-text" style={msg.isAction ? { color } : undefined}>
          {tokens.map((tk, i) => (
            <TokenView key={i} token={tk} paneId={paneId} />
          ))}
        </span>

        {canAct && (
          <span className="hover-actions">
            <button
              title={t('reply.action')}
              onClick={() =>
                onReply({ msgId: msg.id, login: msg.login, displayName: msg.displayName, text: msg.text })
              }
            >
              ↩
            </button>
            {visibleButtons.map((btn) => (
              <button
                key={btn.id}
                title={btn.label}
                onClick={() =>
                  runModButton(btn, {
                    account: account!,
                    channel: msg.channel,
                    channelId,
                    paneId,
                    targetUserId: msg.userId,
                    targetLogin: msg.login,
                    targetMsgId: msg.id
                  })
                }
              >
                <BtnIcon icon={btn.icon} />
                {!btn.icon && btn.label}
              </button>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}

const MessageView = memo(MessageViewInner)
export default MessageView
