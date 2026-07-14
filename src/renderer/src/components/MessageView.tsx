import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Account, ChatMessage, MOD_ONLY_TYPES, Settings } from '../types'
import { tokenizeMessage, Token, fallbackColor, ensureReadable, hexToRgba, formatDuration } from '../lib/tokenize'
import { lookupBadgeUrl, lookupEmote, lookupCheermote } from '../store/emotes'
import { lookupUserColor, useChatStore } from '../store/chat'
import { useAccountsStore } from '../store/accounts'
import { highlightRuleMatches } from '../lib/highlight'
import { openUserCard as openCard } from '../lib/openUserCard'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { runModButton } from '../services/modActions'
import { banUser, deleteChatMessage } from '../lib/helix'
import BtnIcon from './BtnIcon'
import EmojiGlyph from './EmojiGlyph'
import { ReplyTarget, InsertEventDetail } from './InputBox'
import { JumpEventDetail } from './MessageList'
import { useT } from '../i18n'
import { localizeApiError } from '../lib/apiErrors'
import { useSevenTvColors, ensureSevenTvCosmetic } from '../lib/seventvCosmetics'

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

/** RMB inserts into the input; Ctrl+RMB sends the token to chat immediately */
function tokenContextHandler(paneId: string, text: string) {
  return (e: React.MouseEvent): void => {
    e.preventDefault()
    window.dispatchEvent(
      new CustomEvent<InsertEventDetail>(e.ctrlKey ? 'sticki:send' : 'sticki:insert', {
        detail: { paneId, text }
      })
    )
  }
}

function TokenView({ token, paneId }: { token: Token; paneId: string }): React.JSX.Element {
  switch (token.kind) {
    case 'text':
      return <>{token.text}</>
    case 'command': {
      // "!command": right-click puts it into the input, Ctrl+right-click sends it
      return (
        <span className="command-token" title={token.text} onContextMenu={tokenContextHandler(paneId, `${token.text} `)}>
          {token.text}
        </span>
      )
    }
    case 'link':
      return (
        <a
          href={token.url}
          onClick={(e) => {
            e.preventDefault()
            window.sticki.openExternal(token.url)
          }}
        >
          {token.label}
        </a>
      )
    case 'mention': {
      const login = token.name.replace(/^@/, '').replace(/[^\w]+$/, '')
      return (
        <span
          className="mention-token"
          style={{ color: token.color }}
          title={login}
          onClick={(e) => {
            window.dispatchEvent(
              new CustomEvent('sticki:opencard', {
                detail: { paneId, login, x: e.clientX, y: e.clientY }
              })
            )
          }}
          onContextMenu={tokenContextHandler(paneId, `@${login} `)}
        >
          {token.name}
        </span>
      )
    }
    case 'emote': {
      return (
        <span
          className="emote-wrap"
          title={[token.emote, ...token.overlays].map((e) => e.code).join(' ')}
          onContextMenu={tokenContextHandler(paneId, `${token.emote.code} `)}
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
          {/* NOT lazy: lazy images loaded mid-scroll, reflowing text and jolting the virtualized
              list. Eager load happens while the row is still in the overscan zone. */}
          <img src={token.emote.url} alt={token.emote.code} />
          {token.overlays.map((o, i) => (
            <img key={i} src={o.url} alt={o.code} />
          ))}
        </span>
      )
    }
    case 'emoji': {
      return (
        <span className="emoji-token" title={token.char} onContextMenu={tokenContextHandler(paneId, `${token.char} `)}>
          <EmojiGlyph char={token.char} />
        </span>
      )
    }
    case 'cheer':
      return (
        <span className="cheer-token" title={`${token.bits} bits`}>
          {token.url && <img src={token.url} alt="" loading="lazy" />}
          <span className="cheer-amount" style={{ color: token.color }}>
            {token.bits}
          </span>
        </span>
      )
  }
}

