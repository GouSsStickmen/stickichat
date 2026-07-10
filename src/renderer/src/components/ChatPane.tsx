import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MOD_ONLY_TYPES, Pane } from '../types'
import { useChatStore, lookupUserBadges } from '../store/chat'
import { useAccountsStore } from '../store/accounts'
import { useUiStore } from '../store/ui'
import { getUsers } from '../lib/helix'
import { useLayoutStore } from '../store/layout'
import { useSettingsStore } from '../store/settings'
import { canModerate } from '../services/accountService'
import { loadTwitchUserEmotes } from '../services/emoteService'
import MessageList from './MessageList'
import InputBox, { ReplyTarget } from './InputBox'
import ModToolbar from './ModToolbar'
import ChattersList from './ChattersList'
import HighlightSidebar from './HighlightSidebar'
import { AddPaneForm } from './SplitGrid'
import { useT } from '../i18n'

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime()
  if (ms <= 0) return '0:00'
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

export default function ChatPane({ tabId, pane }: { tabId: string; pane: Pane }): React.JSX.Element {
  const t = useT()
  const channelId = useChatStore((s) => s.channelIds[pane.channel] ?? '')
  const isLive = useChatStore((s) => !!s.liveChannels[pane.channel])
  const channelName = useChatStore((s) => s.channelNames[pane.channel])
  const streamInfo = useChatStore((s) => s.streamInfo[pane.channel])
  const showStreamInfo = useSettingsStore((s) => s.settings.showStreamInfo)
  // re-render every minute so the uptime counter ticks
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!streamInfo) return
    const id = window.setInterval(() => forceTick((v) => v + 1), 60000)
    return () => window.clearInterval(id)
  }, [streamInfo])
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
  const [addPaneOpen, setAddPaneOpen] = useState(false)
  const [scrollLocked, setScrollLocked] = useState(false)
  const keydownHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null)

  const onReply = useCallback((target: ReplyTarget) => setReplyTo(target), [])

  // preload the sending account's twitch emotes (incl. sub emotes + owner names) as soon as we
  // know the account, so the picker already has everything ready the first time it's opened
  useEffect(() => {
    if (account) loadTwitchUserEmotes(account)
  }, [account])

  // clicking an @mention in message text opens the user card for that login
  useEffect(() => {
    const onOpenCard = async (e: Event): Promise<void> => {
      const d = (e as CustomEvent<{ paneId: string; login: string; x: number; y: number }>).detail
      if (d.paneId !== pane.id || !account) return
      const [user] = await getUsers(account, { logins: [d.login] })
      if (!user) return
      useUiStore.getState().setUserCard({
        channel: pane.channel,
        channelId,
        userId: user.id,
        login: user.login,
        displayName: user.display_name,
        badges: lookupUserBadges(pane.channel, user.login) ?? [],
        accountId: pane.accountId,
        x: d.x,
        y: d.y
      })
    }
    window.addEventListener('sticki:opencard', onOpenCard as EventListener)
    return () => window.removeEventListener('sticki:opencard', onOpenCard as EventListener)
  }, [account, channelId, pane.id, pane.channel, pane.accountId])

  const bindHotkeys = (): void => {
    if (keydownHandlerRef.current) return
    const onKey = (e: KeyboardEvent): void => {
      // physical key, not the produced character — works on the Ukrainian layout too
      if (e.ctrlKey && e.code === 'KeyL') {
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
      <div className="pane-header">
        <span className="channel-name">{channelName ?? pane.channel}</span>
        {isLive && <span className="live-badge">{t('pane.live')}</span>}
        {isMod && (
          <span className={`mod-badge ${isBroadcaster ? 'broadcaster' : ''}`}>
            {isBroadcaster ? t('mod.youAreBroadcaster') : t('mod.youAreMod')}
          </span>
        )}
        {showStreamInfo && streamInfo && (
          <span className="stream-info" title={streamInfo.title}>
            👁 {streamInfo.viewers.toLocaleString('uk-UA')} · ⏱ {formatUptime(streamInfo.startedAt)}
            {streamInfo.title ? ` · ${streamInfo.title}` : ''}
          </span>
        )}
        <div className="spacer" />
        <span style={{ position: 'relative' }}>
          <button
            className="icon-btn"
            title={t('pane.add')}
            onClick={() => setAddPaneOpen((v) => !v)}
          >
            +
          </button>
          {addPaneOpen && (
            <div className="popover" style={{ top: '100%', right: 0, marginTop: 6 }} onDragStart={(e) => e.stopPropagation()}>
              <AddPaneForm tabId={tabId} onDone={() => setAddPaneOpen(false)} />
            </div>
          )}
        </span>
        <button
          className={`icon-btn ${scrollLocked ? 'active' : ''}`}
          title={t('pane.scrollLock')}
          onClick={() => setScrollLocked((v) => !v)}
        >
          {scrollLocked ? '🔒' : '🔓'}
        </button>
        <button
          className={`icon-btn ${showHighlightSidebar ? 'active' : ''}`}
          title={t('highlights.title')}
          onClick={() =>
            useSettingsStore.getState().setSettings({ showHighlightSidebar: !showHighlightSidebar })
          }
        >
          ★
        </button>
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
