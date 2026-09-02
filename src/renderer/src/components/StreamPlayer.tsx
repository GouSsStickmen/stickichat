import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../store/settings'
import { useUiStore, type PlayerSlot } from '../store/ui'
import { useT } from '../i18n'
import { PersonIcon, LayoutIcon, CloseIcon, TrayArrowIcon, GlobeIcon } from './Icons'

interface Props {
  channel: string
  /** the pane variant can be resized, detached and closed; the window variant fills its window */
  standalone?: boolean
  onClose?: () => void
  /**
   * Where the pane wants this player, and the pane box to resize against.
   *
   * A width drag has to measure against something that does not move. The player's own right edge
   * IS the thing being moved, so measuring from it fed every step back into the next one and the
   * column jumped around instead of following the cursor. Null when no pane is showing it, which
   * is also when there is nothing to drag.
   */
  slot?: PlayerSlot | null
}

/**
 * The stream, in Twitch's own embedded player.
 *
 * A <webview> rather than an <iframe> on purpose. The embed insists the `parent` parameter matches
 * the page holding it, and a packaged build is served from file://, which has no host to match. A
 * webview loads the player as its own top-level page, so the question does not arise.
 *
 * It also gets its own cookie jar, which is what makes signing in useful: a logged-in player knows
 * the viewer is subscribed and stops showing ads on that channel, exactly as the site would. The
 * app never reads anything out of that jar; the player uses it the way a browser tab does.
 *
 * Twitch's player is the only honest option here. The alternative is taking the playback token and
 * feeding the HLS to a player of our own, which exists mainly to skip ads; this app does not do
 * that, and Twitch stitches ads into the stream anyway, so it would not even work.
 */
