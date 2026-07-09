import { useState } from 'react'
import { useLayoutStore } from '../store/layout'
import { useChatStore } from '../store/chat'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { useT } from '../i18n'
import { AddPaneForm } from './SplitGrid'

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
  const [renaming, setRenaming] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [draggingTab, setDraggingTab] = useState<string | null>(null)
  const [dragOverTab, setDragOverTab] = useState<string | null>(null)

  const activeTab = tabs.find((x) => x.id === activeTabId)

  const tabLabel = (id: string): string => {
    const tab = tabs.find((x) => x.id === id)
    if (!tab) return ''
    if (tab.name) return tab.name
    if (tab.panes.length === 0) return t('tab.new')
    return tab.panes.map((p) => p.channel).join(' · ')
  }

  const activateTab = (id: string): void => {
    useLayoutStore.getState().setActiveTab(id)
    const tab = useLayoutStore.getState().tabs.find((x) => x.id === id)
    if (tab) {
      const channels = tab.panes.map((p) => p.channel)
      useChatStore.getState().clearUnreadMentions(channels)
      useChatStore.getState().clearUnreadMessages(channels)
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
      <div className="tabbar-tabs">
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
            className={`tab ${isActive ? 'active' : ''} ${draggingTab === tab.id ? 'dragging' : ''} ${
              dragOverTab === tab.id && draggingTab && draggingTab !== tab.id ? 'drag-over' : ''
            }`}
            draggable={renaming !== tab.id}
            onDragStart={(e) => {
              e.dataTransfer.setData('sticki/tab', tab.id)
              e.dataTransfer.effectAllowed = 'move'
              setDraggingTab(tab.id)
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('sticki/tab')) {
                e.preventDefault()
                if (dragOverTab !== tab.id) setDragOverTab(tab.id)
              }
            }}
            onDragLeave={() => setDragOverTab((cur) => (cur === tab.id ? null : cur))}
            onDragEnd={() => {
              setDraggingTab(null)
              setDragOverTab(null)
            }}
            onDrop={(e) => {
              const dragged = e.dataTransfer.getData('sticki/tab')
              setDraggingTab(null)
              setDragOverTab(null)
              if (dragged && dragged !== tab.id) {
                e.preventDefault()
                useLayoutStore.getState().moveTab(dragged, index)
              }
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
            {hasMention && <span className="mention-dot">@</span>}
            {hasUnread && <span className="unread-dot" title={t('tab.newMessage')} />}
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
      {activeTab && (
        <div style={{ position: 'relative', display: 'flex', gap: 5, alignItems: 'center' }}>
          <button className="icon-btn" style={{ fontSize: 12 }} onClick={() => setAddOpen((v) => !v)}>
            + {t('pane.add')}
          </button>
          {activeTab.panes.length > 1 && (
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
          {addOpen && (
            <div className="popover" style={{ top: '100%', right: 0, marginTop: 6 }}>
              <AddPaneForm tabId={activeTab.id} onDone={() => setAddOpen(false)} />
            </div>
          )}
        </div>
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
