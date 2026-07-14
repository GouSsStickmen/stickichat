import { useRef, useState } from 'react'
import { useLayoutStore } from '../store/layout'
import { useChatStore } from '../store/chat'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { useWhispersStore } from '../store/whispers'
import { startPointerReorder, justReordered } from '../lib/pointerReorder'
import { buildChannelSeed } from '../lib/detachSeed'
import { useFlip } from '../lib/useFlip'
import WhisperPanel from './WhisperPanel'
import { useT } from '../i18n'

export default function TabBar(): React.JSX.Element {
  const t = useT()
  const tabs = useLayoutStore((s) => s.tabs)
  const activeTabId = useLayoutStore((s) => s.activeTabId)
  const connState = useChatStore((s) => s.connState)
  const liveChannels = useChatStore((s) => s.liveChannels)
  const unreadMentions = useChatStore((s) => s.unreadMentions)
  const unreadMessages = useChatStore((s) => s.unreadMessages)
  const alwaysOnTop = useSettingsStore((s) => s.settings.alwaysOnTop)
  const muted = useSettingsStore((s) => s.settings.muted)
  const tabScale = useSettingsStore((s) => s.settings.tabScale)
  const tabFilter = useSettingsStore((s) => s.settings.tabFilter)
  const setSettings = useSettingsStore((s) => s.setSettings)
  const channelNames = useChatStore((s) => s.channelNames)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [draggingTab, setDraggingTab] = useState<string | null>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const unreadWhispers = useWhispersStore((s) => s.unread)
  const whispersOpen = useUiStore((s) => s.whispersOpen)

  const activeTab = tabs.find((x) => x.id === activeTabId)

  // FLIP: when the order changes (drag reorder, close, add), every tab glides from its
  // previous position to the new one — the Chrome-tabs feel
  useFlip(tabsRef, '.tab', !!draggingTab)

  const tabLabel = (id: string): string => {
    const tab = tabs.find((x) => x.id === id)
    if (!tab) return ''
    if (tab.name) return tab.name
    if (tab.panes.length === 0) return t('tab.new')
    return tab.panes.map((p) => channelNames[p.channel] ?? p.channel).join(' · ')
  }

  const activateTab = (id: string): void => {
    useLayoutStore.getState().setActiveTab(id)
    const tab = useLayoutStore.getState().tabs.find((x) => x.id === id)
    if (tab) {
      const channels = tab.panes.map((p) => p.channel)
      useChatStore.getState().clearUnreadMentions(channels)
      useChatStore.getState().clearUnreadMessages(channels)
      useChatStore.getState().markChannelsRead(channels)
    }
  }

  const detachTab = (id: string): void => {
    const tab = useLayoutStore.getState().tabs.find((x) => x.id === id)
    if (!tab || tab.panes.length === 0) return
    const payload = {
      name: tab.name ?? tab.panes.map((p) => p.channel).join(' · '),
      panes: tab.panes.map((p) => ({ channel: p.channel, accountId: p.accountId })),
      // hand over the live buffer so the detached window keeps state instead of reloading
      // everything as dimmed "historical" scrollback
      seed: buildChannelSeed(tab.panes.map((p) => p.channel))
    }
    window.sticki.detach(`detached=${encodeURIComponent(JSON.stringify(payload))}`)
    useLayoutStore.getState().closeTab(id)
  }

  const isLiveTab = (tab: (typeof tabs)[number]): boolean =>
    tab.panes.some((p) => liveChannels[p.channel])
  // filter by live status; 'all' keeps the full list (and normal drag-reorder)
  const visibleTabs =
    tabFilter === 'all'
      ? tabs
      : tabs.filter((tab) => (tabFilter === 'online' ? isLiveTab(tab) : !isLiveTab(tab)))
  const cycleFilter = (): void =>
    setSettings({ tabFilter: tabFilter === 'all' ? 'online' : tabFilter === 'online' ? 'offline' : 'all' })
  const filterIcon = tabFilter === 'online' ? '🟢' : tabFilter === 'offline' ? '⚫' : '≡'

  return (
    <div className="tabbar">
      {/* floated right — must precede the tab flow so rows wrap around it */}
      <div className="tabbar-actions">
      <button className="icon-btn" title={t(`tab.filter.${tabFilter}`)} onClick={cycleFilter}>
        {filterIcon}
      </button>
      <span className="tab-zoom">
        <button className="icon-btn" title={t('tab.zoomOut')} onClick={() => setSettings({ tabScale: Math.max(0.6, Math.round((tabScale - 0.1) * 10) / 10) })}>
          A−
        </button>
        <button className="icon-btn" title={t('tab.zoomIn')} onClick={() => setSettings({ tabScale: Math.min(1.8, Math.round((tabScale + 0.1) * 10) / 10) })}>
          A+
        </button>
      </span>
      {activeTab && activeTab.panes.length > 1 && (
        <select
          title={t('pane.columns')}
          style={{ padding: '3px 6px', fontSize: 12 }}
          value={activeTab.columns}
          onChange={(e) =>
            useLayoutStore.getState().setColumns(activeTab.id, parseInt(e.target.value, 10))
          }
        >
          <option value={0}>{t('pane.auto')}</option>
          {[1, 2, 3, 4].map((c) => (
            <option key={c} value={c}>
              {c} ⬚
            </option>
          ))}
        </select>
      )}
      <span style={{ position: 'relative' }}>
        <button
          className={`icon-btn whisper-btn ${whispersOpen ? 'active' : ''}`}
          title={t('whisper.title')}
          onClick={() => {
            if (useSettingsStore.getState().settings.whispersAsWindow) {
              window.sticki.openWhispersWindow('whispers')
              useWhispersStore.getState().markRead()
            } else {
              useUiStore.getState().setWhispersOpen(!whispersOpen)
            }
          }}
        >
          ✉
          {unreadWhispers > 0 && <span className="whisper-badge">{unreadWhispers}</span>}
        </button>
        {whispersOpen && <WhisperPanel onClose={() => useUiStore.getState().setWhispersOpen(false)} />}
      </span>
      <button
        className={`icon-btn ${muted ? 'active' : ''}`}
        title={t('set.mute')}
        onClick={() => setSettings({ muted: !muted })}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      <button
        className={`icon-btn ${alwaysOnTop ? 'active' : ''}`}
        title={t('set.alwaysOnTop')}
        onClick={() => setSettings({ alwaysOnTop: !alwaysOnTop })}
      >
        📌
      </button>
      <button
        className="icon-btn"
        title={t('set.title')}
        onClick={() => {
          if (useSettingsStore.getState().settings.settingsAsWindow) {
            window.sticki.openSettingsWindow('settings')
          } else {
            useUiStore.getState().setSettingsOpen(true)
          }
        }}
      >
        ⚙
      </button>
      </div>
      <div className="tabbar-tabs" ref={tabsRef} style={{ zoom: tabScale }}>
      <span
        className="conn-dot"
        title={connState === 'open' ? t('misc.connected') : t('misc.disconnected')}
        style={{ background: connState === 'open' ? 'var(--success)' : 'var(--danger)' }}
      />
      {visibleTabs.map((tab, index) => {
        const hasLive = tab.panes.some((p) => liveChannels[p.channel])
        const hasMention = tab.panes.some((p) => unreadMentions[p.channel])
        const hasUnread = !hasMention && tab.panes.some((p) => unreadMessages[p.channel])
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            data-flipid={tab.id}
            className={`tab ${isActive ? 'active' : ''} ${draggingTab === tab.id ? 'dragging' : ''}`}
            onPointerDown={(e) => {
              if (renaming === tab.id) return
              if ((e.target as HTMLElement).closest('.close, input')) return
              if (!tabsRef.current) return
              // reorder indices only line up with the DOM when the full list is shown
              if (tabFilter !== 'all') return
              startPointerReorder({
                e,
                container: tabsRef.current,
                itemSelector: '.tab',
                index,
                axis: 'x',
                onMove: (_from, to) => useLayoutStore.getState().moveTab(tab.id, to),
                onDragState: (d) => setDraggingTab(d ? tab.id : null)
              })
            }}
            onClick={() => {
              if (justReordered) return
              activateTab(tab.id)
            }}
            onDoubleClick={() => {
              setRenaming(tab.id)
              setNameInput(tab.name ?? '')
            }}
          >
            {hasLive && <span className="live-dot" title={t('pane.live')} />}
            {renaming === tab.id ? (
              <input
                autoFocus
                value={nameInput}
                style={{ width: 110, padding: '1px 5px' }}
                onChange={(e) => setNameInput(e.target.value)}
                onBlur={() => {
                  useLayoutStore.getState().renameTab(tab.id, nameInput)
                  setRenaming(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    useLayoutStore.getState().renameTab(tab.id, nameInput)
                    setRenaming(null)
                  }
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tabLabel(tab.id)}</span>
            )}
            {/* fixed-width slot so the tab doesn't change size when an indicator appears */}
            <span className="tab-indicator-slot">
              {hasMention && <span className="mention-dot">@</span>}
              {!hasMention && hasUnread && <span className="unread-dot" title={t('tab.newMessage')} />}
            </span>
            {/* rendered for EVERY tab (visibility toggled in CSS): if only the active tab
                had it, activating a tab changed its width and whole rows re-wrapped */}
            {tab.panes.length > 0 && (
              <span
                className="close detach"
                title={t('tab.detach')}
                onClick={(e) => {
                  e.stopPropagation()
                  detachTab(tab.id)
                }}
              >
                ⧉
              </span>
            )}
            <span
              className="close"
              title={t('tab.close')}
              onClick={(e) => {
                e.stopPropagation()
                useLayoutStore.getState().closeTab(tab.id)
              }}
            >
              ✕
            </span>
          </div>
        )
      })}
      <button className="icon-btn" title={t('tab.new')} onClick={() => useLayoutStore.getState().addTab()}>
        +
      </button>
      </div>
    </div>
  )
}