export default function StreamPlayer({ channel, standalone, onClose, slot }: Props): React.JSX.Element {
  const t = useT()
  const side = useSettingsStore((s) => s.settings.playerSideBySide)
  const mode = useSettingsStore((s) => s.settings.playerMode)
  const hideChrome = useSettingsStore((s) => s.settings.playerHideSiteChrome)
  const boxRef = useRef<HTMLDivElement>(null)
  const wvRef = useRef<{ executeJavaScript: (code: string) => Promise<unknown> } | null>(null)

  /*
   * The player lives on a one-page local server rather than at player.twitch.tv directly, because
   * that is the only way to reach Twitch's embed SDK, and the SDK is the only thing that will say
   * how far behind live the video is. Until the port is known there is nothing to load.
   */
  const [port, setPort] = useState(0)
  useEffect(() => {
    void window.sticki.playerPort().then(setPort)
  }, [])

  /*
   * Latency on the full Twitch page, read off their own stats panel.
   *
   * The page gives it up nowhere else: no React tree on the video, no player object on window,
   * and seekable.end is the 2^30 sentinel rather than a time. Their "Статистика відео" panel does
   * print it, so this reads that, matched on the label's text rather than on a class name, since
   * the class names are generated afresh every build. It needs the panel switched on once in the
   * player settings; without it there is simply no number, which is the state this shipped in.
   */
  useEffect(() => {
    if (mode !== 'site') return
    const wv = wvRef.current
    if (!wv) return
    const read = `(() => {
      const label = [...document.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && /Затримка до стрімера|Latency To Broadcaster/i.test(e.textContent || '')
      )
      if (!label) return null
      const row = label.closest('tr') || label.parentElement
      const text = (row && row.textContent) || ''
      const m = text.match(/([0-9]+[.,][0-9]+|[0-9]+)\s*(сек|s\b)/i)
      return m ? parseFloat(m[1].replace(',', '.')) : null
    })()`
    const tick = (): void => {
      wv.executeJavaScript(read)
        .then((raw) => {
          const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
          useUiStore.getState().setStreamLatency(channel, n)
        })
        .catch(() => useUiStore.getState().setStreamLatency(channel, null))
    }
    tick()
    const id = window.setInterval(tick, 3000)
    return () => {
      window.clearInterval(id)
      useUiStore.getState().setStreamLatency(channel, null)
    }
  }, [mode, channel])

  useEffect(() => {
    if (mode !== 'embed' || !port) return
    const wv = wvRef.current
    if (!wv) return
    const id = window.setInterval(() => {
      wv.executeJavaScript('window.__stickiStats')
        .then((raw) => {
          const s = raw as { latency?: number } | null
          useUiStore
            .getState()
            .setStreamLatency(channel, typeof s?.latency === 'number' ? s.latency : null)
        })
        .catch(() => useUiStore.getState().setStreamLatency(channel, null))
    }, 3000)
    return () => {
      window.clearInterval(id)
      // the pane header must not keep showing a number for a player that is gone
      useUiStore.getState().setStreamLatency(channel, null)
    }
  }, [port, channel, mode])

  /*
   * Site mode is the whole of twitch.tv, not a player in a frame.
   *
   * It costs more to run and it is the only way to get the things that come from the page rather
   * than from the video: channel points tick up, watch streaks count, redemptions can be spent.
   * None of that reaches an embed, because an embed is not a viewer as far as Twitch is concerned.
   * Embed mode stays the default, and is the only one that can report latency.
   */
  const src =
    mode === 'site'
      ? `https://www.twitch.tv/${encodeURIComponent(channel)}`
      : port
        ? `http://localhost:${port}/?channel=${encodeURIComponent(channel)}`
        : ''

  /*
   * Twitch's own chat and menus, hidden.
   *
   * This app is already the chat, and a second one inside the video panel is both a waste of the
   * width and a way to reply from the wrong place. Done with data-a-target attributes rather than
   * class names, which are generated and change every build; if Twitch ever drops them the rule
   * simply matches nothing and the page looks normal.
   */
  useEffect(() => {
    if (mode !== 'site' || !hideChrome) return
    const wv = wvRef.current as unknown as {
      addEventListener?: (t: string, f: () => void) => void
      removeEventListener?: (t: string, f: () => void) => void
      insertCSS?: (css: string) => Promise<unknown>
      executeJavaScript?: (code: string) => Promise<unknown>
      sendInputEvent?: (e: { type: string; keyCode: string; modifiers: string[] }) => void
    } | null
    if (!wv?.addEventListener) return
    /*
     * Theatre mode, done with CSS rather than by pressing their button.
     *
     * Twitch's own toggle lives in a control bar that only exists while the pointer is over the
     * video, so there is nothing to click at load time, and firing its keyboard shortcut blind
     * would turn theatre OFF for anyone who already had it on. Hiding the furniture and letting
     * the player have the height reaches the same place and cannot get out of step with itself.
     */
    const css = `
      [data-a-target="right-column-chat-bar"],
      [data-a-target="right-column__toggle-collapse-btn"],
      .channel-root__right-column,
      .top-nav, [data-a-target="top-nav-container"],
      #sideNav, .side-nav,
      .channel-info-content,
      [data-a-target="channel-header-right"] { display: none !important; }
      .channel-root__player, .persistent-player { width: 100% !important; height: 100vh !important; }
      .channel-root, .channel-root__info { padding: 0 !important; }
      html, body { overflow: hidden !important; }
    `
    /*
     * Theatre mode, by pressing their own shortcut once per load.
     *
     * Alt+T is the player's own toggle and it acts on the page it is sent to, so one window going
     * into theatre leaves every other stream alone. Sent through sendInputEvent rather than a
     * synthetic KeyboardEvent, because the page listens for real key events; and only when the
     * player is not already filling the frame, so it cannot toggle theatre back OFF.
     */
    const theatre = (): void => {
      void wv
        .executeJavaScript?.(
          "(() => { const p = document.querySelector('.persistent-player'); " +
            "return !!p && p.getBoundingClientRect().width < window.innerWidth - 40 })()"
        )
        ?.then((needs: unknown) => {
          if (!needs) return
          for (const type of ['keyDown', 'char', 'keyUp'] as const) {
            wv.sendInputEvent?.({ type, keyCode: 't', modifiers: ['alt'] })
          }
        })
        ?.catch?.(() => {})
    }
    const apply = (): void => {
      void wv.insertCSS?.(css)?.catch?.(() => {})
      // after the page has had a moment to build its player
      window.setTimeout(theatre, 2500)
    }
    wv.addEventListener('dom-ready', apply)
    // a single-page app swaps channels without reloading, so re-apply on every navigation
    wv.addEventListener('did-navigate-in-page', apply)
    return () => {
      wv.removeEventListener?.('dom-ready', apply)
      wv.removeEventListener?.('did-navigate-in-page', apply)
    }
  }, [mode, hideChrome, channel])

  return (
    <div
      className={`stream-player ${standalone ? 'stream-player-standalone' : ''} ${
        side && !standalone ? 'stream-player-side' : ''
      }`}
      ref={boxRef}
    >
      {src && (
        <webview
          ref={wvRef as never}
          src={src}
          className="stream-webview"
          partition="persist:twitch-player"
        />
      )}
      <div className="stream-bar">
        <button
          className={`icon-btn ${mode === 'site' ? 'active' : ''}`}
          title={mode === 'site' ? t('player.modeSiteOn') : t('player.modeSiteOff')}
          onClick={() =>
            useSettingsStore
              .getState()
              .setSettings({ playerMode: mode === 'site' ? 'embed' : 'site' })
          }
        >
          <GlobeIcon size={15} />
        </button>
        <button
          className="icon-btn"
          title={t('player.signInWhy')}
          onClick={() => void window.sticki.twitchSignIn()}
        >
          <PersonIcon size={15} />
        </button>
        {standalone ? (
          <button
            className="icon-btn"
            title={t('player.attach')}
            onClick={() => void window.sticki.returnStream(channel)}
          >
            <TrayArrowIcon dir="in" size={14} />
          </button>
        ) : (
          <>
            <button
              className="icon-btn"
              title={t('player.layout')}
              onClick={() => useSettingsStore.getState().setSettings({ playerSideBySide: !side })}
            >
              {/* the icon shows what you would GET, which is the arrangement you are not in */}
              <LayoutIcon side={!side} size={15} />
            </button>
            <button
              className="icon-btn"
              title={t('player.detach')}
              onClick={() => {
                // "move to its own window" has to MOVE it: leaving the pane copy behind means two
                // players, two audio streams and twice the CPU, which is not what the button says
                void window.sticki.openStreamWindow(
                  `stream=${encodeURIComponent(channel)}`,
                  mode === 'embed'
                )
                onClose?.()
              }}
            >
              ⧉
            </button>
            <button className="icon-btn" title={t('player.hide')} onClick={onClose}>
              <CloseIcon size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
