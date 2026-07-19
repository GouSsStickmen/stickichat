import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore, lookupUserColor } from '../store/chat'
import { useSettingsStore } from '../store/settings'
import { lookupBadgeUrl } from '../store/emotes'
import { isHighlightedMessage } from '../lib/highlight'
import { HlSavedItem, hlSavedKey, loadSavedMap, persistSaved, reloadSavedMap } from '../services/hlAccumulator'
import { ensureReadable, fallbackColor } from '../lib/tokenize'
import { ChatMessage } from '../types'
import RichText from './RichText'
import { JumpEventDetail } from './MessageList'
import { useT } from '../i18n'

type Mode = 'highlights' | 'mentions' | 'redeems' | 'subs'
type Order = 'newest-top' | 'newest-bottom'

/**
 * The chat ring buffer evicts old messages during floods — highlighted entries used to vanish
 * with them. The panel keeps its OWN accumulated list (a trimmed ChatMessage snapshot with
 * precomputed tab flags) and persists it per channel, so history survives floods, window
 * reopens and restarts.
 */
/** compact message body: system lines are plain text, chat lines get the rich renderer */
function ItemText({ msg }: { msg: ChatMessage }): React.JSX.Element {
  if (msg.system) return <>{msg.systemText}</>
  return <RichText msg={msg} />
}

