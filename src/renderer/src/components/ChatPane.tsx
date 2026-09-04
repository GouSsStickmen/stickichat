import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MESSAGE_ONLY_TYPES, MOD_ONLY_TYPES, Pane } from '../types'
import { useChatStore, lookupUserBadges } from '../store/chat'
import { useAccountsStore } from '../store/accounts'
import { getUsers } from '../lib/helix'
import { useLayoutStore } from '../store/layout'
import { useSettingsStore } from '../store/settings'
import { canModerate } from '../services/accountService'
import { loadTwitchUserEmotes } from '../services/emoteService'
import { openUserCard } from '../lib/openUserCard'
import { hotkeyFor, matchHotkey, matchHoldKey } from '../lib/hotkeys'
import MessageList from './MessageList'
import InputBox, { ReplyTarget } from './InputBox'
import ModToolbar from './ModToolbar'
import { useUiStore } from '../store/ui'
import { claimBonus, pressShare } from '../lib/playerPage'
import RewardsPanel from './RewardsPanel'
import DropsPanel from './DropsPanel'
import PagePollCard from './PagePollCard'
import ChattersList from './ChattersList'
import HighlightSidebar from './HighlightSidebar'
import { AddPaneForm } from './SplitGrid'
import { startPointerReorder } from '../lib/pointerReorder'
import { useT } from '../i18n'
import { EyeIcon, ClockIcon, GameIcon, StarIcon } from './Icons'

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime()
  if (ms <= 0) return '0:00:00'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

