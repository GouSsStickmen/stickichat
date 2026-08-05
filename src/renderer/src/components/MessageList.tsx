import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { Account, ChatMessage, Pane } from '../types'
import { useChatStore } from '../store/chat'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { useEmotesStore } from '../store/emotes'
import MessageView from './MessageView'
import { ReplyTarget } from './InputBox'
import { useT } from '../i18n'
import { diagWarn } from '../lib/diag'

interface Props {
  pane: Pane
  account: Account | undefined
  channelId: string
  isMod: boolean
  onReply: (target: ReplyTarget) => void
  scrollLocked: boolean
}

export interface JumpEventDetail {
  channel: string
  msgId: string
}

/** split-mode scroll sync: one pane's wheel delta, replayed by its siblings */
export interface SyncScrollDetail {
  fromPaneId: string
  deltaY: number
}

export default function MessageList({
  pane,
  account,
  channelId,
  isMod,
  onReply,
  scrollLocked
}: Props): React.JSX.Element {
  const t = useT()
  const allMessages = useChatStore((s) => s.messages[pane.channel]) ?? []
  const expandedGifts = useUiStore((s) => s.expandedGifts)
  const settings = useSettingsStore((s) => s.settings)
  // sub-gifts of a collapsed mass-gift group stay hidden until the header is clicked;
  // muted-with-'hide' users disappear from the list entirely
  const hiddenLogins = useMemo(
    () => new Set(settings.mutedUsers.filter((u) => u.mode === 'hide').map((u) => u.login)),
    [settings.mutedUsers]
  )
  const messages = useMemo(
    () =>
      allMessages.filter(
        (m) =>
          (!m.groupedUnder || expandedGifts[m.groupedUnder]) &&
          (m.system || !hiddenLogins.has(m.login))
      ),
    [allMessages, expandedGifts, hiddenLogins]
  )
  const emoteVersion = useEmotesStore((s) => s.version)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const smoothScroll = useSettingsStore((s) => s.settings.smoothChatScroll)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  atBottomRef.current = atBottom
  // follow-intent: true while the user WANTS to sit at the bottom. Cleared the moment they
  // wheel UP (before any state lags), restored when they reach the bottom again. All
  // re-pin machinery keys off this — so background windows keep following through preview
  // loads, and a fast upward fling is never yanked back down.
  const followingRef = useRef(true)
  const [following, setFollowing] = useState(true)
  const [flashId, setFlashId] = useState<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // ---- stable virtual indexing (the scroll-duplication fix) ----
  // The ring buffer trims old messages from the HEAD and history prepends to it. Without
  // `firstItemIndex` Virtuoso sees every remaining row move to a new index: its per-index
  // height cache goes stale, everything re-measures and re-anchors — the visible
  // "messages duplicate / jump for a split second" while scrolling. Tracking a monotone
  // virtual index of the first row (via `firstItemIndex`) engages Virtuoso's native
  // shiftWith/unshiftWith handling: indices stay glued to messages, measurements stay
  // valid, and head changes no longer disturb the viewport at all.
  const FIRST_BASE = 1_000_000
  const firstIndexRef = useRef(FIRST_BASE)
  /** when the list went blank (0 rows rendered while the buffer is full), 0 when it is fine */
  const blankRef = useRef(0)
  /** did a frame actually get painted while the list was empty? */
  const blankPaintedRef = useRef(false)
  const blankSeqRef = useRef(0)

  /**
   * The thing the user actually sees.
   *
   * The empty-render events turned out to last 1-6ms and never survive to a paint, so they
   * are not the reported "chat disappears". This is: while the user is pinned to the bottom,
   * the scroller drifting a whole viewport or more away from it — the view jumping off to
   * somewhere in the backlog and coming back. Sampled once a frame, reported only when it
   * lasts long enough to be drawn.
   */
  useEffect(() => {
    let raf = 0
    let driftSince = 0
    let worst = 0
    const sample = (): void => {
      raf = requestAnimationFrame(sample)
      if (!followingRef.current || scrollLocked) {
        driftSince = 0
        return
      }
      const sc = wrapRef.current?.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement | null
      if (!sc || sc.clientHeight === 0) return
      const away = sc.scrollHeight - sc.scrollTop - sc.clientHeight
      if (away > sc.clientHeight) {
        if (!driftSince) {
          driftSince = performance.now()
          worst = away
        } else if (away > worst) worst = away
      } else if (driftSince) {
        const ms = Math.round(performance.now() - driftSince)
        driftSince = 0
        if (ms >= 16) {
          diagWarn(
            'list',
            `${pane.channel}: view drifted ${Math.round(worst)}px off the bottom for ${ms}ms while following`
          )
        }
      }
    }
    raf = requestAnimationFrame(sample)
    return () => cancelAnimationFrame(raf)
  }, [pane.channel, scrollLocked])
  const prevMessagesRef = useRef<ChatMessage[]>([])
  {
    const prev = prevMessagesRef.current
    if (prev !== messages) {
      if (prev.length > 0 && messages.length > 0) {
        const idxInNew = messages.findIndex((m) => m.id === prev[0].id)
        if (idxInNew >= 0) {
          // old head is still present, shifted right by the number of prepended rows
          firstIndexRef.current -= idxInNew
        } else {
          // old head is gone (trimmed) — count how many rows were cut off the front
          const idxInOld = prev.findIndex((m) => m.id === messages[0].id)
          if (idxInOld >= 0) firstIndexRef.current += idxInOld
          else {
            // Neither head lines up (a big flood trim, or a filter change such as expanding a
            // gift group). Re-anchor on ANY row the two lists still share instead of resetting
            // the virtual index space: a hard reset contradicts Virtuoso's shift bookkeeping
            // and blanks the list for a frame — the "chat vanishes for a split second" report.
            const prevPos = new Map(prev.map((m, i) => [m.id, i]))
            let anchored = false
            for (let i = 0; i < messages.length; i++) {
              const was = prevPos.get(messages[i].id)
              if (was !== undefined) {
                firstIndexRef.current += was - i
                anchored = true
                break
              }
            }
            // genuinely disjoint (channel cleared/switched) — only then start the space over
            if (!anchored) firstIndexRef.current = FIRST_BASE
          }
        }
      } else if (prev.length === 0) {
        firstIndexRef.current = FIRST_BASE
      }
      prevMessagesRef.current = messages
    }
  }

  /**
   * Put the scroll back where it belongs the instant the head is cut — before anything is drawn.
   *
   * Measured, with the scroller captured at the exact frame the list rendered zero rows: the
   * position was not past the end, it sat ten to twenty-four THOUSAND pixels above the bottom,
   * in the middle of the content, with nothing rendered there. Roughly the height of the rows
   * that had just been removed, subtracted a second time. Virtuoso's `firstItemIndex` shift is
   * meant to keep the viewport still across a head change and it lands in the wrong place;
   * splitting the trim into its own commit was tried and changed nothing, so the shift itself
   * is what misfires.
   *
   * Rather than fight its internals, correct the result. A layout effect runs after the DOM is
   * updated and BEFORE the browser paints, so re-pinning here means the bad position never
   * reaches the screen — the blank frame stops existing rather than getting shorter.
   *
   * Only when the user is following the bottom, and only for head REMOVAL: a decreasing index
   * is history being prepended, where the whole point is that the view must not move.
   */
  const shiftSeenRef = useRef(firstIndexRef.current)
  useLayoutEffect(() => {
    const now = firstIndexRef.current
    const removed = now > shiftSeenRef.current
    shiftSeenRef.current = now
    if (!removed || !followingRef.current || scrollLocked) return
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' })
  })

  /**
   * Resizing the list (closing the highlights sidebar or a split pane, resizing the window)
   * can make Virtuoso drift to the top — re-pin to the bottom if we were following it.
   *
   * The size comparison is not decoration. A ResizeObserver fires for every one of Virtuoso's
   * own inner relayouts, hundreds a minute during a flood, and the overwhelming majority
   * report the same box we already saw — the wrapper did not move at all. Reacting to those
   * meant re-anchoring the scroll for no reason, and it is what feeds Chromium's
   * "ResizeObserver loop completed with undelivered notifications" (the notice that arrived
   * as 300 identical lines in a user's report). Costs one comparison; skips almost everything.
   *
   * Scrolling stays SYNCHRONOUS here on purpose. Deferring it to the next frame was tried and
   * measured against the blank-frame counter below — no improvement — while the synchronous
   * call is what keeps a resize from showing one mis-positioned frame.
   */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let lastW = el.clientWidth
    let lastH = el.clientHeight
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w === lastW && h === lastH) return
      lastW = w
      lastH = h
      if (!followingRef.current || scrollLocked) return
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollLocked])

  // late content growth (link previews finishing their fetch) + background windows where
  // rAF-driven followOutput gets throttled: an explicit re-pin keeps autoscroll alive
  useEffect(() => {
    const rePin = (): void => {
      if (!followingRef.current || scrollLocked) return
      // act on the REAL scroller distance: at the bottom this is a no-op (the old
      // unconditional jump interrupted smooth glides every 1.5s — visible stutter),
      // and a small distance in smooth mode means a glide is in progress — let it finish
      const sc = wrapRef.current?.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement | null
      if (sc) {
        const dist = sc.scrollHeight - sc.scrollTop - sc.clientHeight
        if (dist <= 4) return
        if (smoothScroll && dist < 400) return
      }
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' })
    }
    window.addEventListener('sticki:grew', rePin)
    const keepalive = window.setInterval(rePin, 1500)
    // scrolling UP breaks the follow immediately (state updates lag behind fast flings)
    const el = wrapRef.current
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) {
        followingRef.current = false
        setFollowing(false)
      }
      // scroll-sync: broadcast the wheel delta so sibling panes move by the SAME amount.
      // Driving it off the wheel (not the scroll event) keeps it user-initiated, so panes
      // can't echo each other into a feedback loop.
      if (useUiStore.getState().scrollSync) {
        window.dispatchEvent(
          new CustomEvent<SyncScrollDetail>('sticki:syncscroll', {
            detail: { fromPaneId: pane.id, deltaY: e.deltaY }
          })
        )
      }
    }
    // ...and follow someone else's wheel when sync is on
    const onSync = (ev: Event): void => {
      const d = (ev as CustomEvent<SyncScrollDetail>).detail
      if (d.fromPaneId === pane.id || !useUiStore.getState().scrollSync) return
      const sc = wrapRef.current?.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement | null
      if (!sc) return
      if (d.deltaY < 0) {
        followingRef.current = false
        setFollowing(false)
      }
      sc.scrollTop += d.deltaY
    }
    el?.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('sticki:syncscroll', onSync)
    return () => {
      window.removeEventListener('sticki:grew', rePin)
      window.clearInterval(keepalive)
      el?.removeEventListener('wheel', onWheel)
      window.removeEventListener('sticki:syncscroll', onSync)
    }
  }, [scrollLocked, pane.id])

  /**
   * Smooth scrolling, driven here instead of by the list — the Chatterino model.
   *
   * What was here before: `followOutput: 'smooth'`, plus a rule that gave up above three
   * messages a second and reverted to instant jumps. That rule IS the "with smooth scrolling
   * on, a busy chat stops scrolling smoothly" report — it was working as designed, and the
   * design was wrong. It existed because each new message started a FRESH browser smooth-scroll
   * to a new target, cancelling the one in flight; at speed that is a stutter, not a glide.
   *
   * A single animation that never restarts has no such limit. Every frame it moves a fraction
   * of whatever distance remains, so a faster chat simply moves it faster and it stays smooth
   * at any rate. The speed floor stops the last pixels from crawling.
   *
   * The snap threshold is the other half of the "chat disappears for a second" bug. Measured:
   * after the ring buffer cuts its head the scroll can land eight thousand pixels adrift, and
   * gliding back over that distance took ~500ms — half a second of showing the wrong part of
   * the backlog, which is exactly what people were describing. More than about a screen and a
   * half is not a glide, it is a correction: go there at once.
   */
  useEffect(() => {
    if (!smoothScroll || scrollLocked) return
    const el = wrapRef.current
    if (!el) return
    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      if (!followingRef.current) return
      const sc = el.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement | null
      if (!sc) return
      // the exact maximum, not an overshoot left to the browser to clamp: while the list is
      // virtualized, a scrollTop past the end can land outside the measured range for a frame
      // and that frame renders nothing
      const bottom = sc.scrollHeight - sc.clientHeight
      const dist = bottom - sc.scrollTop
      if (dist < 0.5) return
      if (dist > sc.clientHeight * 1.5) {
        // a correction, not a glide — and go through the list rather than writing scrollTop
        // by hand: only it knows which rows it has measured, and a raw jump to a position it
        // has not prepared renders an empty frame
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' })
        return
      }
      sc.scrollTop += Math.max(1.5, dist * 0.28)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [smoothScroll, scrollLocked])

  // history often arrives AFTER the empty list mounted — snap to the bottom on first fill,
  // otherwise the view stays parked at the top of the freshly-prepended scrollback
  const hadMessagesRef = useRef(false)
  useEffect(() => {
    if (!hadMessagesRef.current && messages.length > 0) {
      hadMessagesRef.current = true
      virtuosoRef.current?.scrollToIndex({ index: 'LAST' })
    }
  }, [messages.length])

  // jump-to-message requests (clicking a reply reference)
  useEffect(() => {
    const onJump = (e: Event): void => {
      const detail = (e as CustomEvent<JumpEventDetail>).detail
      if (detail.channel !== pane.channel) return
      const idx = messagesRef.current.findIndex((m) => m.id === detail.msgId)
      if (idx < 0) return
      // scrollToIndex uses LOCAL indices (0..length-1) even with firstItemIndex active —
      // the offset variant clamped to the end and the jump appeared to do nothing
      // jumping to an old message PARKS the view — new arrivals must not yank it back down
      followingRef.current = false
      setFollowing(false)
      virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center' })
      setFlashId(detail.msgId)
      window.setTimeout(() => setFlashId(null), 3200)
    }
    window.addEventListener('sticki:jump', onJump)
    return () => window.removeEventListener('sticki:jump', onJump)
  }, [pane.channel])

  // sending a message snaps to the bottom — so a paused/scrolled-up list shows the sent line
  useEffect(() => {
    const onSent = (e: Event): void => {
      const detail = (e as CustomEvent<{ channel: string }>).detail
      if (detail.channel !== pane.channel) return
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' })
    }
    window.addEventListener('sticki:sent', onSent)
    return () => window.removeEventListener('sticki:sent', onSent)
  }, [pane.channel])

  return (
    <div className="msg-list-wrap" ref={wrapRef}>
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        // Scrolling up into UNMEASURED rows is where the down-then-up flick comes from:
        // Virtuoso places them at the estimated height, measures the real one, then corrects
        // the scroll position. A large TOP overscan makes rows render & measure ~a screen
        // BEFORE they become visible, so the correction lands while they're still off-screen
        // — invisible. (Safe now: with stable firstItemIndex the measurement cache survives
        // buffer trims, which is what used to make a big overscan thrash.)
        increaseViewportBy={{ top: 800, bottom: 320 }}
        // in smooth mode the animation above owns the scroller — letting Virtuoso pin it too
        // means two things driving the same scrollTop, and they fight
        followOutput={(isAtBottom) =>
          scrollLocked || smoothScroll ? false : isAtBottom ? 'auto' : false
        }
        atBottomStateChange={(b) => {
          setAtBottom(b)
          if (b) {
            followingRef.current = true
            setFollowing(true)
          }
        }}
        atBottomThreshold={40}
        /**
         * "The chat blinks out for a second, and the more messages the more often" — this is
         * that moment, caught rather than guessed at. Rendering zero rows while the buffer
         * holds hundreds is the blank frame itself; nothing else in the app can observe it.
         * Cheap (one comparison per render pass) and it stays: if a user reports it again,
         * their log will say whether it actually happened.
         */
        itemsRendered={(items) => {
          const blank = messages.length > 0 && items.length === 0
          if (blank && !blankRef.current) {
            blankRef.current = Date.now()
            blankPaintedRef.current = false
            // A blank that is repaired inside the same frame is never drawn — the browser
            // paints once per frame, not once per render. So ask the browser: this callback
            // runs just before the next paint, and if the list is STILL empty then, the user
            // is about to actually see an empty chat. That is the number that matters; the
            // rest is internal churn.
            const seq = ++blankSeqRef.current
            requestAnimationFrame(() => {
              if (blankRef.current && blankSeqRef.current === seq) blankPaintedRef.current = true
            })
          } else if (!blank && blankRef.current) {
            const painted = blankPaintedRef.current
            diagWarn(
              'list',
              `${pane.channel}: rendered 0 of ${messages.length} rows for ${Date.now() - blankRef.current}ms — ${painted ? 'PAINTED' : 'not painted'}`
            )
            blankRef.current = 0
          }
        }}
        // apply resize corrections synchronously instead of on the next animation frame —
        // removes the one mis-positioned frame that reads as a micro-jump while scrolling up
        skipAnimationFrameInResizeObserver
        // a closer height estimate before measurement means less scroll re-anchoring
        defaultItemHeight={34}
        firstItemIndex={firstIndexRef.current}
        initialTopMostItemIndex={Math.max(messages.length - 1, 0)}
        computeItemKey={(_i, m) => m.id}
        itemContent={(index, msg) => (
          <MessageView
            msg={msg}
            index={index}
            paneId={pane.id}
            account={account}
            channelId={channelId}
            isMod={isMod}
            paneAccountId={pane.accountId}
            settings={settings}
            emoteVersion={emoteVersion}
            onReply={onReply}
            flash={flashId === msg.id}
          />
        )}
      />
      {!atBottom && !following && (
        <div
          className="new-msgs-chip"
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' })
          }
        >
          ↓ {t('misc.newMessages')}
        </div>
      )}
    </div>
  )
}
