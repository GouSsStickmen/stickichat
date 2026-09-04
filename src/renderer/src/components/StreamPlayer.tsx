import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../store/settings'
import { useUiStore, type PlayerSlot } from '../store/ui'
import { useChatStore } from '../store/chat'
import {
  registerPlayerPage,
  readPoints,
  readStreak,
  claimBonus,
  readPoll,
  readDrops,
  readBarShare,
  readPagePrediction
} from '../lib/playerPage'
import { translate, useT } from '../i18n'
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
  /** which page we have already offered to switch the video stats on for */
  const statsTried = useRef('')
  /** clears the finished poll a minute after the page drops it */
  const pollGone = useRef(0)
  /** when their prediction panel was last opened to read a card the topics never sent */
  const predRead = useRef(0)
  /** undoes whatever the last webview element had attached to it */
  const wvWatch = useRef<(() => void) | null>(null)

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
    /*
     * Switching their video stats on, in a way that does not depend on timing.
     *
     * Every step used to be a guess at how long the last one would take, and mostly the guess was
     * wrong: the menu had not rendered when we looked for "Розширені", so nothing was pressed and
     * the settings menu was left standing open over the video. Now each step waits for the thing
     * it needs, the result is checked, and the menu is closed whether or not any of it worked.
     */
    const gearAt = async (): Promise<number[] | null> => {
      const at = (await ask(`(() => {
        const g = document.querySelector('[data-a-target="player-settings-button"]')
        if (!g) return null
        const r = g.getBoundingClientRect()
        if (!r.width) return null
        const x = Math.round(r.left + r.width / 2)
        const y = Math.round(r.top + r.height / 2)
        // only worth pressing if the gear is what a press there would hit
        const top = document.elementFromPoint(x, y)
        if (!top || !(top === g || g.contains(top) || top.contains(g))) return null
        return [x, y]
      })()`)) as number[] | null
      return Array.isArray(at) ? at : null
    }
    const menuOpen = (): Promise<unknown> =>
      ask(`!!document.querySelector('[data-a-target="player-settings-menu"]')`)
    const closeMenu = async (at: number[] | null): Promise<void> => {
      /*
       * Closed with their own button, never with Escape.
       *
       * Escape does close the settings menu, and it also leaves theatre mode, so switching the
       * stats on quietly undid the theatre mode the player had just been put into.
       */
      for (let i = 0; i < 3; i++) {
        if ((await menuOpen()) !== true) return
        if (!at) return
        pressAt(at[0], at[1])
        await rest(700)
      }
    }
    const statsOn = (): Promise<unknown> =>
      ask(`!!document.querySelector('[data-a-target="player-overlay-video-stats"]')`)
    const waitFor = async (code: string, tries: number): Promise<boolean> => {
      for (let i = 0; i < tries; i++) {
        if ((await ask(code)) === true) return true
        await rest(400)
      }
      return false
    }
    const ensureStats = async (): Promise<void> => {
      // the overlay is drawn a little after the player, and pressing the switch on one that is
      // already on turns it OFF, so it gets a fair look first
      if (await waitFor(`!!document.querySelector('[data-a-target="player-overlay-video-stats"]')`, 10)) {
        return
      }
      /*
       * Wait for the gear as long as it takes, then press it at most twice.
       *
       * The player takes ten to fifteen seconds to build itself on a slow join, so the waiting has
       * to be patient; the pressing must not be. A loop that kept trying kept opening their
       * settings menu over the video, which is worse than having no latency reading. Pressing
       * blindly at remembered coordinates is worse still: on a bar that has moved, that press
       * lands on the video and pauses the stream, so the point is checked first.
       */
      let at: number[] | null = null
      for (let wait = 0; wait < 20 && !at; wait++) {
        at = await gearAt()
        if (!at) await rest(3000)
      }
      if (!at) return
      for (let attempt = 0; attempt < 2; attempt++) {
        pressAt(at[0], at[1])
        const menu = await waitFor(
          `!!document.querySelector('[data-a-target="player-settings-menu-item-advanced"]')`,
          10
        )
        if (!menu) {
          await closeMenu(at)
          continue
        }
        await ask(`(() => {
          const adv = document.querySelector('[data-a-target="player-settings-menu-item-advanced"]')
          if (adv) adv.click()
          return true
        })()`)
        const submenu = await waitFor(
          `!!document.querySelector('[data-a-target="player-settings-submenu-advanced-video-stats"]')`,
          10
        )
        if (submenu) {
          await ask(`(() => {
            const box = document.querySelector('[data-a-target="player-settings-submenu-advanced-video-stats"]')
            const input = box && (box.querySelector('input[type="checkbox"]') || box.querySelector('input'))
            if (!input) return false
            // their switch is remembered per account: only press it when it is actually off
            if (!input.checked) input.click()
            return true
          })()`)
          await waitFor(`!!document.querySelector('[data-a-target="player-overlay-video-stats"]')`, 8)
        }
        await closeMenu(at)
        if ((await statsOn()) === true) return
      }
    }
    let alive = true
    void (async () => {
      // once for this page: a remount must not send it round again
      if (statsTried.current !== src) {
        statsTried.current = src
        await ensureStats()
      }
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
   * What is running in the page: their poll builder, and the poll or prediction itself.
   *
   * The builder is theirs to draw, so it is only lifted out of the hidden column into the middle
   * of the picture. The poll is copied out and drawn by the app at the top of the chat: their card
   * flickered over the video as their React redrew it, and the chat is where it belongs anyway.
   * Voting still goes to their buttons, since nothing else can cast a vote.
   */
  useEffect(() => {
    if (mode !== 'site') return
    /** the effect has been torn down: a reading in flight must not write to a gone channel */
    let gone = false
    const look = `(() => {
      const col = document.querySelector('.right-column') || document.body
      /*
       * Their own dialogs, in case one opens inside the column we hide.
       *
       * "/poll" opens Twitch's poll builder through the chat settings, and that would be filled in
       * blind in there, so it is lifted to the middle of the picture. A dialog rendered at the top
       * of the page, which is the usual case, never matches this and is left where it is.
       *
       * The running poll itself is NOT surfaced: it is read out of the page instead and the app
       * draws it at the top of the chat, because over the video it flickered every time their React
       * redrew the card, and the chat is where it was wanted.
       */
      const builder = [...col.querySelectorAll('div,section,form')].filter((e) => {
        const t = (e.textContent || '').trim()
        if (!/^(Створити нове опитування|Створити прогноз|Create a new poll|Create a prediction)/i.test(t)) {
          return false
        }
        return e.getBoundingClientRect().height > 120
      })
      const dialog =
        col.querySelector('[role="dialog"]') ??
        builder.sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0]
      const marked = [...document.querySelectorAll('.sticki-modal, .sticki-surfaced')]
      for (const e of marked) if (e !== dialog) e.classList.remove('sticki-modal', 'sticki-surfaced')
      if (!dialog) return null
      dialog.classList.add('sticki-modal')
      return 'dialog'
    })()`
    const tick = (): void => {
      void ask(look)
      /*
       * Their share bar over the chat box, while it is up.
       *
       * This one has a clock on it: when it runs out the offer drops into the chat and scrolls
       * away with the messages, so it has to be caught while it is there. One look for a button in
       * the chat column, on the same few seconds as everything else here.
       */
      void readBarShare(channel).then((prompt) => {
        if (gone) return
        useUiStore.getState().setPlayerShare(channel, prompt, 'bar')
      })
      /*
       * A prediction the topics have not told us about.
       *
       * They only speak when something happens, so a prediction that started before the app did —
       * or before it reloaded — leaves nothing to draw a card from, while the prediction itself is
       * plainly still running in the page. This notices that and reads it out of their panel.
       *
       * Only when there is no card at all, and at most once every twenty seconds, because reading
       * it means opening their panel.
       */
      const haveCard = (useUiStore.getState().pagePolls[channel] ?? []).some((c) => c.isPrediction)
      if (!haveCard && Date.now() - predRead.current > 20000) {
        predRead.current = Date.now()
        void readPagePrediction(channel).then((pred) => {
          if (gone || !pred || pred.options.length < 2) return
          const ui = useUiStore.getState()
          if ((ui.pagePolls[channel] ?? []).some((c) => c.isPrediction)) return
          ui.setPagePoll(channel, {
            id: 'prediction',
            kind: translate(useSettingsStore.getState().settings.language, 'poll.prediction'),
            question: pred.question,
            options: pred.options.map((o) => ({
              label: o.label,
              share: o.share,
              votes: o.votes,
              picked: false,
              mine: 0
            })),
            open: true,
            locked: false,
            voted: false,
            ended: false,
            timeLeft: pred.timeLeft,
            ran: null,
            endsAt: null,
            runsFor: null,
            isPrediction: true,
            winner: null,
            payouts: []
          })
        })
      }
      void readPoll(channel).then((poll) => {
        const ui = useUiStore.getState()
        if (poll) {
          window.clearTimeout(pollGone.current)
          /*
           * Two sources, one card, and each owns what it actually knows.
           *
           * Twitch's poll and prediction topics know the state: how long is left, how the votes
           * stand, and the moment it is over. The page knows one thing the topics never say,
           * which is whether THIS account has taken part, and it is also the only way to cast a
           * vote. So a reading of the page contributes that and nothing else once the topic has
           * spoken; it is used whole only when the topic has said nothing, which is what happens
           * for something that started before the app was running.
           *
           * Taken whole it did real harm: a prediction has no "Голосувати" button at all, so the
           * page reading declared voting closed and greyed out every outcome.
           */
          /*
           * The page's reading is the fallback, under the id "page".
           *
           * A channel can run a poll and a prediction at once and Twitch shows both, so the topics
           * are the source of truth per id. The page cannot tell one from the other, so it only
           * fills in for a card the topics have not mentioned at all, which is what happens for
           * something that started before the app was running.
           */
          const list = ui.pagePolls[channel] ?? []
          const fromTopic = list.find((p) => p.id !== 'page')
          if (fromTopic) {
            // the one thing only the page knows: whether this account has taken part
            for (const p of list) ui.setPagePoll(channel, { ...p, voted: poll.voted }, p.id)
            return
          }
          ui.setPagePoll(channel, {
            ...poll,
            id: 'page',
            ended: false,
            endsAt: null,
            runsFor: null,
            isPrediction: false,
            locked: false,
            winner: null,
            payouts: []
          })
          return
        }
        /*
         * The page has nothing to say. That is not the same as "it is over".
         *
         * When the state came from Twitch's own topic, the topic is what ends it: predictions in
         * particular are not in the page in a shape this reader knows, and taking that silence for
         * an ending marked a running prediction "завершено" within seconds of it starting. Only a
         * card we learned about from the page alone is ended by the page dropping it.
         */
        const had = (ui.pagePolls[channel] ?? []).find((p) => p.id === 'page')
        if (!had || had.ended) return
        ui.setPagePoll(channel, { ...had, open: false, ended: true }, 'page')
        window.clearTimeout(pollGone.current)
        pollGone.current = window.setTimeout(
          () => useUiStore.getState().dismissPagePoll(channel, 'page'),
          60000
        )
      })
    }
    tick()
    const id = window.setInterval(tick, 4000)
    return () => {
      gone = true
      window.clearInterval(id)
      useUiStore.getState().setPagePoll(channel, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, channel])

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
      const rest = (ms: number): Promise<void> => new Promise((done) => window.setTimeout(done, ms))
      const view = wvRef.current as unknown as {
        focus?: () => void
        sendInputEvent?: (e: Record<string, unknown>) => void
      } | null
      if (!view?.sendInputEvent) return
      /*
       * The column has to be focusable for the length of this, and hidden is not focusable.
       *
       * The chat box lives in the column we hide, and visibility:hidden takes an element out of the
       * focus order entirely: box.focus() did nothing, so the characters went nowhere near Twitch
       * and landed in the app instead, which is how a /poll ended up opening our own settings. For
       * the few seconds of typing the column is made visible and completely transparent, which
       * focuses fine and shows nothing.
       */
      const grab = `(() => {
        for (const c of document.querySelectorAll('.right-column, .channel-root__right-column')) {
          c.classList.add('sticki-typing')
        }
        const box = document.querySelector('[data-a-target="chat-input"]')
        if (!box) return false
        box.focus()
        const sel = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(box)
        sel.removeAllRanges()
        sel.addRange(range)
        document.execCommand('delete')
        return document.activeElement === box
      })()`
      const boxText = `(() => {
        const box = document.querySelector('[data-a-target="chat-input"]')
        return box ? (box.innerText || '').trim() : null
      })()`
      const release = `(() => {
        for (const c of document.querySelectorAll('.sticki-typing')) c.classList.remove('sticki-typing')
        return true
      })()`
      const type = async (): Promise<boolean> => {
        // focus first, and check it took: without it the keystrokes go to the app
        let held = false
        for (let i = 0; i < 5 && !held; i++) {
          held = (await ask(grab)) === true
          if (!held) await rest(400)
        }
        if (!held) return false
        /*
         * And wait for the guest to actually HAVE the keyboard.
         *
         * webview.focus() is a request, not a fact: the first command after the app itself had
         * focus went out while the guest was still catching up, the characters fell into our own
         * input instead, and only a second attempt worked. So our field lets go first, the view is
         * asked for focus, and the page is given three seconds to say it has it.
         *
         * Not a hard requirement, mind: document.hasFocus() is false whenever the app window is
         * not the focused window at all, and what really decides this is whether the characters
         * landed, which the check after typing does.
         */
        const had = document.activeElement as HTMLElement | null
        had?.blur?.()
        view.focus?.()
        for (let i = 0; i < 15; i++) {
          await rest(200)
          const armed =
            (await ask(`(() => {
              const box = document.querySelector('[data-a-target="chat-input"]')
              return !!box && document.hasFocus() && document.activeElement === box
            })()`)) === true
          if (armed) break
          view.focus?.()
        }
        for (const ch of words) {
          view.sendInputEvent?.({ type: 'char', keyCode: ch })
          await rest(25)
        }
        await rest(400)
        // and check the box really holds what was typed before committing to Enter
        return (await ask(boxText)) === words
      }
      try {
        let typed = false
        for (let attempt = 0; attempt < 3 && !typed; attempt++) typed = await type()
        if (!typed) return
        /*
         * Enter until the box is empty, because the first one is not a send.
         *
         * Typing "/..." opens Twitch's own command autocomplete, and Enter there PICKS the
         * suggestion rather than sending the line: the text sat in their box, nothing happened, and
         * the command only went out when it was typed a second time. This is that second press,
         * made automatic, and it stops as soon as the box is clear.
         */
        for (let press = 0; press < 3; press++) {
          view.sendInputEvent?.({ type: 'keyDown', keyCode: 'Return' })
          view.sendInputEvent?.({ type: 'char', keyCode: 'Return' })
          view.sendInputEvent?.({ type: 'keyUp', keyCode: 'Return' })
          await rest(500)
          if ((await ask(boxText)) === '') break
        }
      } finally {
        await ask(release)
      }
    }
    /*
     * A real click, for the buttons that will not take a synthetic one.
     *
     * Same events the video-stats gear needs, and for the same reason. The caller makes the target
     * hittable first (their panels live in a column we make click-through), then hands over the
     * point to press.
     */
    const pressAt = async (x: number, y: number): Promise<void> => {
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
      const rest = (ms: number): Promise<void> => new Promise((done) => window.setTimeout(done, ms))
      send({ type: 'mouseMove', x, y })
      await rest(120)
      send({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      await rest(90)
      send({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      await rest(120)
    }
    registerPlayerPage(channel, { ask, typeAndSend, pressAt })
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
    const readTheStreak = async (): Promise<boolean> => {
      // opening their panel while nobody is looking at the app is pure waste
      if (document.hidden) return false
      const st = await readStreak(channel)
      if (stop || !st) return false
      useUiStore.getState().setPlayerPoints(channel, {
        streak: st.streak,
        streakLeft: st.left,
        streakReward: st.reward,
        streakClaimed: st.counted
      })
      // their "share this" offer sits in the same footer, and stays there until it is shared
      useUiStore.getState().setPlayerShare(channel, st.share, 'panel')
      return st.streak !== null
    }
    /*
     * Keep asking until the page answers once.
     *
     * The panel cannot open until the page has built itself, which takes ten to fifteen seconds on
     * a slow join, and a single early attempt followed by the quarter hourly one meant the flame
     * sat on the number chat had guessed for fifteen minutes.
     */
    const firstStreak = async (): Promise<void> => {
      for (let i = 0; i < 20 && !stop; i++) {
        if (await readTheStreak()) return
        await new Promise((done) => window.setTimeout(done, 15000))
      }
    }
    /*
     * Drops, read the same way and about as rarely.
     *
     * Their chest is only in the chat bar of a channel that has a campaign running, and reading
     * what is in it means opening their panel, so this asks once the page is up and then every
     * three minutes. Progress moves in quarter hours, so nothing is lost by not asking oftener,
     * and a drop that lands is caught within a minute or two of landing.
     */
    const readTheDrops = async (): Promise<boolean> => {
      if (document.hidden) return false
      const info = await readDrops(channel)
      if (stop || !info) return false
      // passed through as it came: the store is what knows that a chest going away means a claim
      useUiStore.getState().setPlayerDrops(channel, info)
      // an answer worth stopping for: either there are no drops here, or we have read them
      return !info.any || info.items.length > 0
    }
    /*
     * Keep asking until the page answers properly.
     *
     * Their chest appears in the chat bar well before the panel behind it will open, so the first
     * reading of a page that is still building came back with the chest found and nothing in it,
     * and the chest sat in our bar with an empty panel until the three minute timer came round.
     */
    const firstDrops = async (): Promise<void> => {
      for (let i = 0; i < 10 && !stop; i++) {
        if (await readTheDrops()) return
        await new Promise((done) => window.setTimeout(done, 10000))
      }
    }
    void tick()
    window.setTimeout(() => void firstStreak(), 9000)
    window.setTimeout(() => void firstDrops(), 12000)
    /*
     * Deliberately slow.
     *
     * The balance creeps up on its own and a chest waits several minutes to be taken, so eight
     * seconds loses nothing; the streak lives inside a panel that has to be opened in the page to
     * be read, which is real work in their process, and it changes once a stream. Nothing here is
     * a fix for anything, it is simply the least often each one can run and still be right.
     */
    const timer = window.setInterval(() => void tick(), 8000)
    const streakTimer = window.setInterval(() => void readTheStreak(), 300000)
    const dropsTimer = window.setInterval(() => void readTheDrops(), 180000)
    return () => {
      stop = true
      window.clearInterval(timer)
      window.clearInterval(streakTimer)
      window.clearInterval(dropsTimer)
      useUiStore.getState().setPlayerDrops(channel, null)
      useUiStore.getState().setPlayerShare(channel, null)
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
     * opens and the streak and the reward list cannot be read at all. Hidden and
     * pointer-events:none keeps every one of those working while the mouse passes straight through.
     *
     * visibility rather than opacity, because a poll or a prediction is brought BACK from inside
     * this column, and a child cannot out-shine an opacity:0 parent, while visibility:visible on
     * the child does exactly that.
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
        visibility: hidden !important;
        pointer-events: none !important;
      }
      .sticki-surfaced, .sticki-surfaced * {
        visibility: visible !important;
      }
      .sticki-typing, .sticki-typing * {
        visibility: visible !important;
      }
      .sticki-typing {
        opacity: 0 !important;
      }
      .sticki-press, .sticki-press * {
        visibility: visible !important;
        pointer-events: auto !important;
      }
      .sticki-press {
        opacity: 0 !important;
      }
      .sticki-modal, .sticki-modal * {
        visibility: visible !important;
      }
      .sticki-modal {
        pointer-events: auto !important;
        position: fixed !important;
        left: 50% !important;
        top: 50% !important;
        transform: translate(-50%, -50%) !important;
        max-height: 86vh !important;
        overflow: auto !important;
        z-index: 3200 !important;
      }
      .sticki-surfaced {
        pointer-events: auto !important;
        position: fixed !important;
        top: 14px !important;
        right: 14px !important;
        width: 320px !important;
        max-height: 60vh !important;
        overflow: auto !important;
        z-index: 3100 !important;
        border-radius: 8px !important;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55) !important;
      }
      html, body { overflow: hidden !important; }
      *::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
      * { scrollbar-width: none !important; }
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
     * moment the page says it is in theatre mode.
     *
     * Their own class, not the player's height. The height was measured against the frame, and
     * with the top bar and the channel info hidden the player fills the frame WITHOUT theatre mode
     * as well: measured at 466 of 466 on a page that was not in theatre at all. Worse, the answer
     * changed while the frame was being resized, and Twitch fires did-navigate-in-page freely, so
     * opening a split ran this again, read "not filling the height" mid-reflow and pressed alt+T on
     * a page that already had theatre on. A couple of those in a row is how the player ended up
     * with theatre OFF exactly when the split opened. The class says the state outright.
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
            return document.querySelector('.persistent-player--theatre, .right-column--theatre')
              ? 'done'
              : 'go'
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
            /*
             * Readiness is asked for, not waited for, and the asking is cleaned up after.
             *
             * dom-ready says executeJavaScript will not throw, and listening for it worked right
             * up until the listener was attached after it had already fired: a re-render that
             * detaches and re-attaches the element, or a hot reload, and the flag stayed false for
             * good. Asking the view a trivial question until it answers cannot miss its moment.
             *
             * Both the listener and that poll used to be added on every ref call and removed on
             * none, so a session of opening and closing players piled them up on the same element
             * until Electron warned about eleven did-stop-loading listeners on one WebContents.
             */
            wvRef.current = el as never
            wvWatch.current?.()
            wvWatch.current = null
            if (!el) {
              setReady(false)
              return
            }
            const on = (): void => setReady(true)
            const node = el as unknown as {
              addEventListener: (t: string, f: () => void) => void
              removeEventListener?: (t: string, f: () => void) => void
              executeJavaScript?: (c: string) => Promise<unknown>
            }
            node.addEventListener('dom-ready', on)
            let tries = 0
            const probe = window.setInterval(() => {
              if (tries++ > 40) return window.clearInterval(probe)
              try {
                void node.executeJavaScript?.('1')?.then(
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
            wvWatch.current = () => {
              window.clearInterval(probe)
              node.removeEventListener?.('dom-ready', on)
            }
          }}
          src={src}
          className="stream-webview"
          // the guest is its own renderer with its own rules: without this it is throttled the
          // moment the window stops being the one in front, which is when the stream paused
          webpreferences="backgroundThrottling=no"
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