/** when it started, in the reader's own clock, for the tooltip on the counter */
function startedAtLabel(startedAt: string): string {
  const d = new Date(startedAt)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('uk-UA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export default function ChatPane({ tabId, pane }: { tabId: string; pane: Pane }): React.JSX.Element {
  const t = useT()
  const channelId = useChatStore((s) => s.channelIds[pane.channel] ?? '')
  const isLive = useChatStore((s) => !!s.liveChannels[pane.channel])
  const channelName = useChatStore((s) => s.channelNames[pane.channel])
  const streamInfo = useChatStore((s) => s.streamInfo[pane.channel])
  const showStreamInfo = useSettingsStore((s) => s.settings.showStreamInfo)
  /**
   * Publish the header's height as `--panehead-h`, the second half of where floating things
   * start (see --notif-top). A toast pinned only below the TAB bar still landed on the pane's
   * own buttons — the header sits between them and the chat.
   */
  const headRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = headRef.current
    if (!el) return
    const publish = (): void =>
      document.documentElement.style.setProperty('--panehead-h', `${Math.round(el.offsetHeight)}px`)
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // once a second, because the counter shows seconds now
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!streamInfo) return
    const id = window.setInterval(() => forceTick((v) => v + 1), 1000)
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
  const hasToolbarButtons = modButtons.some(
    (b) => b.scope === 'toolbar' && !MOD_ONLY_TYPES.has(b.type) && !MESSAGE_ONLY_TYPES.has(b.type)
  )
  const showHighlightSidebar = useSettingsStore((s) => s.settings.showHighlightSidebar)
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null)
  const [chattersOpen, setChattersOpen] = useState(false)
  const [addPaneOpen, setAddPaneOpen] = useState(false)
  // fixed-position anchor: the pane clips absolute popovers (overflow:hidden), so in a
  // narrow window the "add chat" form used to lose its channel input off-screen
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const [addPanePos, setAddPanePos] = useState<{ top: number; right: number } | null>(null)
  const [scrollLocked, setScrollLocked] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editPos, setEditPos] = useState<{ top: number; right: number } | null>(null)
  const editBtnRef = useRef<HTMLButtonElement>(null)
  const [dragging, setDragging] = useState(false)
  const paneCount = useLayoutStore((s) => s.tabs.find((x) => x.id === tabId)?.panes.length ?? 1)
  // opt-in: a split view starts with every chat scrolling on its own
  const paneSynced = pane.syncScroll === true
  const [searchOpen, setSearchOpen] = useState(false)
  /** per pane and per session: which channel you want to watch changes constantly */
  const channelPlaying = useUiStore((s) => s.openPlayers.includes(pane.channel))
  /*
   * One pane per channel gets the player, and it is the first of them.
   *
   * There is one player per channel and every pane showing that channel was publishing where it
   * wanted it, five times a second: with the same stream open twice in a split, the player was
   * dragged between the two holes and flickered. The first pane in the layout owns it; a second
   * copy of the same chat is a chat and nothing else.
   */
  const ownsPlayer = useLayoutStore((s) => {
    // this tab's panes, not the whole layout: the same channel sitting in some other tab is not
    // on screen at the same time, and counting it there left the visible pane unable to open a
    // player at all
    const tab = s.tabs.find((t) => t.id === tabId)
    const first = tab?.panes.find((p) => p.channel === pane.channel)
    return !first || first.id === pane.id
  })
  const playerOpen = channelPlaying && ownsPlayer
  const setPlayerOpen = (on: boolean): void =>
    useUiStore.getState().togglePlayer(pane.channel, on)
  const slotRef = useRef<HTMLDivElement>(null)
  const playerSide = useSettingsStore((s) => s.settings.playerSideBySide)
  /*
   * The split's own sizes, per pane, with the settings as the default.
   *
   * They were read straight from the settings, which made them one size for the whole app: in a
   * split, pulling one chat's edge to give one stream more room pulled every other chat with it.
   * The drag writes to the pane now; the settings are what a pane that has never been dragged
   * starts out at.
   */
  const defaultPlayerHeight = useSettingsStore((s) => s.settings.playerHeight)
  const defaultChatWidth = useSettingsStore((s) => s.settings.chatWidth)
  const playerHeight = pane.playerHeight ?? defaultPlayerHeight
  const chatWidth = pane.chatWidth ?? defaultChatWidth
  const sideBySide = playerOpen && playerSide

  /*
   * Dragging the player's edge. Position, not delta, so it cannot drift; the listeners go on in
   * the pointerdown handler rather than in an effect, because an effect runs after the render and
   * would miss a pointerup that arrives in the same tick.
   */
  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const vertical = !playerSide
    const box = splitRef.current?.getBoundingClientRect()
    const right = box?.right ?? window.innerWidth
    const boxTop = box?.top ?? 0
    const boxHeight = box?.height ?? 900
    document.body.classList.add('dragging-split')
    const onMove = (ev: PointerEvent): void => {
      if (vertical) {
        // the chat keeps at least a quarter of the pane whatever the pointer says
        const ceiling = Math.max(160, Math.round(boxHeight * 0.75))
        const next = Math.max(120, Math.min(ceiling, Math.round(ev.clientY - boxTop)))
        useLayoutStore.getState().updatePane(tabId, pane.id, { playerHeight: next })
      } else {
        const next = Math.max(220, Math.min(Math.round(right - 240), Math.round(right - ev.clientX)))
        useLayoutStore.getState().updatePane(tabId, pane.id, { chatWidth: next })
      }
    }
    const stop = (): void => {
      document.body.classList.remove('dragging-split')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }
  /*
   * How big the split actually is, so the saved sizes can be kept inside it.
   *
   * chatWidth and playerHeight are saved in pixels, and the drag keeps them sensible; making the
   * window smaller does not. A chat that was 900px wide in a wide window covered the player
   * completely in a narrow one, with no grip left to drag back. So the saved size is a wish, and
   * what is used is that wish trimmed to what is here.
   */
  const [splitBox, setSplitBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = splitRef.current
    if (!el) return
    const watch = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setSplitBox((old) =>
        Math.abs(old.w - r.width) < 2 && Math.abs(old.h - r.height) < 2
          ? old
          : { w: Math.round(r.width), h: Math.round(r.height) }
      )
    })
    watch.observe(el)
    return () => watch.disconnect()
  }, [playerOpen])
  // the player keeps 240px across and 140px down, whatever the saved sizes say
  const fitChat = splitBox.w > 0 ? Math.max(200, Math.min(chatWidth, splitBox.w - 240)) : chatWidth
  const fitPlayer =
    splitBox.h > 0 ? Math.max(120, Math.min(playerHeight, splitBox.h - 140)) : playerHeight

  /*
   * Keep a popover inside the window once it has a size.
   *
   * These are placed by their distance from the right edge, measured off the button that opened
   * them. In a narrow split that button is itself near the left edge, and a 238px form anchored to
   * it started at -70: the channel field was off screen with no way to reach it. Nothing can be
   * worked out before the thing is laid out, so it is nudged after.
   *
   * The nudge is written straight onto the element rather than into state. State fed the effect
   * that set it, and the two took turns until React gave up with "maximum update depth exceeded"
   * and the whole app went blank.
   */
  const keepInside = (el: HTMLDivElement | null): void => {
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width === 0) return
    if (r.left < 8) el.style.right = `${Math.max(8, window.innerWidth - 8 - r.width)}px`
    if (r.bottom > window.innerHeight - 8) {
      el.style.top = `${Math.max(8, window.innerHeight - 8 - r.height)}px`
    }
  }
  const addPopRef = useRef<HTMLDivElement>(null)
  const editPopRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    keepInside(addPopRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addPaneOpen])
  useLayoutEffect(() => {
    keepInside(editPopRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editOpen])

  const latency = useUiStore((s) => s.streamLatency[pane.channel])
  const points = useUiStore((s) => s.playerPoints[pane.channel])
  const drops = useUiStore((s) => s.playerDrops[pane.channel])
  const share = useUiStore((s) => s.playerShare[pane.channel])
  const shareTucked = useUiStore((s) => s.shareTucked[pane.channel] ?? false)
  const dropsGot = useUiStore((s) => s.dropsGot[pane.channel]) ?? []
  const pagePolls = useUiStore((s) => s.pagePolls[pane.channel])
  const pollHidden = useUiStore((s) => s.pagePollHidden[pane.channel] ?? false)
  const [rewardsOpen, setRewardsOpen] = useState(false)
  const [dropsOpen, setDropsOpen] = useState(false)
  /*
   * A flash of "+N" whenever the balance grows.
   *
   * Points arrive quietly: watching a stream tops them up every few minutes and a claimed chest
   * adds a lump, and the only sign was a number that happened to be bigger the next time you
   * looked. The gain is worked out from our own last reading, so it counts everything, however it
   * arrived, and it is only shown while a player is actually feeding us readings.
   */
  const [gain, setGain] = useState(0)
  const lastPoints = useRef<number | null>(null)
  const balance = points?.balance ?? null
  useEffect(() => {
    const before = lastPoints.current
    lastPoints.current = balance
    if (before === null || balance === null || balance <= before) return
    setGain(balance - before)
    const done = window.setTimeout(() => setGain(0), 3200)
    return () => window.clearTimeout(done)
  }, [balance])

  /*
   * Where the hole is, republished on a slow tick.
   *
   * Polling rather than observing: the slot moves for a dozen unrelated reasons (a tab bar that
   * wrapped, the mod toolbar appearing, a resized window, a changed layout), and chasing each one
   * with its own listener would be a list that is never quite complete. Five times a second is
   * imperceptible and costs a getBoundingClientRect.
   */
  useEffect(() => {
    if (!playerOpen) {
      useUiStore.getState().setPlayerSlot(pane.channel, null)
      return
    }
    const publish = (): void => {
      const el = slotRef.current
      const box = splitRef.current
      if (!el || !box) return
      const r = el.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      useUiStore.getState().setPlayerSlot(pane.channel, {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        boxRight: Math.round(b.right),
        boxHeight: Math.round(b.height)
      })
    }
    publish()
    const id = window.setInterval(publish, 200)
    return () => {
      window.clearInterval(id)
      // the pane is going away, so the player parks itself rather than hanging over the next tab
      useUiStore.getState().setPlayerSlot(pane.channel, null)
    }
  }, [playerOpen, pane.channel])
  /** the split box is the stable thing to measure a drag against; the player's own edge moves */
  const splitRef = useRef<HTMLDivElement>(null)

  /*
   * The detached window asking to come back. It broadcasts its channel rather than addressing a
   * pane, because it has no idea which pane, or which window, it came from.
   */
  useEffect(() => {
    return window.sticki.onReturnStream((ch) => {
      if (ch.toLowerCase() === pane.channel.toLowerCase()) setPlayerOpen(true)
    })
  }, [pane.channel])
  // hold-to-pause: chat is paused only while the hotkey is held down (separate from the toggle)
  const [holdPaused, setHoldPaused] = useState(false)
  const keydownHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null)
  const keyupHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null)

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
      openUserCard({
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
      const s = useSettingsStore.getState().settings
      // physical key, not the produced character — works on the Ukrainian layout too
      if (matchHotkey(e, hotkeyFor(s, 'scrollLock'))) {
        e.preventDefault()
        setScrollLocked((v) => !v)
      }
      // Ctrl+F — search messages & nicks in this pane (e.code works on any layout)
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') {
        e.preventDefault()
        setSearchOpen(true)
      }
      // hold-to-pause: pause while the key is held (keydown repeats — setState is idempotent)
      if (matchHoldKey(e, hotkeyFor(s, 'pauseHold'))) setHoldPaused(true)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (matchHoldKey(e, hotkeyFor(useSettingsStore.getState().settings, 'pauseHold'))) {
        setHoldPaused(false)
      }
    }
    keydownHandlerRef.current = onKey
    keyupHandlerRef.current = onKeyUp
    document.addEventListener('keydown', onKey)
    document.addEventListener('keyup', onKeyUp)
  }
  const unbindHotkeys = (): void => {
    if (keydownHandlerRef.current) {
      document.removeEventListener('keydown', keydownHandlerRef.current)
      keydownHandlerRef.current = null
    }
    if (keyupHandlerRef.current) {
      document.removeEventListener('keyup', keyupHandlerRef.current)
      keyupHandlerRef.current = null
    }
    // leaving the pane while holding the key would otherwise leave it stuck paused
    setHoldPaused(false)
  }

  return (
    <div
      className="pane"
      // the channel this pane shows, so things drawn outside it (the hype train popup) can find it
      data-channel={pane.channel}
      onMouseEnter={bindHotkeys}
      onMouseLeave={unbindHotkeys}
    >
      <div
        className={`pane-header ${dragging ? 'dragging' : ''}`}
        ref={headRef}
        onPointerDown={(e) => {
          // buttons, the channel name and anything else interactive keep their own behaviour
          if ((e.target as HTMLElement).closest('button, input, select, a, .channel-name')) return
          const grid = headRef.current?.closest('.split-grid') as HTMLElement | null
          if (!grid) return
          const panes = useLayoutStore.getState().tabs.find((x) => x.id === tabId)?.panes ?? []
          if (panes.length < 2) return
          startPointerReorder({
            e,
            container: grid,
            itemSelector: '.pane',
            index: panes.findIndex((x) => x.id === pane.id),
            // a split grid wraps, so dragging is not one-dimensional the way a tab strip is
            axis: 'both',
            onMove: (_from, to) => useLayoutStore.getState().movePane(tabId, pane.id, to),
            onDragState: setDragging
          })
        }}
      >
        <span
          className="channel-name clickable"
          title={t('pane.openStreamerCard')}
          onClick={(e) => {
            if (!channelId) return
            openUserCard({
              channel: pane.channel,
              channelId,
              userId: channelId, // the broadcaster's user id equals the channel id
              login: pane.channel,
              displayName: channelName ?? pane.channel,
              badges: lookupUserBadges(pane.channel, pane.channel) ?? [],
              accountId: pane.accountId,
              x: e.clientX,
              y: e.clientY
            })
          }}
          onContextMenu={(e) => {
            // RMB: insert the streamer's nick into the input · Ctrl+RMB: copy it
            e.preventDefault()
            if (e.ctrlKey) {
              window.sticki.copyText(pane.channel).catch(() => {})
            } else {
              window.dispatchEvent(
                new CustomEvent('sticki:insert', { detail: { paneId: pane.id, text: `@${pane.channel} ` } })
              )
            }
          }}
        >
          {channelName ?? pane.channel}
        </span>
        {isLive && <span className="live-badge">{t('pane.live')}</span>}
        <RoomModeTags channel={pane.channel} />
        {isMod && (
          <span className={`mod-badge ${isBroadcaster ? 'broadcaster' : ''}`}>
            {isBroadcaster ? t('mod.youAreBroadcaster') : t('mod.youAreMod')}
          </span>
        )}
        {showStreamInfo && streamInfo && (
          <span className="stream-info" title={streamInfo.title}>
            <span className="si-icon"><EyeIcon size={13} /></span> {streamInfo.viewers.toLocaleString('uk-UA')} ·{' '}
            <span className="si-icon"><ClockIcon size={13} /></span>{' '}
            <span title={startedAtLabel(streamInfo.startedAt)}>
              {formatUptime(streamInfo.startedAt)}
            </span>
            {streamInfo.title ? ` · ${streamInfo.title}` : ''}
          </span>
        )}
        <div className="spacer" />
        <span>
          <button
            ref={addBtnRef}
            className="icon-btn"
            title={t('pane.add')}
            onClick={() => {
              const r = addBtnRef.current?.getBoundingClientRect()
              if (r) setAddPanePos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) })
              setAddPaneOpen((v) => !v)
            }}
          >
            +
          </button>
          {addPaneOpen && (
            <div
              ref={addPopRef}
              className="popover add-pane-pop"
              style={{ position: 'fixed', top: addPanePos?.top ?? 40, right: addPanePos?.right ?? 8 }}
              onDragStart={(e) => e.stopPropagation()}
            >
              <AddPaneForm tabId={tabId} onDone={() => setAddPaneOpen(false)} />
            </div>
          )}
        </span>
        <span>
          <button
            ref={editBtnRef}
            className="icon-btn"
            title={t('pane.changeChannel')}
            onClick={() => {
              const r = editBtnRef.current?.getBoundingClientRect()
              if (r) setEditPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) })
              setEditOpen((v) => !v)
            }}
          >
            ✎
          </button>
          {editOpen && (
            <div
              ref={editPopRef}
              className="popover add-pane-pop"
              style={{ position: 'fixed', top: editPos?.top ?? 40, right: editPos?.right ?? 8 }}
            >
              <AddPaneForm tabId={tabId} editPane={pane} onDone={() => setEditOpen(false)} />
            </div>
          )}
        </span>
        {paneCount > 1 && (
          <button
            className={`icon-btn ${paneSynced ? 'on' : ''}`}
            title={t(paneSynced ? 'pane.syncMemberOn' : 'pane.syncMemberOff')}
            onClick={() =>
              useLayoutStore.getState().updatePane(tabId, pane.id, { syncScroll: !paneSynced })
            }
          >
            {paneSynced ? '🔗' : '⛓️‍💥'}
          </button>
        )}
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
          onClick={() => {
            if (useSettingsStore.getState().settings.highlightsAsWindow) {
              window.sticki.openHighlightsWindow(`highlights=${encodeURIComponent(pane.channel)}`)
            } else {
              useSettingsStore.getState().setSettings({ showHighlightSidebar: !showHighlightSidebar })
            }
          }}
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
          className={`icon-btn ${playerOpen ? 'active' : ''}`}
          disabled={!ownsPlayer}
          title={
            !ownsPlayer ? t('player.inOtherPane') : playerOpen ? t('player.hide') : t('player.show')
          }
          onClick={() => {
            const next = !playerOpen
            setPlayerOpen(next)
            // the caveats are worth saying once, and once only — the toast carries its own mute key
            if (next) {
              useUiStore.getState().toast(t('player.notice'), 'ok', { muteKey: 'player-notice', ms: 14000 })
            }
          }}
        >
          ▶
        </button>
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
      {((showStreamInfo && streamInfo?.game) || latency !== null && latency !== undefined) && (
        <div className="pane-subheader" title={streamInfo?.game}>
          {showStreamInfo && streamInfo?.game && (
            <>
              <span className="si-icon"><GameIcon size={13} /></span> {streamInfo.game}
            </>
          )}
          {/* the delay sits with the other facts about the stream, not painted over the picture */}
          {latency !== null && latency !== undefined && (
            <span
              className={`pane-latency ${latency > 30 ? 'bad' : latency > 12 ? 'warn' : ''}`}
              title={t('player.latencyHint')}
            >
              {t('player.latency', { s: latency.toFixed(1) })}
            </span>
          )}
        </div>
      )}
      {searchOpen && <ChatSearch channel={pane.channel} onClose={() => setSearchOpen(false)} />}
      {(isMod || hasToolbarButtons) && account && (
        <ModToolbar pane={pane} account={account} channelId={channelId} isMod={isMod} />
      )}
      {/*
        Two arrangements of the same two things, in ONE tree for both arrangements, and the player keeps the same parent in each.
        Rendering the two layouts as separate branches meant React tore the webview down and
        built a new one every time the layout changed, which restarts the stream and loses the
        volume with it. Only the classes change now, so the player never unmounts.
      */}
      <div className={`pane-split ${sideBySide ? 'is-side' : 'is-stacked'}`} ref={splitRef}>
        {/*
          A hole, not a player. The player itself is drawn by PlayerLayer, above the app, so that
          looking at another tab does not tear it down and start the stream (and its advert) over.
          This div only reserves the space and reports where it is.
        */}
        {playerOpen && (
          <div
            className={`player-slot ${sideBySide ? 'is-side' : ''}`}
            ref={slotRef}
            style={sideBySide ? undefined : { height: fitPlayer }}
          />
        )}
        {/*
          The grip sits between the two, not on top of either.
          Anywhere over the video it steals the pointer, and a webview never hands it back, so
          Twitch concluded the mouse had left and hid its controls exactly as you reached for the
          settings gear in the corner. As its own bar it cannot overlap the picture at all.
        */}
        {playerOpen && (
          <div
            className={sideBySide ? 'split-grip-x' : 'split-grip-y'}
            onPointerDown={startResize}
          />
        )}
        <div className="pane-chat-col" style={sideBySide ? { width: fitChat } : undefined}>
          {/* the channel's running poll or prediction, above the messages and only as wide as the
              chat, since that is the column it belongs to. Tucked away it lives as a button in the
              points row instead */}
          {!pollHidden && <PagePollCard channel={pane.channel} />}
          <div className="pane-body">
            <MessageList
              pane={pane}
              account={account}
              channelId={channelId}
              isMod={isMod}
              onReply={onReply}
              scrollLocked={scrollLocked || holdPaused}
            />
            {showHighlightSidebar && <HighlightSidebar channel={pane.channel} />}
          </div>
          {/*
            Twitch's own "share this" card, brought out of the page it lives in.

            It shows up when something has just happened to you on the channel: a streak taken, a
            subscription reward. Above the input, which is where their own card sits, and it closes
            for good once it has been shared or dismissed — pressing it posts the line to chat as
            you, so it is only ever pressed from a press here.
          */}
          {share && !shareTucked && (
            <div className="share-card">
              <span className="sc-what">
                <b>{share.title}</b>
                {share.note && <span className="sc-note">{share.note}</span>}
              </span>
              <button
                className="primary"
                onClick={() => {
                  void pressShare(pane.channel)
                  useUiStore.getState().dismissShare(pane.channel)
                }}
              >
                {t('player.share')}
              </button>
              {/* out of the way, not turned down: it goes into the icon beside the rewards */}
              <button
                className="ghost sc-x"
                title={t('player.shareTuck')}
                onClick={() => useUiStore.getState().tuckShare(pane.channel, true)}
              >
                ✕
              </button>
            </div>
          )}
          <InputBox
            tabId={tabId}
            pane={pane}
            account={account}
            channelId={channelId}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
          />
          {/*
            Channel points sit under the input, the way they do on Twitch itself, and only while a
            player is open, because that page is where they come from. In the flow of the column
            rather than floating over it, so the row can never end up on top of the last message,
            and the rewards window opens upward out of the row it belongs to.
          */}
          {points && (
            <div className="points-dock">
              {rewardsOpen && (
                <RewardsPanel channel={pane.channel} onClose={() => setRewardsOpen(false)} />
              )}
              {dropsOpen && (
                <DropsPanel channel={pane.channel} onClose={() => setDropsOpen(false)} />
              )}
              <div className="points-bar">
                {points.icon ? (
                  <img className="pb-icon" src={points.icon} alt="" />
                ) : (
                  <span className="pb-icon pb-dot">◉</span>
                )}
                <span
                  className={`pb-value ${gain > 0 ? 'gained' : ''}`}
                  title={points.streak ? t('points.hintStreak', { n: points.streak }) : t('points.hint')}
                >
                  {points.balanceText ??
                    (points.balance === null ? '...' : points.balance.toLocaleString('uk-UA'))}
                </span>
                {/*
                  The gain has a slot of its own, always there and empty most of the time.
                  Sitting in the flow it shoved the rewards button aside every time points landed,
                  and floating over the row it landed ON that button and could not be read.
                */}
                <span className={`pb-gain ${gain > 0 ? 'show' : ''}`}>
                  {gain > 0 ? `+${gain.toLocaleString('uk-UA')}` : ''}
                </span>
                {points.multiplier && (
                  <span className="pb-mult" title={t('points.multiplier')}>
                    {points.multiplier}
                  </span>
                )}
                {points.chest && (
                  <button
                    className="pb-chest"
                    title={t('points.claim')}
                    onClick={() => void claimBonus(pane.channel)}
                  >
                    🎁
                  </button>
                )}
                <div className="spacer" />
                {/* the tucked-away poll or prediction, one press from coming back */}
                {(pagePolls?.length ?? 0) > 0 && pollHidden && (
                  <button
                    className="pb-poll"
                    title={t('poll.reopen')}
                    onClick={() => useUiStore.getState().hidePagePoll(pane.channel, false)}
                  >
                    {/* their own prediction mark: a clock face with a plus, as on Twitch */}
                    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
                      <path
                        d="M10 3.6a6.4 6.4 0 1 0 6.3 7.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.9"
                        strokeLinecap="round"
                      />
                      <path
                        d="M10 6.6V10l2.4 1.6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.9"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M14.4 3.2v4M12.4 5.2h4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.9"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                )}
                {/* the folded-away share offer, one press from coming back */}
                {share && shareTucked && (
                  <button
                    className="pb-share"
                    title={t('player.shareBack', { what: share.title })}
                    onClick={() => useUiStore.getState().tuckShare(pane.channel, false)}
                  >
                    {/* an arrow leaving its box: the same thing their own share button means */}
                    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
                      <path
                        d="M11.2 4.2H6.2a2 2 0 0 0-2 2v7.6a2 2 0 0 0 2 2h7.6a2 2 0 0 0 2-2V8.8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                      />
                      <path
                        d="M9.6 10.4 15.8 4.2"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                      />
                      <path
                        d="M11.8 4.2h4v4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
                {/*
                  Twitch's own drops chest, in our own bar and always in it.

                  Drawn even on a channel with no campaign running, so its place in the row does
                  not move about; lit in the accent when there IS one, and shaking once a reward
                  has landed, until the panel is opened and it has been seen. Right beside the
                  rewards button, because the two are the same kind of thing.
                */}
                <button
                  className={`pb-drops ${drops?.any ? 'live' : ''} ${
                    dropsGot.length > 0 || drops?.items.some((d) => d.claim) ? 'got' : ''
                  }`}
                  title={
                    dropsGot.length > 0
                      ? t('drops.gotNamed', { names: dropsGot.join(', ') })
                      : drops?.any
                        ? t('drops.chest')
                        : t('drops.noneHere')
                  }
                  onClick={() => {
                    setRewardsOpen(false)
                    setDropsOpen((v) => !v)
                    useUiStore.getState().clearDropsGot(pane.channel)
                  }}
                >
                  {/*
                    A chest: lid, body and its lock, in the theme's own colours.

                    Drawn as three rectangles rather than paths so it is exactly symmetrical in
                    its box — the glow is a halo around that box, and a shape sitting a pixel off
                    centre inside it reads as a crooked glow.
                  */}
                  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
                    <rect
                      x="3.4"
                      y="4.6"
                      width="17.2"
                      height="5.2"
                      rx="1.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                    />
                    <rect
                      x="4.3"
                      y="9.8"
                      width="15.4"
                      height="9.6"
                      rx="1.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                    />
                    <rect x="10.4" y="9.8" width="3.2" height="3.4" fill="currentColor" />
                  </svg>
                </button>
                <button
                  className="pb-rewards"
                  title={t('points.rewards')}
                  onClick={() => {
                    setDropsOpen(false)
                    setRewardsOpen((v) => !v)
                  }}
                >
                  <StarIcon size={13} />
                  <span>{t('points.rewards')}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Ctrl+F message/nick search: navigates matches via the existing jump+flash mechanism */
function ChatSearch({ channel, onClose }: { channel: string; onClose: () => void }): React.JSX.Element {
  const t = useT()
  const messages = useChatStore((s) => s.messages[channel]) ?? []
  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)
  const q = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!q) return []
    return messages.filter(
      (m) =>
        !m.system &&
        !m.deleted &&
        (m.text.toLowerCase().includes(q) ||
          m.login.includes(q) ||
          m.displayName.toLowerCase().includes(q))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, messages.length])

  const go = (next: number): void => {
    if (matches.length === 0) return
    const i = ((next % matches.length) + matches.length) % matches.length
    setIdx(i)
    // newest matches are the most interesting — index 0 = the LAST (newest) match
    const msg = matches[matches.length - 1 - i]
    window.dispatchEvent(new CustomEvent('sticki:jump', { detail: { channel, msgId: msg.id } }))
  }

  return (
    <div className="chat-search">
      <input
        autoFocus
        placeholder={t('search.placeholder')}
        value={query}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value)
          setIdx(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter') go(e.shiftKey ? idx - 1 : idx + (query && idx === 0 && matches.length ? 0 : 1))
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            go(idx + 1)
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            go(idx - 1)
          }
        }}
      />
      <span className="hint" style={{ whiteSpace: 'nowrap' }}>
        {q ? `${matches.length ? idx + 1 : 0}/${matches.length}` : ''}
      </span>
      <button className="icon-btn" title="↑" onClick={() => go(idx + 1)}>
        ↑
      </button>
      <button className="icon-btn" title="↓" onClick={() => go(idx - 1)}>
        ↓
      </button>
      <button className="icon-btn" onClick={onClose}>
        ✕
      </button>
    </div>
  )
}

