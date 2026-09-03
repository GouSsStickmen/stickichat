import { useLayoutEffect, useRef, useState } from 'react'
import { useLayoutStore } from '../store/layout'
import { useChatStore } from '../store/chat'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { useWhispersStore } from '../store/whispers'
import { startPointerReorder, justReordered } from '../lib/pointerReorder'
import { holdConfigSaves, releaseConfigSaves } from '../services/config'
import { buildChannelSeed } from '../lib/detachSeed'
import { useFlip } from '../lib/useFlip'
import WhisperPanel from './WhisperPanel'
import FollowsPanel from './FollowsPanel'
import { useT } from '../i18n'
import { ZoomIcon, MailIcon, SpeakerIcon, PinIcon, GearIcon, HeartIcon } from './Icons'

export default function TabBar(): React.JSX.Element {
  const t = useT()
  const tabs = useLayoutStore((s) => s.tabs)
  const activeTabId = useLayoutStore((s) => s.activeTabId)
  const connState = useChatStore((s) => s.connState)
  const liveChannels = useChatStore((s) => s.liveChannels)
  const openPlayers = useUiStore((s) => s.openPlayers)
  const mutedPlayers = useUiStore((s) => s.mutedPlayers)
  const hint = useSettingsStore((s) => s.settings.tabPlayerHint)
  const followsOpen = useUiStore((s) => s.followsOpen)
  const unreadMentions = useChatStore((s) => s.unreadMentions)
  const unreadKeywords = useChatStore((s) => s.unreadKeywords)
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
  const barRef = useRef<HTMLDivElement>(null)
  const unreadWhispers = useWhispersStore((s) => s.unread)
  const whispersOpen = useUiStore((s) => s.whispersOpen)
  const hypeChannel = useUiStore((s) => (s.hypeTrain?.ended ? null : (s.hypeTrain?.channel ?? null)))

  const activeTab = tabs.find((x) => x.id === activeTabId)

  // FLIP: when the order changes (drag reorder, close, add), every tab glides from its
  // previous position to the new one — the Chrome-tabs feel
  useFlip(tabsRef, '.tab', !!draggingTab)

  /**
   * Publish how tall the bar actually is, as `--tabbar-h` on the root.
   *
   * Toasts and prompts used to sit at a hardcoded `top: 46px` — the height of ONE row of tabs.
   * With four rows they landed on top of the tabs and covered them. Everything that floats
   * below the bar now measures it instead of assuming.
   */
  useLayoutEffect(() => {
    const el = barRef.current
    if (!el) return
    const publish = (): void =>
      document.documentElement.style.setProperty('--tabbar-h', `${Math.round(el.offsetHeight)}px`)
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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
  // filter by live status; 'all' keeps the full list (and normal drag-reorder).
  // PINNED tabs always stay visible regardless of the filter.
  const visibleTabs =
    tabFilter === 'all'
      ? tabs
      : tabs.filter((tab) => tab.pinned || (tabFilter === 'online' ? isLiveTab(tab) : !isLiveTab(tab)))
  const cycleFilter = (): void =>
    setSettings({ tabFilter: tabFilter === 'all' ? 'online' : tabFilter === 'online' ? 'offline' : 'all' })
  const filterIcon =
    tabFilter === 'online' ? (
      '🟢'
    ) : tabFilter === 'offline' ? (
      '⚫'
    ) : (
      // funnel — the conventional "filter" glyph
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5z" />
      </svg>
    )

  return (
    <div className="tabbar" ref={barRef}>
      {/* floated right — must precede the tab flow so rows wrap around it */}
      <div className="tabbar-actions">
      <button className="icon-btn" title={t(`tab.filter.${tabFilter}`)} onClick={cycleFilter}>
        {filterIcon}
      </button>
      <span className="tab-zoom">
        <button className="icon-btn" title={t('tab.zoomOut')} onClick={() => setSettings({ tabScale: Math.max(0.6, Math.round((tabScale - 0.1) * 10) / 10) })}>
          <ZoomIcon dir="out" />
        </button>
        <button className="icon-btn" title={t('tab.zoomIn')} onClick={() => setSettings({ tabScale: Math.min(1.8, Math.round((tabScale + 0.1) * 10) / 10) })}>
          <ZoomIcon dir="in" />
        </button>
      </span>
      {/* Scroll-sync and the column count used to live here, in the tab bar. Both belong to the
          split view, and the tab bar does not exist in a detached window — so a chat pulled out
          into its own window could not be given columns or paired with anything. They sit above
          the chats now, where they are always reachable. */}
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
          <MailIcon />
          {unreadWhispers > 0 && <span className="whisper-badge">{unreadWhispers}</span>}
        </button>
        {whispersOpen && <WhisperPanel onClose={() => useUiStore.getState().setWhispersOpen(false)} />}
      </span>
      <span style={{ position: 'relative' }}>
        <button
          className={`icon-btn ${followsOpen ? 'active' : ''}`}
          title={t('follows.title')}
          onClick={() => useUiStore.getState().setFollowsOpen(!followsOpen)}
        >
          <HeartIcon size={16} />
        </button>
        {followsOpen && <FollowsPanel onClose={() => useUiStore.getState().setFollowsOpen(false)} />}
      </span>
      <button
        className={`icon-btn ${muted ? 'active' : ''}`}
        title={t('set.mute')}
        onClick={() => setSettings({ muted: !muted })}
      >
        <SpeakerIcon muted={muted} />
      </button>
      <button
        className={`icon-btn ${alwaysOnTop ? 'active' : ''}`}
        title={t('set.alwaysOnTop')}
        onClick={() => setSettings({ alwaysOnTop: !alwaysOnTop })}
      >
        <PinIcon />
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
        <GearIcon />
      </button>
      {/* three states, not two: "reconnecting" is the one the user actually needs to see, and
          it used to be indistinguishable from "dead". It pulses so a glance is enough. */}
      <span
        className={`conn-dot ${connState === 'connecting' ? 'reconnecting' : ''}`}
        title={
          connState === 'open'
            ? t('misc.connected')
            : connState === 'connecting'
              ? t('misc.reconnecting')
              : t('misc.disconnected')
        }
        style={{
          background:
            connState === 'open'
              ? 'var(--success)'
              : connState === 'connecting'
                ? 'var(--warning)'
                : 'var(--danger)'
        }}
      />
      </div>
      <div className="tabbar-tabs" ref={tabsRef} style={{ zoom: tabScale }}>
      {visibleTabs.map((tab, index) => {
        const hasLive = tab.panes.some((p) => liveChannels[p.channel])
        const hasPlayer = tab.panes.some((p) => openPlayers.includes(p.channel))
        // muted counts only for a stream that is actually running here
        const tabMuted =
          hasPlayer &&
          tab.panes.every((p) => !openPlayers.includes(p.channel) || mutedPlayers.includes(p.channel))
        const hasMention = tab.panes.some((p) => unreadMentions[p.channel])
        const keywordTag = tab.panes.map((p) => unreadKeywords[p.channel]).find(Boolean)
        const hasUnread = !hasMention && tab.panes.some((p) => unreadMessages[p.channel])
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            data-flipid={tab.id}
            className={`tab ${isActive ? 'active' : ''} ${tab.pinned ? 'pinned' : ''} ${draggingTab === tab.id ? 'dragging' : ''} ${
              hint === 'blink' && hasPlayer ? (tabMuted ? 'blink-muted' : 'blink-playing') : ''
            }`}
            onPointerDown={(e) => {
              if (renaming === tab.id) return
              if ((e.target as HTMLElement).closest('.close, input, .tab-playing')) return
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
                onDragState: (d) => {
                  setDraggingTab(d ? tab.id : null)
                  // every position the tab passes through is a store change, and persisting the
                  // config costs hundreds of milliseconds — see holdConfigSaves. One save, on drop.
                  if (d) holdConfigSaves()
                  else releaseConfigSaves()
                }
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
            onContextMenu={(e) => {
              // RMB: pin/unpin — pinned tabs survive the online/offline filter
              e.preventDefault()
              useLayoutStore.getState().togglePinTab(tab.id)
            }}
            title={t('tab.pinHint')}
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
              {/* a train running in a chat you are not looking at: the popup belongs to the
                  active tab only, so this is the whole signal that one is happening elsewhere */}
              {hypeChannel && !isActive && tab.panes.some((p) => p.channel === hypeChannel) && (
                <span className="hype-tab-dot" title={t('hype.title')}>
                  🚂
                </span>
              )}
              {keywordTag && !isActive && <span className="keyword-tag" title={keywordTag}>{keywordTag}</span>}
              {hasMention && <span className="mention-dot">@</span>}
              {!hasMention && hasUnread && <span className="unread-dot" title={t('tab.newMessage')} />}
            </span>
            {/*
                A player kept running on this tab: it is still playing while you read another one.
                The speaker says whether you can hear it and turns it on and off, red for silence,
                so a stream running in another tab can be shut up without going to it first.

                To the right of the name, and its slot is held open whether or not anything plays.
                A marker that appeared only while a stream ran made the tab wider the moment you
                started one, sliding the detach and close controls out from under a pointer already
                on its way to them: you aimed at ✕ and pressed ⧉. On the left it pushed the name
                away from the edge for nothing, so it sits on this side instead.

                The other way of saying it is the tab blinking in a colour of its own, which needs
                no slot at all and gives that width back.
            */}
            {hint === 'icon' && tab.panes.length > 0 && (
              <button
                className={`tab-playing ${hasPlayer ? '' : 'idle'} ${tabMuted ? 'muted' : ''}`}
                title={hasPlayer ? t(tabMuted ? 'tab.unmute' : 'tab.mute') : undefined}
                tabIndex={hasPlayer ? 0 : -1}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!hasPlayer) return
                  // one press speaks for whatever this tab is playing, however many that is
                  const ui = useUiStore.getState()
                  for (const p of tab.panes) {
                    if (ui.openPlayers.includes(p.channel)) ui.setPlayerMuted(p.channel, !tabMuted)
                  }
                }}
              >
                <SpeakerIcon muted={tabMuted} size={13} />
              </button>
            )}
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
