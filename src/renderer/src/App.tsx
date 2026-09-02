import { useEffect, useMemo, useState } from 'react'
import { loadConfig, startPersistence, startSettingsPersistence, startConfigSync } from './services/config'
import { chatService } from './services/chatService'
import { useSettingsStore } from './store/settings'
import { useAccountsStore } from './store/accounts'
import { useLayoutStore, nextId, allOpenChannels } from './store/layout'
import { useUiStore } from './store/ui'
import { DEFAULT_CLIENT_ID } from './config/defaultClientId'
import Onboarding from './components/Onboarding'
import TabBar from './components/TabBar'
import SplitGrid from './components/SplitGrid'
import SettingsModal from './components/settings/SettingsModal'
import DeviceAuthModal from './components/DeviceAuthModal'
import UserCard from './components/UserCard'
import Toasts from './components/Toasts'
import UpdateBanner from './components/UpdateBanner'
import EmoteHoverPreview from './components/EmoteHoverPreview'
import LinkCard from './components/LinkCard'
import EmoteFolderMenu from './components/EmoteFolderMenu'
import StreamPlayer from './components/StreamPlayer'
import EmotePickerWindow from './components/EmotePickerWindow'
import UserCardWindow from './components/UserCardWindow'
import WhispersWindow from './components/WhispersWindow'
import HighlightsWindow from './components/HighlightsWindow'
import OverlayEditorWindow from './components/OverlayEditorWindow'
import ChannelPrompt from './components/ChannelPrompt'
import HypeTrainPopup from './components/HypeTrainPopup'
import ReauthBanner from './components/ReauthBanner'
import { buildChannelSeed, injectChannelSeed } from './lib/detachSeed'
import { compileScene } from './lib/overlayNodeStyle'
import { hexToRgba } from './lib/tokenize'
import { hotkeyFor, matchHotkey } from './lib/hotkeys'
import { applyTheme } from './lib/themes'
import { diagInfo, diagWarn } from './lib/diag'
import { useT } from './i18n'
import { PinIcon } from './components/Icons'

/** biggest chat text size (Ctrl+wheel and the settings field share this ceiling) */
export const CHAT_FONT_MAX = 40

/** interface scale bounds for the utility windows — below 70 controls stop being hittable,
 *  above 180 the grids push their own content out of frame */
export const UI_SCALE_MIN = 70
export const UI_SCALE_MAX = 180
export const clampUiScale = (v: number): number =>
  Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(v / 10) * 10))

/** windows that carry no chat of their own, so Ctrl+wheel is free to mean "scale me" */
export const SCALABLE_WINDOWS = new Set(['settings', 'usercard', 'whispers', 'highlights', 'emotepicker'])

interface DetachedPayload {
  name?: string
  panes: { channel: string; accountId: string | null }[]
  /** recent message buffer per channel, handed over so the other window keeps live state
   *  instead of reloading everything as dimmed "historical" scrollback */
  seed?: Record<string, import('./types').ChatMessage[]>
}

export interface EmotePickerWindowPayload {
  paneId: string
  channel: string
  channelId: string
  accountId: string | null
}

export interface UserCardWindowPayload {
  target: import('./store/ui').UserCardTarget
  /** snapshot of this user's messages from the main window — seeds the window's list so it
   *  shows the same history the panel had, before/while its own reader backfills live ones */
  messages: (Partial<import('./types').ChatMessage> & { id: string; timestamp: number })[]
}

type Special =
  | { kind: 'detached'; data: DetachedPayload }
  | { kind: 'emotepicker'; data: EmotePickerWindowPayload }
  | { kind: 'settings'; section?: string }
  | { kind: 'usercard'; data: UserCardWindowPayload }
  | { kind: 'whispers' }
  | { kind: 'highlights'; channel: string }
  | { kind: 'overlayeditor'; overlayId: string }
  | { kind: 'stream'; channel: string }
  | null