// Braille art is drawn for a specific number of cells per line, but the count varies by
// generator (28–40+). Measure one cell's width in OUR font, wrap at an adjustable column
// count (slider on the art itself), and remember the last pick as the new default.
let brailleCellWidth: number | null = null
function getBrailleCellWidth(): number {
  if (brailleCellWidth !== null) return brailleCellWidth
  try {
    const span = document.createElement('span')
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:13px;line-height:1'
    span.textContent = '⣿'.repeat(30)
    document.body.appendChild(span)
    brailleCellWidth = (span.getBoundingClientRect().width || 330) / 30
    span.remove()
  } catch {
    brailleCellWidth = 11
  }
  return brailleCellWidth
}
let lastArtCols = 30

/**
 * Twitch replaces the newlines of pasted braille art with SPACES, while the art itself uses
 * the braille blank (U+2800) inside lines. So space-separated segments of consistent length
 * are almost certainly the original lines — rebuild them. Returns null when unsure.
 */
function recoverArtLines(text: string): string[] | null {
  const segs = text.split(' ').filter((s) => s.length > 0)
  if (segs.length < 4) return null
  const lens = segs.map((s) => [...s].length).sort((a, b) => a - b)
  const median = lens[Math.floor(lens.length / 2)]
  if (median < 8) return null
  const consistent = segs.filter((s) => Math.abs([...s].length - median) <= 2).length
  return consistent / segs.length >= 0.7 ? segs : null
}

