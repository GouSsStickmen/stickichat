import { useMemo, useState } from 'react'
import { useChatStore } from '../store/chat'
import { useSettingsStore } from '../store/settings'
import { isHighlightedMessage } from '../lib/highlight'
import { JumpEventDetail } from './MessageList'
import { useT } from '../i18n'

type Mode = 'highlights' | 'mentions'
type Order = 'newest-top' | 'newest-bottom'

export default function HighlightSidebar({ channel }: { channel: string }): React.JSX.Element {
  const t = useT()
  const messages = useChatStore((s) => s.messages[channel]) ?? []
  const lastReadAt = useChatStore((s) => s.lastReadAt[channel] ?? Number.MAX_SAFE_INTEGER)
  const highlightRules = useSettingsStore((s) => s.highlightRules)
  const caseSensitiveNicks = useSettingsStore((s) => s.settings.caseSensitiveNicks)
  const [mode, setMode] = useState<Mode>(
    () => useSettingsStore.getState().settings.highlightSidebarDefault
  )
  const [order, setOrder] = useState<Order>('newest-top')

  const items = useMemo(() => {
    const filtered =
      mode === 'mentions'
        ? messages.filter((m) => m.isMention || m.replyToMe)
        : messages.filter((m) => isHighlightedMessage(m, highlightRules, { caseSensitiveNicks }))
    const latest = filtered.slice(-100)
    return order === 'newest-top' ? [...latest].reverse() : latest
  }, [messages, highlightRules, caseSensitiveNicks, mode, order])

  const jumpTo = (msgId: string): void => {
    window.dispatchEvent(new CustomEvent<JumpEventDetail>('sticki:jump', { detail: { channel, msgId } }))
  }

  return (
    <div className="highlight-sidebar">
      <div className="picker-section" style={{ margin: '0 0 6px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
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
          className="ghost"
          title={t('highlights.sortOrder')}
          onClick={() => setOrder((o) => (o === 'newest-top' ? 'newest-bottom' : 'newest-top'))}
        >
          {order === 'newest-top' ? '↓' : '↑'}
        </button>
      </div>
      <div className="highlight-list">
        {items.length === 0 && <div className="picker-empty">{t('highlights.empty')}</div>}
        {items.map((m) => (
          <button
            key={m.id}
            className={`highlight-item ${m.timestamp > lastReadAt ? 'unread' : ''}`}
            onClick={() => jumpTo(m.id)}
          >
            <span className="highlight-item-nick" style={{ color: m.color ?? undefined }}>
              {m.displayName}
            </span>
            <span className="highlight-item-text">{m.text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
