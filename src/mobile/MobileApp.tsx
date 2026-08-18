import React, { useEffect, useState } from 'react'
import { loadConfig, startPersistence, startConfigSync } from '@renderer/services/config'
import { useSettingsStore } from '@renderer/store/settings'
import { useLayoutStore } from '@renderer/store/layout'
import { useAccountsStore } from '@renderer/store/accounts'
import { useUiStore } from '@renderer/store/ui'
import { DEFAULT_CLIENT_ID } from '@renderer/config/defaultClientId'
import ChatPane from '@renderer/components/ChatPane'
import DeviceAuthModal from '@renderer/components/DeviceAuthModal'
import SettingsModal from '@renderer/components/settings/SettingsModal'
import UserCard from '@renderer/components/UserCard'
import EmoteHoverPreview from '@renderer/components/EmoteHoverPreview'
import LinkCard from '@renderer/components/LinkCard'
import ChannelPrompt from '@renderer/components/ChannelPrompt'
import HypeTrainPopup from '@renderer/components/HypeTrainPopup'
import Toasts from '@renderer/components/Toasts'
import { chatService } from '@renderer/services/chatService'
import { App as CapApp } from '@capacitor/app'
import MobileTabStrip from './MobileTabStrip'
import ModConfirmSheet from './ModConfirmSheet'
import MobilePlayer from './MobilePlayer'

/**
 * The phone shell.
 *
 * It is not the desktop App with smaller padding. The desktop one boots overlays, a second and
 * third window, always-on-top, an eyedropper and a wheel-zoom handler — none of which exist here —
 * so this brings up the same services and then lays the same chat out for a thumb.
 *
 * The split is a vertical stack rather than columns: three columns on a six-inch screen leave about
 * 120px each, which is narrower than a nick plus a badge, so the one thing a split is for — seeing
 * who said what in two chats at once — stops working. In landscape the desktop grid is the right
 * answer again and takes over.
 */
