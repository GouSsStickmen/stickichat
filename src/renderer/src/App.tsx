import { useEffect, useMemo, useState } from 'react'
import { loadConfig, startPersistence, startSettingsPersistence, startConfigSync } from './services/config'
import { chatService } from './services/chatService'
import { useSettingsStore } from './store/settings'
import { useAccountsStore } from './store/accounts'
import { useLayoutStore, nextId } from './store/layout'
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
import EmotePickerWindow from './components/EmotePickerWindow'
import UserCardWindow from './components/UserCardWindow'
import WhispersWindow from './components/WhispersWindow'
import HighlightsWindow from './components/HighlightsWindow'
import ChannelPrompt from './components/ChannelPrompt'
import { hexToRgba } from './lib/tokenize'
import { hotkeyFor, matchHotkey } from './lib/hotkeys'
import { useT } from './i18n'

interface DetachedPayload {
  name?: string
  panes: { channel: string; accountId: string | null }[]
}

export interface EmotePickerWindowPayload {
  paneId: string
  channel: string
  channelId: string
  accountId: string | null
}

export interface UserCardWindowPayload {
  target: import('./store/ui').UserCardTarget
  messages: { id: string; timestamp: number; text: string; emotesTag?: string }[]
}

type Special =
  | { kind: 'detached'; data: DetachedPayload }
  | { kind: 'emotepicker'; data: EmotePickerWindowPayload }
  | { kind: 'settings'; section?: string }
  | { kind: 'usercard'; data: UserCardWindowPayload }
  | { kind: 'whispers' }
  | { kind: 'highlights'; channel: string }
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
          // layout here is ephemeral, but settings tweaks (font zoom, sounds…) must persist
          startSettingsPersistence()
          setOnboarded(true)
        } else if (
          special?.kind === 'emotepicker' ||
          special?.kind === 'settings' ||
          special?.kind === 'usercard' ||
          special?.kind === 'whispers' ||
          special?.kind === 'highlights'
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

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = settings.theme
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

  // OBS overlay server lifecycle + LIVE style config: every change here is pushed to the
  // already-connected OBS sources over SSE (main window only)
  useEffect(() => {
    if (special) return
    // uploaded fonts travel to the OBS page as a data URL (@font-face there)
    const custom = settings.customFonts.find((f) => f.name === settings.overlayFont)
    window.sticki.overlayConfigure(settings.overlayEnabled, settings.overlayPort, {
      size: settings.overlayFontSize,
      font: settings.overlayFont,
      fontData: custom?.data,
      fade: settings.overlayFade,
      max: settings.overlayMax,
      gap: settings.overlayLineGap,
      bold: settings.overlayBold,
      textColor: settings.overlayTextColor,
      outlineWidth: settings.overlayOutlineWidth,
      outlineColor: settings.overlayOutlineColor,
      bg: settings.overlayBgOpacity > 0 ? hexToRgba(settings.overlayBgColor, settings.overlayBgOpacity) : ''
    })
  }, [
    settings.overlayEnabled,
    settings.overlayPort,
    settings.overlayFontSize,
    settings.overlayFont,
    settings.overlayFade,
    settings.overlayMax,
    settings.overlayLineGap,
    settings.overlayBold,
    settings.overlayTextColor,
    settings.overlayOutlineWidth,
    settings.overlayOutlineColor,
    settings.overlayBgColor,
    settings.overlayBgOpacity,
    settings.customFonts,
    special
  ])

  useEffect(() => {
    if (!booted || !onboarded) return
    if (
      special?.kind === 'emotepicker' ||
      special?.kind === 'settings' ||
      special?.kind === 'usercard' ||
      special?.kind === 'whispers' ||
      special?.kind === 'highlights'
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

  // Ctrl + mouse wheel = zoom chat text size
  useEffect(() => {
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const cur = useSettingsStore.getState().settings.fontSize
      const next = Math.max(10, Math.min(22, cur + (e.deltaY < 0 ? 1 : -1)))
      if (next !== cur) useSettingsStore.getState().setSettings({ fontSize: next })
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  const returnToMain = (): void => {
    if (!detached) return
    const tab = useLayoutStore.getState().tabs[0]
    const payload: DetachedPayload = {
      name: detached.name,
      panes: (tab?.panes ?? detached.panes).map((p) => ({ channel: p.channel, accountId: p.accountId }))
    }
    window.sticki.reattach(JSON.stringify(payload)).then(() => window.close())
  }

  if (!booted) return null

  if (special?.kind === 'emotepicker') {
    return <EmotePickerWindow payload={special.data} />
  }

  if (special?.kind === 'settings') {
    return (
      <div className="app settings-window">
        <SettingsModal standalone initialSection={special.section} />
        {addAccountOpen && <DeviceAuthModal onClose={() => useUiStore.getState().setAddAccountOpen(false)} />}
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
            📌
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
      <ChannelPrompt />
      <Toasts />
    </div>
  )
}