// swipe zones (px): 40‑90 delete, then one timeout tier every SWIPE_TIER_WIDTH px, beyond — ban
const SWIPE_DELETE_START = 40
const SWIPE_TIMEOUT_START = 90
const SWIPE_TIER_WIDTH = 42
const banStartFor = (tiers: number[]): number => SWIPE_TIMEOUT_START + SWIPE_TIER_WIDTH * tiers.length

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
  tiers: number[],
  deleteOnly = false
): SwipeAction | null {
  if (dx < SWIPE_DELETE_START) return null
  if (deleteOnly || dx < SWIPE_TIMEOUT_START)
    return { kind: 'delete', label: `🗑 ${labels.delete}`, color: 'var(--warning)' }
  if (dx < banStartFor(tiers)) {
    const tier = Math.min(tiers.length - 1, Math.floor((dx - SWIPE_TIMEOUT_START) / SWIPE_TIER_WIDTH))
    const secs = tiers[tier]
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
  const channelAccent = useChatStore((s) => s.channelAccents[msg.channel])
  const [dragX, setDragX] = useState(0)
  const draggingRef = useRef(false)

  const tokens = useMemo(() => {
    if (msg.system === 'info') return []
    const toks = tokenizeMessage(
      msg,
      lookupEmote(msg.channel),
      (login) => lookupUserColor(msg.channel, login),
      settings.theme === 'dark',
      msg.bits ? lookupCheermote(msg.channel) : undefined
    )
    // Twitch prefixes reply bodies with "@nick " — the nick already shows greyed on the
    // reply-ref line above, so drop the duplicate leading @mention (and its trailing space)
    const parentLogin = msg.replyParent?.login?.toLowerCase()
    const first = toks[0]
    if (parentLogin && first?.kind === 'mention') {
      if (first.name.slice(1).replace(/[^\w]+$/, '').toLowerCase() === parentLogin) {
        toks.shift()
        const next = toks[0]
        if (next?.kind === 'text') {
          if (next.text.trimStart() === '') toks.shift()
          else toks[0] = { kind: 'text', text: next.text.replace(/^\s+/, '') }
        }
      }
    }
    return toks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg, emoteVersion, settings.theme])

  // optional 7TV cosmetic nick color/paint: subscribe so the nick restyles when the fetch lands
  const stvCosmetic = useSevenTvColors((s) =>
    settings.sevenTvNickColors && msg.userId ? s.cosmetics[msg.userId] : undefined
  )
  useEffect(() => {
    if (settings.sevenTvNickColors && !msg.system) ensureSevenTvCosmetic(msg.userId)
  }, [settings.sevenTvNickColors, msg.userId, msg.system])

  const isMention = settings.highlightMentions && !!msg.isMention

  const customBg = useMemo(() => {
    if (isMention) return undefined
    const myAccountIds = useAccountsStore.getState().accounts.map((a) => a.id)
    const ctx = { caseSensitiveNicks: settings.caseSensitiveNicks, myAccountIds }
    const rule = highlightRules.find((r) => highlightRuleMatches(msg, r, ctx))
    return rule ? hexToRgba(rule.color, rule.opacity) : undefined
  }, [highlightRules, msg, isMention, settings.caseSensitiveNicks])

  // muted users: 'hide' is filtered out in MessageList; 'dim' renders semi-transparent here
  const muted = useMemo(
    () => settings.mutedUsers.find((u) => u.login === msg.login && !msg.system),
    [settings.mutedUsers, msg.login, msg.system]
  )

  if (msg.system === 'info') {
    // channel-point redemption: real points icon + colored nick + reward name + cost,
    // instead of an emoji and a generic "redeems" label
    if (msg.redeemed && msg.rewardTitle) {
      const rdark = settings.theme === 'dark'
      // prefer the user's CURRENT chat color from the live buffer (the redeem's stored color
      // is a snapshot and is often just a fallback hash if they hadn't spoken yet)
      const nickColor = ensureReadable(
        lookupUserColor(msg.channel, msg.login) || msg.color || fallbackColor(msg.login || ''),
        rdark
      )
      return (
        <div className="msg redeem-info">
          {settings.showTimestamps && (
            <span className="ts">{formatTime(msg.timestamp, settings.timestampSeconds)}</span>
          )}
          {msg.rewardIcon ? (
            <img className="redeem-icon" src={msg.rewardIcon} alt="" loading="lazy" />
          ) : (
            <span className="redeem-icon-emoji">🔴</span>
          )}
          {msg.displayName && (
            <span className="redeem-nick" style={{ color: nickColor }}>
              {msg.displayName}
            </span>
          )}{' '}
          <span className="redeem-reward">{msg.rewardTitle}</span>
          {msg.rewardCost != null && <span className="redeem-cost"> · {msg.rewardCost.toLocaleString('uk-UA')}</span>}
          {msg.text ? <span className="redeem-input">: {msg.text}</span> : null}
        </div>
      )
    }
    return (
      <div className={`msg ${msg.redeemed ? 'redeem-info' : ''}`}>
        {settings.showTimestamps && <span className="ts">{formatTime(msg.timestamp, settings.timestampSeconds)}</span>}
        <span className="sysmsg">{msg.systemText}</span>
      </div>
    )
  }

  const dark = settings.theme === 'dark'
  const color = ensureReadable(
    stvCosmetic?.color || stvCosmetic?.paintColor || msg.color || fallbackColor(msg.login),
    dark
  )
  // a 7TV gradient/image paint renders as the nick's own text fill (clipped background)
  const paintStyle: React.CSSProperties | undefined = stvCosmetic?.paint
    ? {
        background: stvCosmetic.paint,
        backgroundClip: 'text',
        WebkitBackgroundClip: 'text',
        color: 'transparent',
        WebkitTextFillColor: 'transparent'
      }
    : undefined
  const classes = ['msg']
  if (settings.alternatingBackground && index % 2 === 1) classes.push('alt')
  if (isMention && settings.showMentionBg) classes.push('mention')
  if (msg.deleted) classes.push('deleted')
  if (msg.historical) classes.push('historical')
  if (flash) classes.push('flash')
  if (msg.system === 'usernotice') classes.push('usernotice')
  if (dragX > 0) classes.push('swiping')
  // bits power-ups (Twitch-style): gigantified emote + animated message effect
  if (settings.showBits && msg.gigantified) classes.push('gigantified')
  if (settings.showBits && msg.messageEffect) classes.push('msg-effect', `effect-${msg.messageEffect}`)

  const canAct = !!account && !!msg.userId
  // moderators/broadcasters can't be timed out or banned by another mod — only their messages can be deleted
  const targetIsProtected = msg.badges.some(
    (b) => b.setId === 'moderator' || b.setId === 'lead_moderator' || b.setId === 'broadcaster'
  )
  const visibleButtons = modButtons
    .filter((b) => b.scope === 'message')
    .filter((b) => !b.channels?.length || b.channels.includes(msg.channel))
    .filter((b) => {
      const modOnly = MOD_ONLY_TYPES.has(b.type)
      if (modOnly && !isMod) return false
      // mods/broadcasters can't be punished, but delete and shoutout still make sense on them
      if (modOnly && targetIsProtected && b.type !== 'delete' && b.type !== 'shoutout') return false
      return true
    })
  // still swipeable after a delete — you often delete first, then decide to time out too
  const swipeEnabled = isMod && canAct
  const swipeTiers = settings.swipeTimeouts.length ? settings.swipeTimeouts : [60, 300, 600, 1800, 3600, 86400]
  // braille "ASCII art" is drawn for a fixed line width — never rewrap it
  const brailleArt = (msg.text.match(/[⠀-⣿]/g)?.length ?? 0) >= 24
  // best case: the original line structure can be recovered exactly (no slider needed)
  const artLines = useMemo(() => (brailleArt ? recoverArtLines(msg.text) : null), [brailleArt, msg.text])
  const [artCols, setArtCols] = useState(lastArtCols)
  const toast = useUiStore.getState().toast

  const openUserCard = (e: React.MouseEvent): void => {
    openCard({
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
    const action = swipeActionFor(dx, swipeLabels, swipeTiers, targetIsProtected)
    if (!action || !account) return
    const res =
      action.kind === 'delete'
        ? await deleteChatMessage(account, channelId, msg.id)
        : await banUser(account, channelId, msg.userId, action.seconds)
    if (res.ok) toast(`${action.label} — ${msg.login}`, 'ok')
    else toast(localizeApiError((res.json as { message?: string })?.message ?? '') || t('mod.actionFail'), 'error')
  }

  // swipe-to-moderate starts ONLY from the ⠿ grip — dragging from the message body used to
  // hijack plain text selection (left-to-right copy started a swipe)
  const startSwipe = (e: React.PointerEvent): void => {
    if (!swipeEnabled || e.button !== 0) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    draggingRef.current = true
    document.getSelection()?.removeAllRanges()
    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - start.x
      const cap = targetIsProtected ? SWIPE_TIMEOUT_START - 1 : banStartFor(swipeTiers) + 40
      setDragX(Math.max(0, Math.min(dx, cap)))
    }
    const onUp = (ev: PointerEvent): void => {
      cleanup()
      draggingRef.current = false
      executeSwipe(ev.clientX - start.x)
      setDragX(0)
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // RMB inserts the nick; Ctrl+RMB sends "@nick" to chat immediately
  const insertNick = tokenContextHandler(paneId, `@${msg.login} `)

  const swipeAction = dragX > 0 ? swipeActionFor(dragX, swipeLabels, swipeTiers, targetIsProtected) : null

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
            opacity: muted?.mode === 'dim' ? muted.opacity : undefined,
            background: msg.announceColor ? undefined : customBg,
            // PRIMARY announcements take the broadcaster's own color for this channel
            '--announce-accent': msg.announceColor
              ? msg.announceColor === 'primary'
                ? (channelAccent ?? ANNOUNCE_COLORS.primary)
                : ANNOUNCE_COLORS[msg.announceColor]
              : undefined,
            transform: dragX > 0 ? `translateX(${dragX}px)` : undefined
          } as React.CSSProperties
        }
      >
        {swipeEnabled && (
          <span
            className="swipe-grip"
            title={t('swipe.hint')}
            onPointerDown={startSwipe}
          >
            ⠿
          </span>
        )}
        {/* redemptions are announced on their own line by PubSub (with the real reward name);
            here we only tag bits, which come through IRC with the amount */}
        {settings.showBits && !!msg.bits && !msg.system && (
          <span className="event-header bits">{t('msg.bits', { count: msg.bits })}</span>
        )}
        {msg.system === 'usernotice' && msg.systemText && (
          <span
            className={`usernotice-tag ${msg.giftGroupId ? 'gift-toggle' : ''}`}
            onClick={
              msg.giftGroupId
                ? () => useUiStore.getState().toggleGiftGroup(msg.giftGroupId!)
                : undefined
            }
          >
            {msg.announceColor ? '📢' : '★'} {msg.systemText}
            {msg.giftGroupId && (
              <span className="gift-toggle-arrow">
                {useUiStore.getState().expandedGifts[msg.giftGroupId] ? ' ▲' : ` ▼ ${t('gift.showAll')}`}
              </span>
            )}
            {/* incoming raid + mod rights → one-click shoutout for the raider */}
            {msg.raidFrom && isMod && account && !msg.historical && (
              <button
                className="raid-shoutout-btn"
                title={`${t('mod.shoutout')}: ${msg.raidFrom}`}
                onClick={async (e) => {
                  e.stopPropagation()
                  const { resolveUserId } = await import('../services/modActions')
                  const id = await resolveUserId(account, msg.raidFrom!)
                  if (!id) {
                    toast(t('mod.actionFail'), 'error')
                    return
                  }
                  const { sendShoutout } = await import('../lib/helix')
                  const res = await sendShoutout(account, channelId, id)
                  if (res.ok) {
                    toast(`📣 ${msg.raidFrom}`, 'ok')
                    const { chatService } = await import('../services/chatService')
                    chatService.localInfo(msg.channel, t('mod.shoutoutGiven', { user: msg.raidFrom! }))
                  } else {
                    toast(localizeApiError((res.json as { message?: string })?.message ?? '') || t('mod.actionFail'), 'error')
                  }
                }}
              >
                📣 {t('mod.shoutout')}
              </button>
            )}
          </span>
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
        <span
          className="nick"
          style={paintStyle ?? { color }}
          onClick={openUserCard}
          onContextMenu={insertNick}
        >
          {msg.displayName}
          {msg.displayName.toLowerCase() !== msg.login ? ` (${msg.login})` : ''}
        </span>
        {/* raider tag: which streamer's raid they arrived with — lives exactly as long as
            the raider highlight window */}
        {msg.raider && msg.raiderFrom && (
          <span className="raider-tag" title={`${t('raid.raidWord')}: ${msg.raiderFrom}`}>
            🚨 {msg.raiderFrom}
          </span>
        )}
        {msg.isAction ? ' ' : ': '}
        {brailleArt && !artLines && (
          <span className="art-width-ctl" title={`${artCols}`}>
            <input
              type="range"
              min={16}
              max={60}
              value={artCols}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                setArtCols(v)
                lastArtCols = v
              }}
            />
          </span>
        )}
        {artLines ? (
          // original line structure recovered — render exactly as drawn
          <span className="msg-text ascii-art" style={{ whiteSpace: 'pre' }}>
            {artLines.join('\n')}
          </span>
        ) : (
          <span
            className={`msg-text ${brailleArt ? 'ascii-art' : ''}`}
            style={{
              ...(msg.isAction ? { color } : undefined),
              ...(brailleArt ? { width: Math.ceil(getBrailleCellWidth() * artCols) } : undefined)
            }}
          >
            {tokens.map((tk, i) => (
              <TokenView key={i} token={tk} paneId={paneId} />
            ))}
          </span>
        )}

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
                    targetMsgId: msg.id,
            targetText: msg.text
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
