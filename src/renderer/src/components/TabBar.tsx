import { useRef, useState } from 'react'
import { useLayoutStore } from '../store/layout'
import { useChatStore } from '../store/chat'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { startPointerReorder, justReordered } from '../lib/pointerReorder'
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
  const setSettings = useSettingsStore((s) => s.setSettings)
  const channelNames = useChatStore((s) => s.channelNames)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [draggingTab, setDraggingTab] = useState<string | null>(null)
  const tabsRef = useRef<HTMLDivElement>(null)

  const activeTab = tabs.find((x) => x.id === activeTabId)

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
      panes: tab.panes.map((p) => ({ channel: p.channel, accountId: p.accountId }))
    }
    window.sticki.detach(`detached=${encodeURIComponent(JSON.stringify(payload))}`)
    useLayoutStore.getState().closeTab(id)
  }

  return (
    <div className="tabbar">
      <div className="tabbar-tabs" ref={tabsRef}>
      <span
        className="conn-dot"
        title={connState === 'open' ? t('misc.connected') : t('misc.disconnected')}
        style={{ background: connState === 'open' ? 'var(--success)' : 'var(--danger)' }}
      />
      {tabs.map((tab, index) => {
        const hasLive = tab.panes.some((p) => liveChannels[p.channel])
        const hasMention = tab.panes.some((p) => unreadMentions[p.channel])
        const hasUnread = !hasMention && tab.panes.some((p) => unreadMessages[p.channel])
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            className={`tab ${isActive ? 'active' : ''} ${draggingTab === tab.id ? 'dragging' : ''}`}
            onPointerDown={(e) => {
              if (renaming === tab.id) return
              if ((e.target as HTMLElement).closest('.close, input')) return
              if (!tabsRef.current) return
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
            {isActive && tab.panes.length > 0 && (
              <span
                className="close"
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
      <div className="tabbar-actions">
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
    </div>
  )
}
