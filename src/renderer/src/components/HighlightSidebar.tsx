import { useMemo } from 'react'
import { useChatStore } from '../store/chat'
import { useSettingsStore } from '../store/settings'
import { isHighlightedMessage } from '../lib/highlight'
import { JumpEventDetail } from './MessageList'
import { useT } from '../i18n'

export default function HighlightSidebar({ channel }: { channel: string }): React.JSX.Element {
  const t = useT()
  const messages = useChatStore((s) => s.messages[channel]) ?? []
  const highlightRules = useSettingsStore((s) => s.highlightRules)
  const caseSensitiveNicks = useSettingsStore((s) => s.settings.caseSensitiveNicks)

  const highlighted = useMemo(
    () => messages.filter((m) => isHighlightedMessage(m, highlightRules, caseSensitiveNicks)).slice(-100).reverse(),
    [messages, highlightRules, caseSensitiveNicks]
  )

  const jumpTo = (msgId: string): void => {
    window.dispatchEvent(new CustomEvent<JumpEventDetail>('sticki:jump', { detail: { channel, msgId } }))
  }

  return (
    <div className="highlight-sidebar">
      <div className="picker-section" style={{ margin: '0 0 6px 0' }}>
        {t('highlights.title')}
      </div>
      <div className="highlight-list">
        {highlighted.length === 0 && <div className="picker-empty">{t('highlights.empty')}</div>}
        {highlighted.map((m) => (
          <button key={m.id} className="highlight-item" onClick={() => jumpTo(m.id)}>
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
