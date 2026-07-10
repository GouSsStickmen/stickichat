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
  | null

function parseHash(): Special {
  const h = window.location.hash
  try {
    if (h.startsWith('#detached=')) return { kind: 'detached', data: JSON.parse(decodeURIComponent(h.slice(10))) }
    if (h.startsWith('#emotepicker=')) return { kind: 'emotepicker', data: JSON.parse(decodeURIComponent(h.slice(13))) }
    if (h === '#settings') return { kind: 'settings' }
    if (h.startsWith('#settings=')) return { kind: 'settings', section: h.slice(10) }
    if (h.startsWith('#usercard=')) return { kind: 'usercard', data: JSON.parse(decodeURIComponent(h.slice(10))) }
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
        } else if (special?.kind === 'emotepicker' || special?.kind === 'settings' || special?.kind === 'usercard') {
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
    root.style.setProperty('--badge-size', `${settings.badgeSize}px`)
    root.style.setProperty('--mention-bg', settings.mentionBgColor)
    root.style.setProperty('--first-msg-bg', settings.firstMessageBgColor)
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
    settings.firstMessageBgColor,
    settings.fontFamily
  ])

  // pin this window on top when the setting is on (main window only follows the persisted setting)
  useEffect(() => {
    if (!special) window.sticki.setAlwaysOnTop(settings.alwaysOnTop)
  }, [settings.alwaysOnTop, special])

  useEffect(() => {
    if (!booted || !onboarded) return
    if (special?.kind === 'emotepicker' || special?.kind === 'settings' || special?.kind === 'usercard') return
    chatService.start()
    if (!detached && useLayoutStore.getState().tabs.length === 0) {
      useLayoutStore.getState().addTab()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, onboarded, special])

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
        window.dispatchEvent(new CustomEvent('sticki:insert', { detail: JSON.parse(payload) }))
      } catch {
        /* malformed payload */
      }
    })
  }, [])

  // F5 = force-reconnect chat (instead of reloading the page)
  useEffect(() => {
    if (!booted || !onboarded || special?.kind === 'emotepicker' || special?.kind === 'settings' || special?.kind === 'usercard') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F5') {
        e.preventDefault()
        chatService.reconnect()
        useUiStore.getState().toast(t('misc.reconnecting'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [booted, onboarded, special, t])

  // Ctrl+Shift+T — convert the focused field's text between keyboard layouts (укр ⇄ eng)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.shiftKey || e.code !== 'KeyT') return
      if (!useSettingsStore.getState().settings.translitEnabled) return
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
        <Toasts />
      </div>
    )
  }

  if (special?.kind === 'usercard') {
    return <UserCardWindow payload={special.data} />
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
      <Toasts />
    </div>
  )
}
