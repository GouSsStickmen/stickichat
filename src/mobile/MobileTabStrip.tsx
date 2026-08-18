import React, { useEffect, useState } from 'react'
import { useLayoutStore } from '@renderer/store/layout'
import { useAccountsStore } from '@renderer/store/accounts'
import { useUiStore } from '@renderer/store/ui'
import { useChatStore } from '@renderer/store/chat'
import { useSettingsStore } from '@renderer/store/settings'
import { openTwitchLogin, twitchSessionActive } from './MobilePlayer'
import { Tab } from '@renderer/types'

/**
 * The tab strip, for a thumb.
 *
 * The desktop version wraps thirty tabs over five rows, which works with a mouse and a big screen
 * and nowhere else. Here it is one scrolling row: the active tab is always brought into view, and
 * closing lives behind a long press rather than an ✕ per tab, because an ✕ that small is a
 * mis-tap waiting to happen next to the tab you actually wanted.
 */
/** a tab keeps no name until it is renamed; until then it is whatever channel it holds */
function label(t: Tab): string {
  return t.name || t.panes[0]?.channel || 'чат'
}

export default function MobileTabStrip({
  playing,
  onTogglePlayer
}: {
  /** channel currently playing, so the button can show it is on */
  playing: string | null
  onTogglePlayer: (channel: string) => void
}): React.JSX.Element {
  const tabs = useLayoutStore((s) => s.tabs)
  const activeTabId = useLayoutStore((s) => s.activeTabId)
  const accounts = useAccountsStore((s) => s.accounts)
  /*
   * The same three signals the desktop tab bar shows, which a phone needs more rather than less:
   * with one channel visible at a time, an unmarked tab is the only thing standing between you and
   * missing a reply.
   */
  const unreadMentions = useChatStore((s) => s.unreadMentions)
  const unreadKeywords = useChatStore((s) => s.unreadKeywords)
  const unreadMessages = useChatStore((s) => s.unreadMessages)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [channel, setChannel] = useState('')
  /** set when the sheet was opened to split an existing tab rather than to make a new one */
  const [splitInto, setSplitInto] = useState<string | null>(null)
  /** the ⋮ menu: filter, search, settings and the buttons that used to crowd the strip */
  const [menuOpen, setMenuOpen] = useState(false)
  const [search, setSearch] = useState('')
  const tabFilter = useSettingsStore((s) => s.settings.tabFilter)
  const liveChannels = useChatStore((s) => s.liveChannels)
  const [twitchSession, setTwitchSession] = useState(false)
  useEffect(() => {
    if (menuOpen) void twitchSessionActive().then(setTwitchSession)
  }, [menuOpen])

  /**
   * Adding a channel is its own sheet rather than a reused desktop dialog.
   *
   * The desktop has no such dialog to reuse: there it is a popover hanging off the tab bar, sized
   * and positioned for a mouse. What is shared is the part that matters — `addPane`, which is the
   * same store action either way.
   *
   * No account is needed to get here: `addPane` takes a null account and IRC connects anonymously.
   */
  /** switching to a tab is also reading it — same as the desktop bar does */
  const activate = (id: string): void => {
    useLayoutStore.getState().setActiveTab(id)
    const tab = useLayoutStore.getState().tabs.find((x) => x.id === id)
    if (!tab) return
    const channels = tab.panes.map((p) => p.channel)
    useChatStore.getState().clearUnreadMentions(channels)
    useChatStore.getState().clearUnreadKeywords(channels)
    useChatStore.getState().clearUnreadMessages(channels)
    useChatStore.getState().markChannelsRead(channels)
  }

  const openAdd = (): void => {
    setSplitInto(null)
    setAdding(true)
  }

  /**
   * A channel gets its own tab.
   *
   * On the desktop a tab is a workspace holding several panes side by side, because there is room
   * for that. On a phone the tab strip is the channel switcher — one tap, one channel — and a split
   * is the rarer thing, asked for explicitly through a tab's own menu.
   */
  const submitAdd = (): void => {
    const login = channel.trim().toLowerCase().replace(/^@|^https?:\/\/(www\.)?twitch\.tv\//i, '')
    if (!login) return
    const store = useLayoutStore.getState()
    const tabId = splitInto ?? store.addTab(login)
    store.addPane(tabId, login, accounts[0]?.id ?? null)
    if (!splitInto) store.setActiveTab(tabId)
    setChannel('')
    setAdding(false)
    setSplitInto(null)
  }

  /*
   * What the strip actually shows: the filter first, then the search box if anything is typed in it.
   * Pinned tabs ignore the filter, the same rule the desktop bar uses — a tab you pinned is one you
   * asked to always see.
   */
  const isLive = (t: Tab): boolean => t.panes.some((p) => liveChannels[p.channel])
  const q = search.trim().toLowerCase()
  const shownTabs = tabs
    .filter((t) => tabFilter === 'all' || t.pinned || (tabFilter === 'online' ? isLive(t) : !isLive(t)))
    .filter((t) => !q || label(t).toLowerCase().includes(q) || t.panes.some((p) => p.channel.includes(q)))

  // Escape is what Android's back button dispatches — see the handler in MobileApp
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setMenuFor(null)
      setAdding(false)
      setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <div className="m-tabs">
        <div className="m-tabs-scroll">
          {shownTabs.map((t) => (
            <button
              key={t.id}
              className={`m-tab ${t.id === activeTabId ? 'active' : ''}`}
              ref={(el) => {
                if (el && t.id === activeTabId) el.scrollIntoView({ block: 'nearest', inline: 'center' })
              }}
              onClick={() => activate(t.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenuFor(t.id)
              }}
            >
              {label(t)}
              {t.panes.length > 1 && <span className="m-tab-count">{t.panes.length}</span>}
              {(() => {
                const mention = t.panes.some((p) => unreadMentions[p.channel])
                const keyword = t.panes.map((p) => unreadKeywords[p.channel]).find(Boolean)
                const unread = !mention && t.panes.some((p) => unreadMessages[p.channel])
                const inactive = t.id !== activeTabId
                return (
                  <>
                    {mention && <span className="mention-dot">@</span>}
                    {keyword && inactive && (
                      <span className="keyword-tag" title={keyword}>
                        {keyword}
                      </span>
                    )}
                    {unread && inactive && <span className="unread-dot" />}
                  </>
                )
              })()}
            </button>
          ))}
        </div>
        {/*
          One button, not four.
          A 411px strip was carrying ▶, +, ⋮ and the tabs themselves, so the tabs had about half the
          width. Everything that is not a tab now lives behind the ⋮ — which is also where a filter and
          a search box can exist at all, neither of which had anywhere to go before.
        */}
        <button className="m-tabs-menu" onClick={() => setMenuOpen(true)} title="Меню">
          ⋮
        </button>
      </div>

      {menuOpen && (
        <div className="m-sheet-back m-menu-back" onClick={() => setMenuOpen(false)}>
          <div className="m-menu" onClick={(e) => e.stopPropagation()}>
            <input
              className="m-input"
              value={search}
              placeholder="Пошук каналу"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              onChange={(e) => setSearch(e.target.value)}
            />

            <div className="m-menu-filter">
              {(
                [
                  ['all', 'Усі'],
                  ['online', '🟢 Онлайн'],
                  ['offline', '⚫ Офлайн']
                ] as ['all' | 'online' | 'offline', string][]
              ).map(([key, text]) => (
                <button
                  key={key}
                  className={tabFilter === key ? 'on' : ''}
                  onClick={() => useSettingsStore.getState().setSettings({ tabFilter: key })}
                >
                  {text}
                </button>
              ))}
            </div>

            <button
              onClick={() => {
                setMenuOpen(false)
                openAdd()
              }}
            >
              ＋ Додати канал
            </button>

            {(() => {
              const active = tabs.find((t) => t.id === activeTabId)
              const ch = active?.panes[0]?.channel
              if (!ch) return null
              return (
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    onTogglePlayer(ch)
                  }}
                >
                  {playing === ch ? '■ Прибрати стрім' : '▶ Показати стрім'}
                </button>
              )
            })()}

            {/*
              The web session, which is a different thing from the account the app is signed in with:
              this one is what the embedded player sees, and the only reason it exists is that a
              subscriber watching logged-out still gets pre-roll ads.
            */}
            <button
              onClick={() => {
                setMenuOpen(false)
                void openTwitchLogin()
              }}
            >
              {twitchSession ? '🔓 Плеєр: вхід виконано' : '🔒 Вхід у Twitch для плеєра'}
            </button>

            <button
              onClick={() => {
                setMenuOpen(false)
                useUiStore.getState().setSettingsOpen(true)
              }}
            >
              ⚙ Налаштування
            </button>
          </div>
        </div>
      )}

      {adding && (
        <div className="m-sheet-back" onClick={() => setAdding(false)}>
          <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="m-sheet-title">
              {splitInto ? 'Додати чат у цю вкладку' : 'Новий канал'}
            </div>
            <input
              className="m-input"
              autoFocus
              value={channel}
              placeholder="нік каналу"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              // the browser's saved-value dropdown is drawn by the system, over the keyboard
              autoComplete="off"
              onChange={(e) => setChannel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitAdd()
              }}
            />
            <button className="primary" onClick={submitAdd}>
              Відкрити чат
            </button>
          </div>
        </div>
      )}

      {/* long press on a tab: the things an ✕ and a right-click did on the desktop */}
      {menuFor && (
        <div className="m-sheet-back" onClick={() => setMenuFor(null)}>
          <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="m-sheet-title">{(() => { const t = tabs.find((x) => x.id === menuFor); return t ? label(t) : '' })()}</div>
            <button
              onClick={() => {
                setSplitInto(menuFor)
                setMenuFor(null)
                setAdding(true)
              }}
            >
              ⬓ Розділити — ще один чат тут
            </button>
            <button
              onClick={() => {
                useLayoutStore.getState().togglePinTab(menuFor)
                setMenuFor(null)
              }}
            >
              📌 Закріпити / відкріпити
            </button>
            <button
              className="danger"
              onClick={() => {
                useLayoutStore.getState().closeTab(menuFor)
                setMenuFor(null)
              }}
            >
              ✕ Закрити вкладку
            </button>
          </div>
        </div>
      )}
    </>
  )
}