/**
 * Which restrictions this chat currently has on.
 *
 * Every one of these is a reason a message you type might be refused, and the only way to find
 * out used to be to try: Twitch answers with an English NOTICE after the fact, if at all. Shown
 * only when something IS on, so a normal chat's header stays exactly as it was.
 */
function RoomModeTags({ channel }: { channel: string }): React.JSX.Element | null {
  const t = useT()
  const modes = useChatStore((s) => s.roomModes[channel])
  if (!modes) return null
  const tags: { key: string; text: string; title: string }[] = []
  if (modes.emoteOnly) tags.push({ key: 'emote', text: t('modes.tag.emote'), title: t('modes.emoteOnly') })
  if (modes.subsOnly) tags.push({ key: 'subs', text: t('modes.tag.subs'), title: t('modes.subsOnly') })
  if (modes.uniqueChat) tags.push({ key: 'r9k', text: t('modes.tag.unique'), title: t('modes.uniqueChat') })
  if (typeof modes.followersOnly === 'number' && modes.followersOnly >= 0) {
    // 0 means "any follower"; anything above is a waiting period in minutes
    const mins = modes.followersOnly
    tags.push({
      key: 'follow',
      text: mins > 0 ? t('modes.tag.followMin', { n: String(mins) }) : t('modes.tag.follow'),
      title: t('modes.followersOnly')
    })
  }
  if (modes.slow && modes.slow > 0) {
    tags.push({ key: 'slow', text: t('modes.tag.slow', { n: String(modes.slow) }), title: t('modes.slowMode') })
  }
  if (!tags.length) return null
  return (
    <span className="room-modes">
      {tags.map((tag) => (
        <span key={tag.key} className="room-mode-tag" title={tag.title}>
          {tag.text}
        </span>
      ))}
    </span>
  )
}
