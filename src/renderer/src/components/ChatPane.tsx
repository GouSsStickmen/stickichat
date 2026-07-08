import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MOD_ONLY_TYPES, Pane } from '../types'
import { useChatStore } from '../store/chat'
import { useAccountsStore } from '../store/accounts'
import { useLayoutStore } from '../store/layout'
import { useSettingsStore } from '../store/settings'
import { canModerate } from '../services/accountService'
import { loadTwitchUserEmotes } from '../services/emoteService'
import MessageList from './MessageList'
import InputBox, { ReplyTarget } from './InputBox'
import ModToolbar from './ModToolbar'
import ChattersList from './ChattersList'
import HighlightSidebar from './HighlightSidebar'
import { useT } from '../i18n'

export default function ChatPane({ tabId, pane }: { tabId: string; pane: Pane }): React.JSX.Element {
  const t = useT()
  const channelId = useChatStore((s) => s.channelIds[pane.channel] ?? '')
  const isLive = useChatStore((s) => !!s.liveChannels[pane.channel])
  const accounts = useAccountsStore((s) => s.accounts)
  const account = useMemo(
    () => accounts.find((a) => a.id === pane.accountId),
    [accounts, pane.accountId]
  )
  const isBroadcaster = account && account.login.toLowerCase() === pane.channel.toLowerCase()
  const isMod = canModerate(account, pane.channel, channelId)
  const modButtons = useSettingsStore((s) => s.modButtons)
  const hasToolbarButtons = modButtons.some((b) => b.scope === 'toolbar' && !MOD_ONLY_TYPES.has(b.type))
  const showHighlightSidebar = useSettingsStore((s) => s.settings.showHighlightSidebar)
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null)
  const [chattersOpen, setChattersOpen] = useState(false)
  const [scrollLocked, setScrollLocked] = useState(false)
  const keydownHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null)

  const onReply = useCallback((target: ReplyTarget) => setReplyTo(target), [])

  // preload the sending account's twitch emotes (incl. sub emotes + owner names) as soon as we
  // know the account, so the picker already has everything ready the first time it's opened
  useEffect(() => {
    if (account) loadTwitchUserEmotes(account)
  }, [account])

  const bindHotkeys = (): void => {
    if (keydownHandlerRef.current) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        setScrollLocked((v) => !v)
      }
    }
    keydownHandlerRef.current = onKey
    document.addEventListener('keydown', onKey)
  }
  const unbindHotkeys = (): void => {
    if (keydownHandlerRef.current) {
      document.removeEventListener('keydown', keydownHandlerRef.current)
      keydownHandlerRef.current = null
    }
  }

  return (
    <div className="pane" onMouseEnter={bindHotkeys} onMouseLeave={unbindHotkeys}>
      <div
        className="pane-header"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('sticki/pane', pane.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('sticki/pane')) e.preventDefault()
        }}
        onDrop={(e) => {
          const dragged = e.dataTransfer.getData('sticki/pane')
          if (dragged && dragged !== pane.id) {
            e.preventDefault()
            useLayoutStore.getState().swapPanes(tabId, dragged, pane.id)
          }
        }}
        title="⠿ drag"
      >
        <span className="channel-name">#{pane.channel}</span>
        {isLive && <span className="live-badge">{t('pane.live')}</span>}
        {isMod && (
          <span className={`mod-badge ${isBroadcaster ? 'broadcaster' : ''}`}>
            {isBroadcaster ? t('mod.youAreBroadcaster') : t('mod.youAreMod')}
          </span>
        )}
        <div className="spacer" />
        <span style={{ position: 'relative' }}>
          <button
            className="icon-btn chatters-btn"
            title={t('chatters.title')}
            onClick={() => setChattersOpen((v) => !v)}
          >
            👥
          </button>
          {chattersOpen && (
            <ChattersList
              pane={pane}
              account={account}
              channelId={channelId}
              isMod={isMod}
              onClose={() => setChattersOpen(false)}
            />
          )}
        </span>
        <button
          className="icon-btn"
          title={t('user.openChannel')}
          onClick={() => window.sticki.openExternal(`https://www.twitch.tv/${pane.channel}`)}
        >
          ↗
        </button>
        <button
          className="icon-btn"
          title={t('pane.close')}
          onClick={() => useLayoutStore.getState().closePane(tabId, pane.id)}
        >
          ✕
        </button>
      </div>
      {(isMod || hasToolbarButtons) && account && (
        <ModToolbar pane={pane} account={account} channelId={channelId} isMod={isMod} />
      )}
      <div className="pane-body">
        <MessageList
          pane={pane}
          account={account}
          channelId={channelId}
          isMod={isMod}
          onReply={onReply}
          scrollLocked={scrollLocked}
          onToggleScrollLock={() => setScrollLocked((v) => !v)}
        />
        {showHighlightSidebar && <HighlightSidebar channel={pane.channel} />}
      </div>
      <InputBox
        tabId={tabId}
        pane={pane}
        account={account}
        channelId={channelId}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />
    </div>
  )
}
