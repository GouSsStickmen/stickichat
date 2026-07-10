import { useState } from 'react'
import { useLayoutStore } from '../store/layout'
import { useChatStore } from '../store/chat'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { useT } from '../i18n'

// 1x1 transparent canvas — suppresses the native drag ghost so the tab row itself
// (live reorder + colored dragging tab) is the only visual feedback. A canvas is always
// "loaded", unlike an Image, so the very first drag has no fallback rectangle.
const TRANSPARENT_IMG = document.createElement('canvas')
TRANSPARENT_IMG.width = 1
TRANSPARENT_IMG.height = 1

export default function TabBar(): React.JSX.Element {
  const t = useT()
  const tabs = useLayoutStore((s) => s.tabs)
  const activeTabId = useLayoutStore((s) => s.activeTabId)
  const connState = useChatStore((s) => s.connState)
  const liveChannels = useChatStore((s) => s.liveChannels)
  const unreadMentions = useChatStore((s) => s.unreadMentions)
  const unreadMessages = useChatStore((s) => s.unreadMessages)
  const alwaysOnTop = useSettingsStore((s) => s.settings.alwaysOnTop)
  const setSettings = useSettingsStore((s) => s.setSettings)
  const channelNames = useChatStore((s) => s.channelNames)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [draggingTab, setDraggingTab] = useState<string | null>(null)

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
      <div
        className="tabbar-tabs"
        // accept the drag across the WHOLE row (incl. gaps between tabs) — otherwise the
        // cursor flashes a "no drop" sign every time it passes between two tabs
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('sticki/tab')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(e) => {
          if (e.dataTransfer.types.includes('sticki/tab')) e.preventDefault()
        }}
      >
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
            draggable={renaming !== tab.id}
            onDragStart={(e) => {
              e.dataTransfer.setData('sticki/tab', tab.id)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setDragImage(TRANSPARENT_IMG, 0, 0)
              setDraggingTab(tab.id)
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('sticki/tab')) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              // live reorder — but only once the cursor crosses the MIDDLE of the target,
              // otherwise the two tabs keep swapping back and forth at the boundary
              if (draggingTab && draggingTab !== tab.id) {
                const curIdx = tabs.findIndex((x) => x.id === draggingTab)
                if (curIdx === -1) return
                const rect = e.currentTarget.getBoundingClientRect()
                const pastMiddle = e.clientX > rect.left + rect.width / 2
                const shouldMove =
                  (curIdx < index && pastMiddle) || (curIdx > index && !pastMiddle)
                if (shouldMove) useLayoutStore.getState().moveTab(draggingTab, index)
              }
            }}
            onDragEnd={() => setDraggingTab(null)}
            onDrop={(e) => {
              e.preventDefault()
              setDraggingTab(null)
            }}
            onClick={() => activateTab(tab.id)}
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