export default function MobileApp(): React.JSX.Element | null {
  const [booted, setBooted] = useState(false)
  const tabs = useLayoutStore((s) => s.tabs)
  const activeTabId = useLayoutStore((s) => s.activeTabId)
  const accounts = useAccountsStore((s) => s.accounts)
  const addAccountOpen = useUiStore((s) => s.addAccountOpen)
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const userCard = useUiStore((s) => s.userCard)
  const [landscape, setLandscape] = useState(
    () => typeof window !== 'undefined' && window.innerWidth > window.innerHeight
  )
  /** which pane is expanded to the whole screen; null = the stack */
  const [focused, setFocused] = useState<string | null>(null)
  /**
   * Which pane owns the input row.
   *
   * A header and an input cost 106px, and on a three-way split that is 43% of the screen spent on
   * chrome instead of chat. Only one of the three can be typed into at a time, so only that one
   * carries an input; the other two give the space back to their messages.
   */
  const [writingIn, setWritingIn] = useState<string | null>(null)
  /** channel whose stream is playing above the chat; null = no player */
  const [playing, setPlaying] = useState<string | null>(null)

  useEffect(() => {
    loadConfig()
      .catch(() => false)
      .then((hadConfig) => {
        if (!useSettingsStore.getState().clientId && DEFAULT_CLIENT_ID) {
          useSettingsStore.getState().setClientId(DEFAULT_CLIENT_ID)
        }

        /*
         * Phone defaults, on the first run only.
         *
         * The 112px emote preview was sized for a monitor; on a phone it covers a good part of the
         * chat. 50px is the phone default — but only when there is no config yet, because after that
         * the number belongs to whoever set it and re-applying it on every launch would quietly undo
         * their choice.
         */
        if (!hadConfig) {
          useSettingsStore.getState().setSettings({
            emotePreviewSize: 50,
            chatEmoteHoverSize: 50
          })
        }
        /*
         * Nothing joins a channel on its own. The panes are only a view of the layout store; it is
         * this call that watches that store and opens the IRC connections behind it, which is why
         * the desktop makes it too. Without it the chat renders perfectly and stays empty forever.
         */
        /*
         * A phone has one window, so every "open this in its own window" preference has to be off.
         * These are not cosmetic: with them on, the emote picker button, the highlights star, the
         * user card and the mod-button link all call into a bridge that cannot open a window here,
         * and each one becomes a button that does nothing. Off, they all fall back to the in-app
         * panel the same code already knows how to render.
         */
        useSettingsStore.getState().setSettings({
          emotePickerAsWindow: false,
          highlightsAsWindow: false,
          settingsAsWindow: false,
          usercardAsWindow: false,
          whispersAsWindow: false
        })

        chatService.start()
        /*
         * And nothing writes anything back without this. It is why a channel added on the phone
         * was gone after the next launch: the config file had never been created at all.
         */
        startPersistence()
        setBooted(true)
      })
    return startConfigSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * Android's back button is the only way out of anything here.
   *
   * The shared dialogs were built for a desktop, where Escape and a click on the backdrop both
   * exist; a phone has neither, so a settings window opened by mistake was a dead end. Back now
   * closes the topmost thing and only leaves the app when there is nothing left to close.
   *
   * Escape is dispatched first rather than reaching into each component: the desktop handlers for it
   * are already written, and anything that learns to close on Escape later gets this for free.
   */
  useEffect(() => {
    const handle = CapApp.addListener('backButton', () => {
      const ui = useUiStore.getState()

      /*
       * The ban confirmation is answered before anything else, and answered "no". Back has always
       * meant "undo the thing I just started", and a pending promise left unresolved would sit there
       * holding the action open.
       */
      if (ui.modConfirm) {
        const pending = ui.modConfirm
        ui.setModConfirm(null)
        pending.resolve(false)
        return
      }

      // the message action sheet is the next layer down and has no backdrop of its own
      if (ui.heldMsgId) {
        ui.setHeldMsgId(null)
        document.querySelectorAll('.msg-row.touch-held').forEach((r) => r.classList.remove('touch-held'))
        return
      }

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      if (document.querySelector('.popover')) return
      /*
       * Settings answers Escape itself, and on a phone it is two screens deep: back leaves the
       * section first and the panel only from its front screen. Closing it from here would skip that.
       */
      if (ui.settingsOpen) return
      if (ui.addAccountOpen) return ui.setAddAccountOpen(false)
      if (ui.channelPrompt) return ui.setChannelPrompt(null)
      if (focused) return setFocused(null)
      void CapApp.minimizeApp()
    })
    return () => {
      void handle.then((h) => h.remove())
    }
  }, [focused])

  /*
   * Publish how tall the input row is right now.
   *
   * The emote picker and the link card both have to sit above it, and it is not a fixed height: it
   * grows as a message wraps onto more lines. A hardcoded 62px was right until the moment someone
   * typed a long message, and then the picker was back on top of the input again.
   */
  // keyed on `booted`: before that this component renders null, so there is no .m-app to measure in
  // and to observe — the effect used to run once against an empty document and give up for good
  useEffect(() => {
    const root = document.querySelector('.m-app') as HTMLElement | null
    if (!root) return
    const measure = (): void => {
      const area = document.querySelector('.m-pane.writing .input-area, .input-area') as HTMLElement | null
      root.style.setProperty('--m-input-h', `${Math.round(area?.getBoundingClientRect().height ?? 0)}px`)
    }
    measure()
    const ro = new ResizeObserver(measure)
    document.querySelectorAll('.input-area').forEach((el) => ro.observe(el))
    // the row is replaced when panes change, and it also grows on its own as text wraps
    window.addEventListener('sticki:inputgrew', measure)
    window.addEventListener('resize', measure)
    const poll = window.setInterval(measure, 1000)
    return () => {
      ro.disconnect()
      window.removeEventListener('sticki:inputgrew', measure)
      window.removeEventListener('resize', measure)
      window.clearInterval(poll)
    }
  }, [booted])

  useEffect(() => {
    const onResize = (): void => setLandscape(window.innerWidth > window.innerHeight)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  if (!booted) return null

  const tab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]
  const panes = tab ? tab.panes.slice(0, 3) : []
  const shown = focused ? panes.filter((p) => p.id === focused) : panes
  // a single pane always has its input; in a stack it follows the last pane touched
  const writer = shown.length === 1 ? shown[0]?.id : (writingIn ?? shown[0]?.id)

  return (
    <div className={`m-app ${landscape ? 'landscape' : 'portrait'} ${playing ? 'has-player' : ''}`}>
      <MobileTabStrip
        playing={playing}
        onTogglePlayer={(ch) => setPlaying((cur) => (cur === ch ? null : ch))}
      />

      {playing && <MobilePlayer channel={playing} onClose={() => setPlaying(null)} />}

      {/* the ⋮ in the strip sets this flag; without the modal mounted it set it into nothing */}
      {settingsOpen && <SettingsModal />}

      {/*
        Device-code login: a code on screen and a confirm in the browser — the one OAuth shape that
        needs no redirect back into the app.

        After the settings modal, deliberately. It is opened from inside settings, and with both at
        the same stacking level the later one wins — which put the settings pane on top of the login
        and swallowed every tap meant for it.
      */}
      {addAccountOpen && (
        <DeviceAuthModal onClose={() => useUiStore.getState().setAddAccountOpen(false)} />
      )}

      {/*
        The overlays the desktop shell mounts at its top level.

        Every one of these draws something the rest of the app only *asks* for through the ui store —
        a card, a preview, a toast. Not mounting them broke nothing visibly: the request was made and
        landed nowhere. That is why link previews looked dead while the tag beside the link had been
        fetching correctly all along, and why the result of an action never appeared anywhere.
      */}
      {userCard && <UserCard target={userCard} />}
      <EmoteHoverPreview />
      <LinkCard />
      <ChannelPrompt />
      <HypeTrainPopup />
      <Toasts />

      {/* above everything: it is the answer to a question the user is already being asked */}
      <ModConfirmSheet />

      {/*
        Reading needs no account: IRC lets an anonymous connection in, and the desktop has always
        allowed a channel to be opened that way. Only writing needs a login, so the missing account
        is a note above the chat, not a door in front of it.
      */}
      {!accounts.length && panes.length > 0 && (
        <button className="m-signin" onClick={() => useUiStore.getState().setAddAccountOpen(true)}>
          Читаєш анонімно — додати акаунт, щоб писати
        </button>
      )}

      {!panes.length ? (
        <div className="m-empty">
          <p>Ще немає жодного чату.</p>
          <p className="hint">Додай канал кнопкою + у смужці вкладок.</p>
          {!accounts.length && (
            <p className="hint">Акаунт потрібен лише щоб писати — читати можна без нього.</p>
          )}
        </div>
      ) : (
        <div className="m-stack" data-count={shown.length}>
          {shown.map((pane) => (
            <section
              key={pane.id}
              className={`m-pane ${pane.id === writer ? 'writing' : ''}`}
              // capture, so claiming the input never swallows a tap meant for a message
              onPointerDownCapture={() => setWritingIn(pane.id)}
            >
              {/* one chat of a stack can be pulled up to the whole screen and dropped back:
                  reading a fast chat needs the height, and the stack is for watching several */}
              {panes.length > 1 && (
                <button
                  className="m-expand"
                  title={focused ? 'Показати всі чати' : 'На весь екран'}
                  onClick={() => setFocused(focused ? null : pane.id)}
                >
                  {focused ? '⤡' : '⤢'}
                </button>
              )}
              <ChatPane tabId={tab.id} pane={pane} />
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
