import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import { useSettingsStore } from '../store/settings'
import { useEmotesStore, lookupBadgeUrl, lookupEmote } from '../store/emotes'
import { isHighlightedMessage } from '../lib/highlight'
import { tokenizeMessage, ensureReadable, fallbackColor } from '../lib/tokenize'
import { ChatMessage } from '../types'
import EmojiGlyph from './EmojiGlyph'
import { JumpEventDetail } from './MessageList'
import { useT } from '../i18n'

type Mode = 'highlights' | 'mentions' | 'redeems'
type Order = 'newest-top' | 'newest-bottom'

/**
 * The chat ring buffer evicts old messages during floods — highlighted entries used to vanish
 * with them. The panel keeps its OWN accumulated list (a trimmed ChatMessage snapshot with
 * precomputed tab flags) and persists it per channel, so history survives floods, window
 * reopens and restarts.
 */
interface SavedItem extends ChatMessage {
  /** which tabs this item belongs to (computed once, at ingest time) */
  _men?: boolean
  _hl?: boolean
}

const savedKey = (channel: string): string => `sticki:hlSaved:${channel}`
const SAVED_LIMIT = 300

function loadSaved(channel: string): Map<string, SavedItem> {
  try {
    const raw = localStorage.getItem(savedKey(channel))
    const list = raw ? (JSON.parse(raw) as SavedItem[]) : []
    return new Map(list.map((i) => [i.id, i]))
  } catch {
    return new Map()
  }
}

/** compact message body with emotes/emoji rendered inline */
function ItemText({ msg }: { msg: ChatMessage }): React.JSX.Element {
  const emoteVersion = useEmotesStore((s) => s.version)
  const tokens = useMemo(
    () => (msg.system ? [] : tokenizeMessage(msg, lookupEmote(msg.channel))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [msg, emoteVersion]
  )
  if (msg.system) return <>{msg.systemText}</>
  return (
    <>
      {tokens.map((tk, i) => {
        if (tk.kind === 'emote')
          return <img key={i} className="hl-emote" src={tk.emote.url} alt={tk.emote.code} loading="lazy" />
        if (tk.kind === 'emoji') return <EmojiGlyph key={i} char={tk.char} />
        if (tk.kind === 'link') return <span key={i}>{tk.label}</span>
        if (tk.kind === 'mention') return <b key={i}>{tk.name}</b>
        if (tk.kind === 'cheer')
          return (
            <b key={i} style={{ color: tk.color }}>
              {tk.bits}
            </b>
          )
        if (tk.kind === 'text' || tk.kind === 'command') return <span key={i}>{tk.text}</span>
        return null
      })}
    </>
  )
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

  // own accumulated store: chat-buffer eviction can't touch it; persisted per channel
  const savedRef = useRef<Map<string, SavedItem>>(loadSaved(channel))
  const [savedVersion, setSavedVersion] = useState(0)
  const persistTimer = useRef<number | null>(null)
  const schedulePersist = (): void => {
    if (persistTimer.current !== null) return
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null
      try {
        const list = [...savedRef.current.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-SAVED_LIMIT)
        savedRef.current = new Map(list.map((i) => [i.id, i]))
        localStorage.setItem(savedKey(channel), JSON.stringify(list))
      } catch {
        /* best-effort */
      }
    }, 500)
  }

  useEffect(() => {
    let added = false
    for (const m of messages) {
      if (savedRef.current.has(m.id)) continue
      const men = !!(m.isMention || m.replyToMe)
      const red = !!m.redeemed
      const hl = isHighlightedMessage(m, highlightRules, { caseSensitiveNicks })
      if (!men && !red && !hl) continue
      savedRef.current.set(m.id, { ...m, _men: men, _hl: hl })
      added = true
    }
    if (added) {
      setSavedVersion((v) => v + 1)
      schedulePersist()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, highlightRules, caseSensitiveNicks])

  const items = useMemo(() => {
    const all = [...savedRef.current.values()].sort((a, b) => a.timestamp - b.timestamp)
    const filtered =
      mode === 'mentions'
        ? all.filter((m) => m._men)
        : mode === 'redeems'
          ? all.filter((m) => m.redeemed)
          : all.filter((m) => m._hl)
    const latest = filtered.slice(-150)
    return order === 'newest-top' ? [...latest].reverse() : latest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedVersion, mode, order])

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
          const color = m.system
            ? undefined
            : ensureReadable(m.color || fallbackColor(m.login || 'x'), dark)
          return (
            <button
              key={m.id}
              className={`highlight-item ${m.timestamp > lastReadAt ? 'unread' : ''}`}
              onClick={() => jumpTo(m.id)}
            >
              <span className="highlight-item-nick" style={{ color }}>
                {m.redeemed && '🎁 '}
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
