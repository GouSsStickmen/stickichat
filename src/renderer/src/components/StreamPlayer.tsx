import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../store/settings'
import { useUiStore, type PlayerSlot } from '../store/ui'
import { useChatStore } from '../store/chat'
import { registerPlayerPage, readPoints, readStreak, claimBonus } from '../lib/playerPage'
import { useT } from '../i18n'
import {
  PersonIcon,
  LayoutIcon,
  CloseIcon,
  TrayArrowIcon,
  GlobeIcon,
  SpeakerIcon
} from './Icons'

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
  /**
   * Ask the guest page something, without being able to bring the app down.
   *
   * executeJavaScript throws SYNCHRONOUSLY when the webview is not attached and dom-ready has not
   * fired, so a .catch on the promise never sees it: the error escaped the poller, escaped React,
   * and took the whole interface with it. Every call goes through here, and a page that is not
   * there yet simply answers null.
   *
   * Deliberately not gated on the ready flag as well. That flag is set from an event which can
   * fire before anything is listening, and while it was in the way a perfectly working points poll
   * read the balance and threw every reading away.
   */
  const ask = (code: string): Promise<unknown> => {
    try {
      const wv = wvRef.current
      if (!wv) return Promise.resolve(null)
      return wv.executeJavaScript(code).catch(() => null)
    } catch {
      // thrown outright before the guest attaches: that is a "not yet", not a failure
      return Promise.resolve(null)
    }
  }

  const t = useT()
  const side = useSettingsStore((s) => s.settings.playerSideBySide)
  const mode = useSettingsStore((s) => s.settings.playerMode)
  const hideChrome = useSettingsStore((s) => s.settings.playerHideSiteChrome)
  const muted = useUiStore((s) => s.mutedPlayers.includes(channel))
  const boxRef = useRef<HTMLDivElement>(null)
  const wvRef = useRef<{ executeJavaScript: (code: string) => Promise<unknown> } | null>(null)
  /** the guest has loaded at least once; nothing may be asked of it before that */
  const [ready, setReady] = useState(false)

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
   * the class names are generated afresh every build.
   *
   * The panel is switched on here rather than left to the viewer: it lives three levels into the
   * player's own settings, and their menu ignores a synthetic click, so it takes a real press on
   * the gear followed by their Advanced submenu. Our stylesheet then hides the table itself, so
   * the video stays clean and the number comes out in the app's own line instead.
   *
   * This is what the browser extensions that show latency do as well, without the download.
   */
  useEffect(() => {
    // not gated on ready: that flag is set from an event that can fire before anything listens,
    // and asking the page too early simply answers null
    if (mode !== 'site') return
    const read = `(() => {
      const label = [...document.querySelectorAll('*')].find(
        // their label reads "Затримка до стримера": matched loosely, because one letter of it
        // spelled differently in our own code is exactly why this number never appeared
        (e) => e.children.length === 0 && /Затримка до стр|Latency To Broadcaster/i.test(e.textContent || '')
      )
      if (!label) return null
      const row = label.closest('tr') || label.parentElement
      const text = (row && row.textContent) || ''
      const m = text.match(/([0-9]+[.,][0-9]+|[0-9]+)[^0-9]{0,3}(сек|sec)/i)
      return m ? parseFloat(m[1].replace(',', '.')) : null
    })()`
    const tick = (): void => {
      void ask(read).then((raw) => {
        const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
        useUiStore.getState().setStreamLatency(channel, n)
      })
    }
    const rest = (ms: number): Promise<void> => new Promise((done) => window.setTimeout(done, ms))
    const pressAt = (x: number, y: number): void => {
      const view = wvRef.current as unknown as {
        sendInputEvent?: (e: Record<string, unknown>) => void
      } | null
      const send = (e: Record<string, unknown>): void => {
        try {
          view?.sendInputEvent?.(e)
        } catch {
          /* the view can go away mid-press */
        }
      }
      send({ type: 'mouseMove', x, y })
      window.setTimeout(() => send({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }), 140)
      window.setTimeout(() => send({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }), 230)
    }
    const ensureStats = async (): Promise<void> => {
      // the overlay is drawn a little after the player, so a single look can miss one that is
      // already on, and pressing the switch then turns it OFF
      for (let i = 0; i < 8; i++) {
        const have = await ask(
          `!!document.querySelector('[data-a-target="player-overlay-video-stats"]')`
        )
        if (have === true) return
        await rest(600)
      }
      const at = (await ask(`(() => {
        const g = document.querySelector('[data-a-target="player-settings-button"]')
        if (!g) return null
        const r = g.getBoundingClientRect()
        return r.width ? [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] : null
      })()`)) as number[] | null
      if (!Array.isArray(at)) return
      pressAt(at[0], at[1])
      await rest(1500)
      await ask(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const adv = document.querySelector('[data-a-target="player-settings-menu-item-advanced"]')
        if (!adv) return false
        adv.click()
        await wait(900)
        const box = document.querySelector('[data-a-target="player-settings-submenu-advanced-video-stats"]')
        const input = box && (box.querySelector('input[type="checkbox"]') || box.querySelector('input'))
        if (!input) return false
        // their switch is remembered per account: only press it when it is actually off
        if (!input.checked) input.click()
        await wait(800)
        return true
      })()`)
      // their menu closes the way it opened: with a real press on the gear
      pressAt(at[0], at[1])
      await rest(600)
    }
    let alive = true
    void (async () => {
      await ensureStats()
      if (alive) tick()
    })()
    const id = window.setInterval(tick, 5000)
    return () => {
      alive = false
      window.clearInterval(id)
      useUiStore.getState().setStreamLatency(channel, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, channel])

  useEffect(() => {
    if (mode !== 'embed' || !port || !ready) return
    const id = window.setInterval(() => {
      void ask('window.__stickiStats').then((raw) => {
        const st = raw as { latency?: number } | null
        useUiStore
          .getState()
          .setStreamLatency(channel, typeof st?.latency === 'number' ? st.latency : null)
      })
    }, 3000)
    return () => {
      window.clearInterval(id)
      // the pane header must not keep showing a number for a player that is gone
      useUiStore.getState().setStreamLatency(channel, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, channel, mode, ready])

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
  /*
   * The page, offered to the rest of the app, and read for points.
   *
   * Only site mode has a real Twitch page in it, so that is the only mode that registers one and
   * the only mode with points at all. The poll is every five seconds: the balance ticks up on its
   * own as you watch, and a bonus chest appears roughly every quarter of an hour, which nothing
   * notifies us about.
   */
  useEffect(() => {
    if (mode !== 'site') {
      registerPlayerPage(channel, null)
      useUiStore.getState().setPlayerPoints(channel, null)
      return
    }
    /*
     * Typing into the page's own chat box, as real keystrokes.
     *
     * Measured on "Виділити моє повідомлення": execCommand puts the text in the box visually but
     * their editor never learns about it, so Enter and even their own send button do nothing.
     * Character events into the focused box are typed for real and go through, and the points are
     * spent exactly as they are for a person typing.
     */
    const typeAndSend = async (words: string): Promise<void> => {
      const view = wvRef.current as unknown as {
        focus?: () => void
        sendInputEvent?: (e: Record<string, unknown>) => void
      } | null
      if (!view?.sendInputEvent) return
      await ask(`(() => {
        const box = document.querySelector('[data-a-target="chat-input"]')
        if (!box) return false
        box.focus()
        const sel = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(box)
        sel.removeAllRanges()
        sel.addRange(range)
        document.execCommand('delete')
        return true
      })()`)
      const rest = (ms: number): Promise<void> => new Promise((done) => window.setTimeout(done, ms))
      view.focus?.()
      await rest(250)
      for (const ch of words) {
        view.sendInputEvent({ type: 'char', keyCode: ch })
        await rest(45)
      }
      await rest(400)
      view.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      view.sendInputEvent({ type: 'char', keyCode: 'Return' })
      view.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
      await rest(600)
    }
    registerPlayerPage(channel, { ask, typeAndSend })
    let stop = false
    const tick = async (): Promise<void> => {
      const now = await readPoints(channel)
      if (stop || !now) return
      useUiStore.getState().setPlayerPoints(channel, now)
      if (now.chest && useSettingsStore.getState().settings.playerAutoClaim) {
        await claimBonus(channel)
      }
    }
    /*
     * The streak is read far more rarely than the balance.
     *
     * It only exists inside the rewards panel, so reading it means opening that panel in the page,
     * and it changes once a stream rather than once a minute. Once on the way in, then every five
     * minutes, which is often enough to catch the moment it goes up while you are watching.
     */
    const readTheStreak = async (): Promise<void> => {
      // opening their panel while nobody is looking at the app is pure waste
      if (document.hidden) return
      const st = await readStreak(channel)
      if (stop || !st) return
      /*
       * Whether THIS stream has been counted, which is a different question from what the streak
       * is. Twitch says nothing about it directly, so it is watched for: the streak that stood
       * when this stream began is kept, and the moment the number goes above it the stream has
       * counted. That verdict then holds until the next stream starts, the way the flame on Twitch
       * stays lit for the rest of the evening.
       */
      const started = useChatStore.getState().streamInfo[channel]?.startedAt ?? null
      const had = useUiStore.getState().playerPoints[channel]
      const fresh = !had || had.streakStream !== started
      const base = fresh ? st.streak : had.streakBase
      const claimed = fresh
        ? false
        : had.streakClaimed || (st.streak !== null && base !== null && st.streak > base)
      useUiStore.getState().setPlayerPoints(channel, {
        streak: st.streak,
        streakLeft: st.left,
        streakReward: st.reward,
        streakBase: base,
        streakStream: started,
        streakClaimed: claimed
      })
    }
    void tick()
    window.setTimeout(() => void readTheStreak(), 9000)
    /*
     * Deliberately slow.
     *
     * The balance creeps up on its own and a chest waits several minutes to be taken, so eight
     * seconds loses nothing; the streak lives inside a panel that has to be opened in the page to
     * be read, which is real work in their process, and it changes once a stream. Nothing here is
     * a fix for anything, it is simply the least often each one can run and still be right.
     */
    const timer = window.setInterval(() => void tick(), 8000)
    const streakTimer = window.setInterval(() => void readTheStreak(), 900000)
    return () => {
      stop = true
      window.clearInterval(timer)
      window.clearInterval(streakTimer)
      registerPlayerPage(channel, null)
    }
    // ask is rebuilt on every render by design, and asking too early simply answers null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, channel])

  /*
   * Silence the view, not the player.
   *
   * setAudioMuted is what a browser does to a muted tab: the page goes on playing and only the
   * sound is dropped, so Twitch still counts the stream as watched and the channel points keep
   * coming. Turning their volume down instead would stop both.
   *
   * Re-applied when the player says it is ready, because a reloaded page comes back unmuted.
   */
  useEffect(() => {
    const view = wvRef.current as unknown as { setAudioMuted?: (m: boolean) => void } | null
    try {
      view?.setAudioMuted?.(muted)
    } catch {
      /* not there yet: the ready pass below will catch it */
    }
  }, [muted, ready, mode])

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
    /*
     * The chat column goes invisible and deaf, rather than away.
     *
     * In theatre mode it is .right-column--theatre: fixed, 340px wide, the full height of the page
     * and at z-index 3001, which puts it over the right edge of the video. Hiding only its contents
     * left an invisible strip there that still took the mouse, so the pointer crossing it counted
     * as leaving the video: the control bar hid itself exactly as you reached for the gear, and the
     * gear could not be clicked at all. Narrowing the window seemed to cure it only because Twitch
     * drops the column itself at small widths.
     *
     * display:none would also fix that, and did, but it takes the column out of the layout, and
     * the channel points live in there: with no box to open against, their rewards panel never
     * opens and the streak and the reward list cannot be read at all. Transparent and
     * pointer-events:none keeps every one of those working while the mouse passes straight through.
     *
     * No comments inside this string: one in the selector list stops the whole block applying.
     */
    const css = `
      [data-a-target="right-column__toggle-collapse-btn"],
      .top-nav, [data-a-target="top-nav-container"],
      #sideNav, .side-nav,
      .channel-info-content,
      [data-a-target="channel-header-right"] { display: none !important; }
      .channel-root__player, .persistent-player { width: 100% !important; }
      .channel-root, .channel-root__info { padding: 0 !important; }
      [data-a-target="player-overlay-video-stats"] {
        opacity: 0 !important;
        pointer-events: none !important;
      }
      .right-column, .right-column--theatre, .channel-root__right-column {
        opacity: 0 !important;
        pointer-events: none !important;
      }
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
    /*
     * Theatre mode, by pressing their own button.
     *
     * Not the keyboard shortcut: that needs the page to have focus, and it does not right after
     * loading. The button carries no data-a-target, but its label always ends in "(alt+t)" in
     * every language, which is a steadier handle than a generated class name. It only exists while
     * the control bar is up, so the pointer is faked over the player first, and it is only pressed
     * when the video is not already filling the height, so theatre cannot get switched back off.
     */
    /*
     * Theatre mode, as soon as the page can take it.
     *
     * One attempt is not enough: nothing responds until the player has built itself, and how long
     * that takes depends on the stream. So this keeps asking every 1.2s for ten tries and stops the
     * moment the player fills the height, which is also the check that keeps it from ever switching
     * theatre back off for someone who already had it on.
     */
    let tries = 0
    let timer = 0
    const tryTheatre = (): void => {
      const view = wvRef.current
      if (!view) return
      const el = view as unknown as {
        focus?: () => void
        sendInputEvent?: (e: Record<string, unknown>) => void
        executeJavaScript?: (code: string) => Promise<unknown>
      }
      let p: Promise<unknown>
      try {
        p =
          el.executeJavaScript?.(`(() => {
            const pl = document.querySelector('.persistent-player')
            if (!pl) return 'waiting'
            return pl.getBoundingClientRect().height > window.innerHeight - 60 ? 'done' : 'go'
          })()`) ?? Promise.resolve('waiting')
      } catch {
        p = Promise.resolve('waiting')
      }
      void p
        .then((res) => {
          if (res === 'done') return
          if (res === 'go') {
            /*
             * Their own shortcut, sent as real keys.
             *
             * Pressing the button in the control bar is not an option: on a page whose furniture we
             * have hidden Twitch does not put a theatre button there at all, only play, volume,
             * settings and fullscreen. Alt+T does the same job, and measured it takes the player
             * from 619 to the full 779 of the frame and turns their own icon into "leave theatre
             * mode", which is the state the stream should open in.
             *
             * The keys need the page to have them, so focus goes to the view and straight back to
             * whatever had it, or a message half typed in chat would lose its box.
             */
            const had = document.activeElement as HTMLElement | null
            try {
              el.focus?.()
              const key = (type: string, keyCode: string, modifiers: string[]): void =>
                el.sendInputEvent?.({ type, keyCode, modifiers })
              key('keyDown', 'Alt', ['alt'])
              key('keyDown', 't', ['alt'])
              key('char', 't', ['alt'])
              key('keyUp', 't', ['alt'])
              key('keyUp', 'Alt', [])
            } catch {
              /* the view can go while this runs */
            }
            window.setTimeout(() => {
              // nothing had it: let it go rather than leave the stream eating every keystroke
              if (had && had !== document.body) had.focus?.()
              else (el as unknown as { blur?: () => void }).blur?.()
            }, 60)
          }
          if (++tries < 10) timer = window.setTimeout(tryTheatre, 1200)
        })
        .catch(() => {
          if (++tries < 10) timer = window.setTimeout(tryTheatre, 1200)
        })
    }

    const apply = (): void => {
      /*
       * As a style tag in the page, not through insertCSS.
       *
       * Measured: the sheet insertCSS puts in does hide the top bar and the channel info, and does
       * nothing at all to the chat column, while the very same rule in a style tag hides it. So the
       * rules go where they are known to land. The id keeps it to one tag no matter how often this
       * runs.
       */
      try {
        void wv
          .executeJavaScript?.(
            `(() => {
              let el = document.getElementById('sticki-chrome')
              if (!el) {
                el = document.createElement('style')
                el.id = 'sticki-chrome'
                document.head.appendChild(el)
              }
              el.textContent = ${JSON.stringify(css)}
              return 1
            })()`
          )
          ?.catch?.(() => {})
      } catch {
        /* thrown outright when the guest is not up yet; the next apply catches it */
      }
      tries = 0
      window.clearTimeout(timer)
      // straight away, then again each second until the player exists and takes it
      tryTheatre()
    }
    wv.addEventListener('dom-ready', apply)
    // a single-page app swaps channels without reloading, so re-apply on every navigation
    wv.addEventListener('did-navigate-in-page', apply)
    return () => {
      window.clearTimeout(timer)
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
          ref={(el) => {
            wvRef.current = el as never
            if (!el) {
              setReady(false)
              return
            }
            /*
             * Readiness is asked for, not waited for.
             *
             * dom-ready says executeJavaScript will not throw, and listening for it worked right
             * up until the listener was attached after it had already fired: a re-render that
             * detaches and re-attaches the element, or a hot reload, and the flag stayed false for
             * good. Everything that needs the page then went quiet, including the points poll.
             * Asking the view a trivial question until it answers cannot miss its moment.
             */
            const on = (): void => setReady(true)
            ;(el as unknown as { addEventListener: (t: string, f: () => void) => void }).addEventListener(
              'dom-ready',
              on
            )
            const view = el as unknown as { executeJavaScript?: (c: string) => Promise<unknown> }
            let tries = 0
            const probe = window.setInterval(() => {
              if (tries++ > 40) return window.clearInterval(probe)
              try {
                void view.executeJavaScript?.('1')?.then(
                  () => {
                    window.clearInterval(probe)
                    setReady(true)
                  },
                  () => {}
                )
              } catch {
                /* not attached yet: that is what the next round is for */
              }
            }, 500)
          }}
          src={src}
          className="stream-webview"
          partition="persist:twitch-player"
        />
      )}
      <div className="stream-bar">
        <button
          className={`icon-btn mute-btn ${muted ? 'is-muted' : ''}`}
          title={muted ? t('player.unmute') : t('player.mute')}
          onClick={() => useUiStore.getState().setPlayerMuted(channel, !muted)}
        >
          <SpeakerIcon muted={muted} size={17} />
        </button>
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