function parseHash(): Special {
  const h = window.location.hash
  try {
    if (h.startsWith('#detached=')) return { kind: 'detached', data: JSON.parse(decodeURIComponent(h.slice(10))) }
    if (h.startsWith('#emotepicker=')) return { kind: 'emotepicker', data: JSON.parse(decodeURIComponent(h.slice(13))) }
    if (h === '#settings') return { kind: 'settings' }
    if (h.startsWith('#settings=')) return { kind: 'settings', section: h.slice(10) }
    if (h.startsWith('#usercard=')) return { kind: 'usercard', data: JSON.parse(decodeURIComponent(h.slice(10))) }
    if (h === '#whispers') return { kind: 'whispers' }
    if (h.startsWith('#highlights=')) return { kind: 'highlights', channel: decodeURIComponent(h.slice(12)) }
    if (h.startsWith('#overlayeditor=')) return { kind: 'overlayeditor', overlayId: decodeURIComponent(h.slice(15)) }
    if (h.startsWith('#stream=')) return { kind: 'stream', channel: decodeURIComponent(h.slice(8)) }
  } catch {
    /* malformed hash */
  }
  return null
}

export default function App(): React.JSX.Element | null {
  const [booted, setBooted] = useState(false)
  const [onboarded, setOnboarded] = useState(false)
  const [pinned, setPinned] = useState(false)
  const settings = useSettingsStore((s) => s.settings)
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const addAccountOpen = useUiStore((s) => s.addAccountOpen)
  const userCard = useUiStore((s) => s.userCard)
  const special = useMemo(parseHash, [])
  const detached = special?.kind === 'detached' ? special.data : null
  const t = useT()

  useEffect(() => {
    loadConfig()
      .catch(() => false)
      .then(() => {
        if (!useSettingsStore.getState().clientId && DEFAULT_CLIENT_ID) {
          useSettingsStore.getState().setClientId(DEFAULT_CLIENT_ID)
        }
        if (detached) {
          // detached window: ephemeral layout from the hash, no config persistence
          const tabId = nextId('tab')
          useLayoutStore.getState().setAll(
            [
              {
                id: tabId,
                name: detached.name,
                columns: 0,
                panes: detached.panes.map((p) => ({ id: nextId('pane'), ...p }))
              }
            ],
            tabId
          )
          if (detached.name) document.title = `StickiChat — ${detached.name}`
          // seed the buffer from the main window BEFORE the reader starts, so messages keep
          // their live state instead of the fresh reader marking them all "historical"
          injectChannelSeed(detached.seed)
          // layout here is ephemeral, but settings tweaks (font zoom, sounds…) must persist
          startSettingsPersistence()
          setOnboarded(true)
        } else if (
          special?.kind === 'emotepicker' ||
          special?.kind === 'settings' ||
          special?.kind === 'usercard' ||
          special?.kind === 'whispers' ||
          special?.kind === 'highlights' ||
          special?.kind === 'overlayeditor'
        ) {
          // utility windows: no chat and no layout persistence, but settings changed here
          // (sounds, pins, mod buttons…) must still reach the disk
          startSettingsPersistence()
          setOnboarded(true)
        } else {
          startPersistence()
          const hasClientId = !!useSettingsStore.getState().clientId
          const hasAccounts = useAccountsStore.getState().accounts.length > 0
          setOnboarded(hasClientId && hasAccounts)
        }
        setBooted(true)
      })
    return startConfigSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Per-window interface scale. Ctrl+wheel is the gesture everyone reaches for; in the chat
   * window it already means "message font size", so it only means "scale this window" in the
   * windows that have no chat of their own.
   */
  const windowKind = special?.kind ?? ''
  const scalable = SCALABLE_WINDOWS.has(windowKind)
  const winScale = settings.windowScales?.[windowKind]

  useEffect(() => {
    // Reset Chromium's own page zoom on every window, once. setZoomFactor looked like the
    // right tool and is not: the zoom LEVEL is stored per ORIGIN, so zooming the settings
    // window zoomed the chat window with it — every window here shares one origin.
    void window.sticki.setZoom(1)
  }, [])

  /**
   * DEV ONLY — a local flood, for reproducing the "chat blinks out for a second" report.
   *
   * The symptom scales with message rate — it happens when the ring buffer cuts its head —
   * so it needs real volume to show up at all. These are LOCAL system lines:
   * they go through exactly the same queue, store, trim and virtual list as real chat, and
   * nothing is sent to Twitch — which is what makes this safe to run on any channel.
   *
   * Ctrl+Alt+Shift+F floods the active channel. The dev server is the only thing served over
   * http — a packaged build loads from file:, so the listener is never even registered there.
   */
  useEffect(() => {
    if (location.protocol !== 'http:' || window.location.hash) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyF')) return
      e.preventDefault()
      const st = useLayoutStore.getState()
      const channel = st.tabs.find((t) => t.id === st.activeTabId)?.panes[0]?.channel
      if (!channel) return
      let n = 0
      const total = 1500
      const timer = window.setInterval(() => {
        for (let i = 0; i < 25 && n < total; i++, n++) {
          chatService.localInfo(channel, `flood ${n} — ${'x'.repeat(10 + (n % 60))}`)
        }
        if (n >= total) window.clearInterval(timer)
      }, 60)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * One line at the top of every session saying what this build is and what it is carrying.
   *
   * Almost every report starts with questions this answers: which version, how many channels
   * and accounts, is history on, is the buffer tiny. Without it the log opens mid-conversation
   * and the first ten exchanges are spent establishing the setup.
   */
  useEffect(() => {
    if (!booted) return
    const s = useSettingsStore.getState().settings
    const channels = allOpenChannels(useLayoutStore.getState().tabs)
    const accounts = useAccountsStore.getState().accounts
    void window.sticki?.getVersion?.().then((version) => {
      diagInfo(
        'app',
        `v${version} started — ${accounts.length} account(s), ${channels.length} channel(s) in ` +
          `${useLayoutStore.getState().tabs.length} tab(s), buffer ${s.messageLimit}, ` +
          `history ${s.loadHistory ? 'on' : 'off'}, smooth scroll ${s.smoothChatScroll ? 'on' : 'off'}`
      )
    })
  }, [booted])

  // Whether the machine thinks it has a network at all. Without this a report cannot tell
  // "the socket died on its own" from "the whole box went offline for ten seconds", and those
  // want completely different answers.
  useEffect(() => {
    const on = (): void => diagInfo('net', 'browser reports ONLINE')
    const off = (): void => diagWarn('net', 'browser reports OFFLINE')
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    if (!navigator.onLine) off()
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  useEffect(() => {
    // `zoom` on the ROOT element instead. Unlike zoom on a child, this scales the layout
    // viewport too, so `100vh` inside still means "this window" and the panels end exactly at
    // its edges. And it is a DOM property, so it belongs to this window and nothing else.
    // only set it when it actually differs: `zoom` — even `zoom: 1` — makes the element a
    // containing block for fixed-position descendants and changes how percentage heights
    // resolve under it, which is enough to leave a strip of bare page under a panel
    const k = clampUiScale(winScale ?? 100) / 100
    document.documentElement.style.zoom = scalable && k !== 1 ? String(k) : ''
  }, [scalable, winScale])

  useEffect(() => {
    if (!scalable) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const st = useSettingsStore.getState()
      const cur = st.settings.windowScales?.[windowKind] ?? 100
      st.setSettings({
        windowScales: { ...st.settings.windowScales, [windowKind]: clampUiScale(cur + (e.deltaY < 0 ? 10 : -10)) }
      })
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [scalable, windowKind])

  useEffect(() => {
    const root = document.documentElement
    // the theme goes on first; everything below is the user's own overrides and must win
    applyTheme(settings.theme)
    root.style.setProperty('--font-size', `${settings.fontSize}px`)
    root.style.setProperty('--emote-scale', String(settings.emoteScale))
    root.style.setProperty('--msg-spacing', `${settings.messageSpacing}px`)
    root.style.setProperty('--line-spacing', `${settings.lineSpacing}px`)
    root.style.setProperty('--badge-size', `${settings.badgeSize}px`)
    // background carries the user-picked opacity; the accent stripe stays solid
    root.style.setProperty('--mention-bg', hexToRgba(settings.mentionBgColor, settings.mentionBgOpacity))
    root.style.setProperty('--mention-accent', settings.mentionBgColor)
    root.style.setProperty('--flash-color', settings.flashColor)
    if (settings.fontFamily.trim()) {
      root.style.setProperty('--app-font', `"${settings.fontFamily.trim()}", 'Segoe UI', sans-serif`)
    } else {
      root.style.removeProperty('--app-font')
    }
  }, [
    settings.theme,
    settings.fontSize,
    settings.emoteScale,
    settings.messageSpacing,
    settings.badgeSize,
    settings.mentionBgColor,
    settings.mentionBgOpacity,
    settings.flashColor,
    settings.fontFamily,
    settings.lineSpacing,
    settings.customFonts
  ])

  // user-uploaded fonts become @font-face rules available to the font-family setting
  useEffect(() => {
    const el = document.getElementById('sticki-custom-fonts') ?? document.createElement('style')
    el.id = 'sticki-custom-fonts'
    el.textContent = settings.customFonts
      .map((f) => `@font-face { font-family: "${f.name.replace(/"/g, '')}"; src: url("${f.data}"); }`)
      .join('\n')
    if (!el.parentNode) document.head.appendChild(el)
  }, [settings.customFonts])

  // pin this window on top when the setting is on (main window only follows the persisted setting)
  useEffect(() => {
    if (!special) window.sticki.setAlwaysOnTop(settings.alwaysOnTop)
  }, [settings.alwaysOnTop, special])

  // OBS overlay server lifecycle + LIVE config: every overlay's full config is pushed to the
  // already-connected OBS sources over SSE the moment it changes (main window only)
  useEffect(() => {
    if (special) return
    const styles: Record<string, unknown> = {}
    for (const o of settings.chatOverlays) {
      // uploaded fonts travel to the OBS page as a data URL (@font-face there)
      const font = o.type === 'chat' || o.type === 'goal' ? o.font : undefined
      const custom = font ? settings.customFonts.find((f) => f.name === font) : undefined
      // the beta's elements go over already compiled: the page cannot run our placement maths,
      // and a second copy of it there would drift from this one the first time either is touched
      styles[o.id] = {
        ...o,
        fontData: custom?.data,
        sceneCompiled: o.type === 'chat' && o.editMode === 'beta' ? compileScene(o.scene) : undefined
      }
    }
    window.sticki.overlayConfigure(settings.overlayEnabled, settings.overlayPort, styles)
  }, [settings.overlayEnabled, settings.overlayPort, settings.chatOverlays, settings.customFonts, special])

  // goal overlays that follow a real Twitch total need somebody to ask for it (main window only)
  useEffect(() => {
    if (special) return
    void import('./services/goals').then((m) => m.startGoals())
    return () => void import('./services/goals').then((m) => m.stopGoals())
  }, [special])

  /**
   * Optional: freeze animated emotes while this window isn't focused.
   *
   * With a fast channel the visible chat costs most of a core just to paint, which is what
   * makes dragging the window feel like it snags. Nobody is reading animations they aren't
   * looking at, so this hands that back — off by default, because it's a visible change.
   */
  useEffect(() => {
    const pause = settings.pauseEmotesUnfocused
    const apply = (): void => {
      void window.sticki.setImageAnimation(!pause || document.hasFocus())
    }
    apply()
    if (!pause) return
    window.addEventListener('focus', apply)
    window.addEventListener('blur', apply)
    return () => {
      window.removeEventListener('focus', apply)
      window.removeEventListener('blur', apply)
      // leaving the setting behind must not leave the window frozen
      void window.sticki.setImageAnimation(true)
    }
  }, [settings.pauseEmotesUnfocused])

  useEffect(() => {
    if (!booted || !onboarded) return
    if (
      special?.kind === 'emotepicker' ||
      special?.kind === 'settings' ||
      special?.kind === 'usercard' ||
      special?.kind === 'whispers' ||
      special?.kind === 'highlights' ||
      special?.kind === 'overlayeditor'
    )
      return
    chatService.start()
    if (!detached && useLayoutStore.getState().tabs.length === 0) {
      useLayoutStore.getState().addTab()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, onboarded, special])

  // main window: "jump to message" clicked in a standalone highlights window — bring the
  // right tab forward, then scroll the chat to that message
  useEffect(() => {
    if (special) return
    return window.sticki.onJumpTo((payload) => {
      try {
        const { channel, msgId } = JSON.parse(payload) as { channel: string; msgId: string }
        const layout = useLayoutStore.getState()
        const tab = layout.tabs.find((t) => t.panes.some((p) => p.channel === channel))
        if (!tab) return
        if (layout.activeTabId !== tab.id) layout.setActiveTab(tab.id)
        window.sticki.focusSelf()
        // give the pane a beat to mount before asking it to scroll
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('sticki:jump', { detail: { channel, msgId } }))
        }, 150)
      } catch {
        /* malformed payload */
      }
    })
  }, [special])

  // main window: accept tabs coming back from detached windows
  useEffect(() => {
    if (special) return
    return window.sticki.onReattach((payload) => {
      try {
        const data = JSON.parse(payload) as DetachedPayload
        const layout = useLayoutStore.getState()
        const id = layout.addTab(data.name)
        for (const p of data.panes) layout.addPane(id, p.channel, p.accountId)
        // restore the buffer the detached window handed back, so returning doesn't dim it all
        injectChannelSeed(data.seed)
      } catch {
        /* malformed payload */
      }
    })
  }, [special])

  // any window: relay emotes picked in a standalone picker window to the right pane's input
  useEffect(() => {
    return window.sticki.onEmotePicked((payload) => {
      try {
        const detail = JSON.parse(payload)
        const { tabs, activeTabId } = useLayoutStore.getState()
        const ownsPane = tabs.some((t) => t.panes.some((p) => p.id === detail?.paneId))
        if (ownsPane) {
          // the picker was opened from a pane that may no longer be VISIBLE (tab switched;
          // inactive panes are unmounted and don't listen) — retarget to the active tab
          const activePanes = tabs.find((t) => t.id === activeTabId)?.panes ?? []
          if (!activePanes.some((p) => p.id === detail.paneId) && activePanes[0]) {
            detail.paneId = activePanes[0].id
          }
          window.dispatchEvent(new CustomEvent('sticki:insert', { detail }))
          // pull THIS window to the foreground so the input (focused by the insert handler)
          // is immediately ready for Enter
          window.sticki.focusSelf()
        } else {
          window.dispatchEvent(new CustomEvent('sticki:insert', { detail }))
        }
      } catch {
        /* malformed payload */
      }
    })
  }, [])

  // F5 (configurable) = force-reconnect chat (instead of reloading the page)
  useEffect(() => {
    if (!booted || !onboarded || special?.kind === 'emotepicker' || special?.kind === 'settings' || special?.kind === 'usercard') return
    const onKey = (e: KeyboardEvent): void => {
      if (matchHotkey(e, hotkeyFor(useSettingsStore.getState().settings, 'reconnect'))) {
        e.preventDefault()
        chatService.reconnect()
        // a manual reconnect is also the natural "refresh everything" gesture — drop cached
        // 7TV cosmetics so changed paints/badges come back immediately
        void import('./lib/seventvCosmetics').then((m) => m.refreshAllSevenTvCosmetics())
        useUiStore.getState().toast(t('misc.reconnecting'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [booted, onboarded, special, t])

  // Ctrl+Shift+T (configurable) — convert the focused field's text between layouts (укр ⇄ eng)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const settings = useSettingsStore.getState().settings
      if (!settings.translitEnabled) return
      if (!matchHotkey(e, hotkeyFor(settings, 'translit'))) return
      e.preventDefault()
      import('./lib/translit').then(({ swapLayoutInFocusedField }) => swapLayoutInFocusedField())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Ctrl + mouse wheel zooms whatever is under the cursor: over the tab bar it scales the
  // TABS, anywhere else the chat text. The two sizes are independent (.tabbar no longer
  // inherits --font-size), so neither drags the other along.
  useEffect(() => {
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const st = useSettingsStore.getState()
      const step = e.deltaY < 0 ? 1 : -1
      if ((e.target as HTMLElement | null)?.closest?.('.tabbar')) {
        const cur = st.settings.tabScale
        const next = Math.max(0.6, Math.min(1.8, Math.round((cur + step * 0.1) * 10) / 10))
        if (next !== cur) st.setSettings({ tabScale: next })
        return
      }
      const cur = st.settings.fontSize
      const next = Math.max(10, Math.min(CHAT_FONT_MAX, cur + step))
      if (next !== cur) st.setSettings({ fontSize: next })
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  const returnToMain = (): void => {
    if (!detached) return
    const tab = useLayoutStore.getState().tabs[0]
    const panes = (tab?.panes ?? detached.panes).map((p) => ({ channel: p.channel, accountId: p.accountId }))
    const payload: DetachedPayload = {
      name: detached.name,
      panes,
      // hand the accumulated buffer back so the main window doesn't reload it as dimmed history
      seed: buildChannelSeed(panes.map((p) => p.channel))
    }
    window.sticki.reattach(JSON.stringify(payload)).then(() => window.close())
  }

  if (!booted) return null

  if (special?.kind === 'emotepicker') {
    return (
      <>
        <EmotePickerWindow payload={special.data} />
        {/* its own window, its own tree: the menu mounted in the main one does not exist here */}
        <EmoteFolderMenu />
        <Toasts />
      </>
    )
  }

  if (special?.kind === 'settings') {
    return (
      <div className="app">
        <SettingsModal standalone initialSection={special.section} />
        {addAccountOpen && <DeviceAuthModal onClose={() => useUiStore.getState().setAddAccountOpen(false)} />}
        {/* the preview button drives THIS window's store — real trains only ever show in the main
            window, but the demo has to appear where the button was pressed */}
        <HypeTrainPopup />
        <Toasts />
      </div>
    )
  }

  if (special?.kind === 'usercard') {
    return <UserCardWindow payload={special.data} />
  }

  if (special?.kind === 'whispers') {
    return <WhispersWindow />
  }

  if (special?.kind === 'highlights') {
    return <HighlightsWindow channel={special.channel} />
  }

  if (special?.kind === 'stream') {
    // nothing else in this window: no stores to boot, no chat, just the player filling the frame
    return <StreamPlayer channel={special.channel} standalone />
  }

  if (special?.kind === 'overlayeditor') {
    return <OverlayEditorWindow overlayId={special.overlayId} />
  }

  if (!onboarded) {
    return (
      <>
        <Onboarding onDone={() => setOnboarded(true)} />
        <Toasts />
      </>
    )
  }

  return (
    <div className="app">
      {!detached && <TabBar />}
      {!detached && <UpdateBanner />}
      {!detached && <ReauthBanner />}
      {detached && (
        <div className="detached-bar">
          <span className="detached-title">{detached.name}</span>
          <div className="spacer" />
          <button
            className={pinned ? 'primary' : ''}
            onClick={() => {
              const next = !pinned
              setPinned(next)
              window.sticki.setAlwaysOnTop(next)
            }}
            title={t('set.alwaysOnTop')}
          >
            <PinIcon />
          </button>
          <button onClick={returnToMain} title={t('detach.return')}>
            ⇱ {t('detach.return')}
          </button>
        </div>
      )}
      <SplitGrid />
      {settingsOpen && <SettingsModal />}
      {addAccountOpen && (
        <DeviceAuthModal onClose={() => useUiStore.getState().setAddAccountOpen(false)} />
      )}
      {userCard && <UserCard target={userCard} />}
      <EmoteHoverPreview />
      <LinkCard />
      <EmoteFolderMenu />
      <ChannelPrompt />
      <HypeTrainPopup />
      <Toasts />
    </div>
  )
}