export default function HighlightSidebar({
  channel,
  standalone
}: {
  channel: string
  standalone?: boolean
}): React.JSX.Element {
  const t = useT()
  const messages = useChatStore((s) => s.messages[channel]) ?? []
  const lastReadAt = useChatStore((s) => s.lastReadAt[channel] ?? Number.MAX_SAFE_INTEGER)
  const highlightRules = useSettingsStore((s) => s.highlightRules)
  const caseSensitiveNicks = useSettingsStore((s) => s.settings.caseSensitiveNicks)
  const fontSize = useSettingsStore((s) => s.settings.highlightsFontSize)
  const dark = useSettingsStore((s) => s.settings.theme === 'dark')
  const set = useSettingsStore((s) => s.setSettings)
  const [mode, setMode] = useState<Mode>(
    () => useSettingsStore.getState().settings.highlightSidebarDefault
  )
  // realtime like the chat itself: newest at the BOTTOM by default
  const [order, setOrder] = useState<Order>('newest-bottom')
  const listRef = useRef<HTMLDivElement>(null)
  // don't yank the list to the end while the user is reading older entries
  const atBottomRef = useRef(true)

  // the SHARED accumulator (fed by chatService in the main window even while this panel
  // is closed); live updates via an event, cross-window updates via the storage event
  const [savedVersion, setSavedVersion] = useState(0)
  useEffect(() => {
    const onSaved = (e: Event): void => {
      if ((e as CustomEvent<{ channel: string }>).detail.channel === channel) setSavedVersion((v) => v + 1)
    }
    const onStorage = (e: StorageEvent): void => {
      if (e.key === hlSavedKey(channel)) {
        reloadSavedMap(channel)
        setSavedVersion((v) => v + 1)
      }
    }
    window.addEventListener('sticki:hlsaved', onSaved)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('sticki:hlsaved', onSaved)
      window.removeEventListener('storage', onStorage)
    }
  }, [channel])

  // fallback ingest for standalone windows (where the central accumulator is inactive)
  useEffect(() => {
    if (!window.location.hash) return
    let added = false
    const map = loadSavedMap(channel)
    for (const m of messages) {
      if (map.has(m.id)) continue
      const men = !!(m.isMention || m.replyToMe)
      const red = !!m.redeemed
      const sub = !!m.subEvent
      const hl = isHighlightedMessage(m, highlightRules, { caseSensitiveNicks })
      if (!men && !red && !hl && !sub) continue
      map.set(m.id, { ...m, _men: men, _hl: hl, _sub: sub } as HlSavedItem)
      added = true
    }
    if (added) {
      persistSaved(channel)
      setSavedVersion((v) => v + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, highlightRules, caseSensitiveNicks, channel])

  const items = useMemo(() => {
    const all = [...loadSavedMap(channel).values()].sort((a, b) => a.timestamp - b.timestamp)
    const filtered =
      mode === 'mentions'
        ? all.filter((m) => m._men)
        : mode === 'redeems'
          ? all.filter((m) => m.redeemed)
          : mode === 'subs'
            ? all.filter((m) => m._sub || m.subEvent)
            : all.filter((m) => m._hl)
    const latest = filtered.slice(-150)
    return order === 'newest-top' ? [...latest].reverse() : latest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedVersion, mode, order, channel])

  // keep the newest entry in view only when the user is already at the bottom
  useEffect(() => {
    const el = listRef.current
    if (!el || order !== 'newest-bottom') return
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [items.length, order, mode])

  // switching tab/order starts glued to the fresh end again
  useEffect(() => {
    atBottomRef.current = true
    const el = listRef.current
    if (el) el.scrollTop = order === 'newest-bottom' ? el.scrollHeight : 0
  }, [mode, order])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const jumpTo = (msgId: string): void => {
    if (standalone) {
      // the chat lives in the MAIN window — send the jump over IPC
      window.sticki.jumpToMessage(JSON.stringify({ channel, msgId }))
    } else {
      window.dispatchEvent(new CustomEvent<JumpEventDetail>('sticki:jump', { detail: { channel, msgId } }))
    }
  }

  const openWindow = (): void => {
    window.sticki.openHighlightsWindow(`highlights=${encodeURIComponent(channel)}`)
  }

  return (
    <div className={`highlight-sidebar ${standalone ? 'highlight-sidebar-standalone' : ''}`}>
      <div className="picker-section" style={{ margin: '0 0 6px 0', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <button
          className={`picker-tab-btn ${mode === 'highlights' ? 'active' : ''}`}
          onClick={() => setMode('highlights')}
        >
          {t('highlights.title')}
        </button>
        <button
          className={`picker-tab-btn ${mode === 'mentions' ? 'active' : ''}`}
          onClick={() => setMode('mentions')}
        >
          {t('highlights.mentions')}
        </button>
        <button
          className={`picker-tab-btn ${mode === 'redeems' ? 'active' : ''}`}
          onClick={() => setMode('redeems')}
        >
          {t('highlights.redeems')}
        </button>
        <button
          className={`picker-tab-btn ${mode === 'subs' ? 'active' : ''}`}
          onClick={() => setMode('subs')}
        >
          {t('highlights.subs')}
        </button>
        <button
          className="ghost"
          title={t('highlights.sortOrder')}
          onClick={() => setOrder((o) => (o === 'newest-top' ? 'newest-bottom' : 'newest-top'))}
        >
          {order === 'newest-top' ? '↓' : '↑'}
        </button>
        <button className="ghost" onClick={() => set({ highlightsFontSize: Math.max(9, fontSize - 1) })}>
          A−
        </button>
        <button className="ghost" onClick={() => set({ highlightsFontSize: Math.min(22, fontSize + 1) })}>
          A+
        </button>
        {!standalone && (
          <button className="ghost" title={t('highlights.openWindow')} onClick={openWindow}>
            ⧉
          </button>
        )}
      </div>
      <div className="highlight-list" ref={listRef} onScroll={onScroll} style={{ fontSize }}>
        {items.length === 0 && <div className="picker-empty">{t('highlights.empty')}</div>}
        {items.map((m) => {
          // redeem lines are "system" but carry the redeemer's login/color — color them too;
          // prefer the live buffer color (the stored one may be a fallback hash)
          const color = m.login
            ? ensureReadable(lookupUserColor(m.channel, m.login) || m.color || fallbackColor(m.login), dark)
            : undefined
          // redemptions: channel-points icon + colored nick + reward name + cost (no dup nick)
          if (m.redeemed && m.rewardTitle) {
            return (
              <button
                key={m.id}
                className={`highlight-item ${m.timestamp > lastReadAt ? 'unread' : ''}`}
                onClick={() => jumpTo(m.id)}
              >
                <span className="highlight-item-nick" style={{ color }}>
                  {m.rewardIcon ? (
                    <img className="hl-redeem-icon" src={m.rewardIcon} alt="" />
                  ) : (
                    '🔴 '
                  )}
                  {m.displayName}
                </span>
                <span className="highlight-item-text">
                  <span className="redeem-reward">{m.rewardTitle}</span>
                  {m.rewardCost != null && <span className="redeem-cost"> · {m.rewardCost.toLocaleString('uk-UA')}</span>}
                  {m.text ? <span>: {m.text}</span> : null}
                </span>
              </button>
            )
          }
          return (
            <button
              key={m.id}
              className={`highlight-item ${m.timestamp > lastReadAt ? 'unread' : ''}`}
              onClick={() => jumpTo(m.id)}
            >
              <span className="highlight-item-nick" style={{ color }}>
                {m.redeemed && '🔴 '}
                {!m.system &&
                  m.badges.map((b) => {
                    const url = lookupBadgeUrl(m.channel, b.setId, b.version)
                    return url ? (
                      <img key={`${b.setId}/${b.version}`} className="hl-badge" src={url} alt={b.setId} />
                    ) : null
                  })}
                {m.displayName || (m.redeemed ? t('highlights.redeems') : '')}
              </span>
              <span className="highlight-item-text">
                <ItemText msg={m} />
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
