import { useEffect, useMemo, useRef, useState } from 'react'
import { Account, ChatMessage, Pane } from '../types'
import { useChatStore } from '../store/chat'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { useEmotesStore } from '../store/emotes'
import ChatList, { ChatListHandle } from './ChatList'
import MessageView from './MessageView'
import { ReplyTarget } from './InputBox'
import { useT } from '../i18n'
import { diagWarn } from '../lib/diag'
import { isMobile } from '../lib/platform'

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
  const messages = useMemo(() => {
    const kept = allMessages.filter(
      (m) =>
        (!m.groupedUnder || expandedGifts[m.groupedUnder]) &&
        (m.system || !hiddenLogins.has(m.login))
    )
    /**
     * An unfolded gift group belongs UNDER ITS HEADER, not wherever the clock left it.
     *
     * The gifts are separate usernotices and the chat keeps arriving while they land, so
     * chronological order scatters them: "показати всі" was opening a list that started three
     * or four unrelated messages further down, with other people's chat threaded through it.
     * The grouping already says which header each gift belongs to; using it for placement as
     * well as for folding is what makes the list read as one block.
     */
    if (!kept.some((m) => m.groupedUnder)) return kept
    const under = new Map<string, ChatMessage[]>()
    for (const m of kept) {
      if (!m.groupedUnder) continue
      const at = under.get(m.groupedUnder)
      if (at) at.push(m)
      else under.set(m.groupedUnder, [m])
    }
    const present = new Set(kept.map((m) => m.id))
    const out: ChatMessage[] = []
    for (const m of kept) {
      // a gift whose header is still in the buffer is emitted with the header, not here; one
      // whose header has been trimmed away keeps its own place rather than disappearing
      if (m.groupedUnder && present.has(m.groupedUnder)) continue
      out.push(m)
      const group = under.get(m.id)
      if (group) out.push(...group)
    }
    return out
  }, [allMessages, expandedGifts, hiddenLogins])
  const emoteVersion = useEmotesStore((s) => s.version)
  const listRef = useRef<ChatListHandle>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const smoothScroll = useSettingsStore((s) => s.settings.smoothChatScroll)
  const [atBottom, setAtBottom] = useState(true)
  // follow-intent: true while the user WANTS to sit at the bottom. Cleared the moment they
  // scroll UP by their own hand, restored when they reach the bottom again.
  const followingRef = useRef(true)
  const [following, setFollowing] = useState(true)
  const [flashId, setFlashId] = useState<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  /**
   * Everything that changes how tall a row draws. When any of it moves, the list stops trusting
   * its cached heights and measures again as rows come back on screen — which is why these
   * settings can be changed freely without the layout going wrong.
   *
   * The counter is the part that makes this safe rather than merely mostly right. The list now
   * skips re-reading a row whose height it already knows, so a setting missing from this list
   * is no longer self-healing the way it was when every row was measured every frame: separator
   * lines, the message layout mode, the preview scale all change heights and none of them were
   * named here. Rather than keep guessing at the list, count the times the settings object was
   * replaced at all. Settings change by hand, a few times a session; measuring again costs one
   * pass over what is on screen.
   */
  const settingsGen = useRef(0)
  const lastSettings = useRef(settings)
  if (lastSettings.current !== settings) {
    lastSettings.current = settings
    settingsGen.current++
  }
  const layoutKey = `${settingsGen.current}|${emoteVersion}`

  const stopFollowing = (): void => {
    followingRef.current = false
    setFollowing(false)
  }

  /**
   * What the reader actually sees going wrong, watched once a frame.
   *
   * Two things are worth a line in the log: the view sitting a whole screen or more away from
   * the bottom while it is supposed to be pinned there, and the list holding hundreds of
   * messages while showing almost none of them. Both are cheap to check from the scroller and
   * neither can be inferred from anything else the app records.
   */
  useEffect(() => {
    let raf = 0
    let driftSince = 0
    let worst = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const sc = listRef.current?.scroller()
      if (!sc || sc.clientHeight === 0) return
      const view = sc.clientHeight
      const away = sc.scrollHeight - sc.scrollTop - view
      if (!followingRef.current || scrollLocked) {
        driftSince = 0
        return
      }
      const shown = sc.firstElementChild?.childElementCount ?? 0
      if (messagesRef.current.length > 40 && shown < 4) {
        diagWarn('list', `${pane.channel}: showing ${shown} of ${messagesRef.current.length} rows`)
      }
      if (away > view) {
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
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pane.channel, scrollLocked])

  // late content growth (link previews finishing) and background windows where rAF is
  // throttled: an explicit nudge keeps autoscroll alive
  useEffect(() => {
    const rePin = (): void => {
      if (!followingRef.current || scrollLocked) return
      const dist = listRef.current?.distanceFromBottom() ?? 0
      if (dist <= 4) return
      if (smoothScroll && dist < 400) return
      listRef.current?.toBottom()
    }
    window.addEventListener('sticki:grew', rePin)
    const keepalive = window.setInterval(rePin, 1500)

    /**
     * The input of THIS pane just changed height — correct the scroll in the same frame.
     *
     * The list watches its own size too, but a ResizeObserver whose target changed during the
     * layout-effect phase can be delivered a frame late, and that frame is painted with the
     * shorter viewport and the old scroll position: the chat visibly drops behind the input on
     * every line it gains. The input dispatches this synchronously, before paint.
     *
     * Unconditionally to the end, and NOT via rePin: rePin declines small distances while smooth
     * scroll is on, which is right for arriving messages (that gap is what the glide animates)
     * and wrong here — the viewport moved under the reader and there is nothing to animate.
     */
    const onInputGrew = (e: Event): void => {
      const detail = (e as CustomEvent<{ paneId: string }>).detail
      if (detail?.paneId !== pane.id) return
      if (!followingRef.current || scrollLocked) return
      listRef.current?.toBottom()
    }
    window.addEventListener('sticki:inputgrew', onInputGrew)

    const el = wrapRef.current
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) stopFollowing()
      // scroll-sync: broadcast the wheel delta so sibling panes move by the SAME amount.
      // Driving it off the wheel (not the scroll event) keeps it user-initiated, so panes
      // can't echo each other into a feedback loop.
      // only panes that opted in lead, and only they follow — see Pane.syncScroll
      if (pane.syncScroll) {
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
      if (d.fromPaneId === pane.id || !pane.syncScroll) return
      const sc = listRef.current?.scroller()
      if (!sc) return
      if (d.deltaY < 0) stopFollowing()
      sc.scrollTop += d.deltaY
    }
    /*
     * A touch drag is the same intent as a wheel-up and produces no wheel event at all, so without
     * this the list never stops following on a phone: the drag moves the scroller, the follow glide
     * pins it back inside the same frame, and the chat simply refuses to scroll.
     *
     * The threshold is what separates a drag from a tap — a finger never lands perfectly still, and
     * treating every touch as a scroll would unstick the list whenever a message is tapped.
     */
    let touchY = 0
    let touchDragged = false

    /*
     * Long press stands in for hover.
     *
     * The per-message actions — reply, and every configured mod button — are revealed by `:hover` on
     * the desktop, and a phone has no hover at all. Rather than build a second set of buttons with a
     * second set of handlers, the press marks the row and the stylesheet shows the ones already
     * rendered there. One class, no duplicated behaviour, and a new mod button appears here the day
     * it appears on the desktop.
     */
    let pressTimer = 0
    const clearHeld = (): void => {
      el?.querySelectorAll('.msg-row.touch-held').forEach((r) => r.classList.remove('touch-held'))
      if (useUiStore.getState().heldMsgId) useUiStore.getState().setHeldMsgId(null)
    }
    const cancelPress = (): void => {
      if (pressTimer) window.clearTimeout(pressTimer)
      pressTimer = 0
    }

    const onTouchStart = (e: TouchEvent): void => {
      touchY = e.touches[0]?.clientY ?? 0
      touchDragged = false

      const row = (e.target as HTMLElement | null)?.closest?.('.msg-row') as HTMLElement | null
      /*
       * Three things claim a long press and only one of them can have it. An emote press is that
       * emote's own gesture — hold to insert it, hold longer for its page. A press on the sheet
       * belongs to the sheet. And a press on the grip is the start of a swipe: the sheet used to open
       * mid-drag and cover the very row being dragged. Everything else is the message.
       */
      const claimed = (e.target as HTMLElement | null)?.closest?.(
        '.msg-sheet, .emote-wrap, .swipe-grip'
      )
      if (claimed) return
      clearHeld()
      cancelPress()
      if (!row) return
      pressTimer = window.setTimeout(() => {
        pressTimer = 0
        row.classList.add('touch-held')
        /*
         * The row draws its own sheet from this — reply, copy and its mod buttons in one list.
         * `data-mid` is on the positioned wrapper the virtualiser renders around each row, not on
         * `.msg-row` itself, so it is looked up from the target rather than from the row.
         */
        const mid = (e.target as HTMLElement | null)?.closest?.('[data-mid]')?.getAttribute('data-mid')
        if (mid) useUiStore.getState().setHeldMsgId(mid)
        // Android starts selecting words at about this point; the press means the sheet now
        document.getSelection()?.removeAllRanges()
        // the same short buzz Android uses for its own long presses, where the device allows it
        navigator.vibrate?.(12)
      }, 450)
    }
    const onTouchEnd = (): void => cancelPress()

    /*
     * Android fires `contextmenu` at the end of its own long-press timer, so the OS text-selection
     * menu came up on top of the buttons the press had just revealed — two menus for one gesture.
     *
     * Touch only, and that matters: the desktop's right-click handlers live on this same event —
     * right button inserts the nick — so swallowing it everywhere would take that away.
     */
    const onContextMenu = (e: Event): void => {
      if (isMobile()) e.preventDefault()
    }

    /*
     * The buttons let go on their own.
     *
     * A tap on one runs its action and leaves the row exactly as it was — still held, still covering
     * the message under it — and a tap anywhere else did nothing at all. Both are the same fix: the
     * next touch that is not on the buttons clears them, and using one on purpose clears them too.
     */
    const onDocTouch = (e: Event): void => {
      const t = e.target as HTMLElement | null
      // a touch inside the sheet is a touch on the sheet, wherever it happens to be drawn
      if (t?.closest?.('.msg-sheet')) return
      clearHeld()
    }
    /*
     * Deferred, and that is the whole point.
     *
     * This is a native listener inside the tree, so it runs before React's delegated handler at the
     * root. Clearing straight away unmounted the sheet while the click was still on its way to the
     * button's own onClick — the sheet closed and the action never ran. A task boundary lets React
     * deliver the click first.
     */
    const onActionUsed = (e: Event): void => {
      if ((e.target as HTMLElement | null)?.closest?.('.msg-sheet')) window.setTimeout(clearHeld, 0)
    }
    const onScrollAway = (): void => clearHeld()
    const onTouchMove = (e: TouchEvent): void => {
      const y = e.touches[0]?.clientY ?? 0
      // finger down the screen = content moves down = scrollTop decreases = wheel-up
      if (Math.abs(y - touchY) > 4) cancelPress()
      if (!touchDragged && y - touchY > 6) {
        touchDragged = true
        stopFollowing()
      }
      // keep the split panes in step the same way the wheel does, from the same user gesture
      if (pane.syncScroll) {
        const dy = touchY - y
        if (dy) {
          window.dispatchEvent(
            new CustomEvent<SyncScrollDetail>('sticki:syncscroll', {
              detail: { fromPaneId: pane.id, deltaY: dy }
            })
          )
        }
      }
      touchY = y
    }

    el?.addEventListener('wheel', onWheel, { passive: true })
    el?.addEventListener('touchstart', onTouchStart, { passive: true })
    el?.addEventListener('touchmove', onTouchMove, { passive: true })
    el?.addEventListener('touchend', onTouchEnd, { passive: true })
    el?.addEventListener('touchcancel', onTouchEnd, { passive: true })
    el?.addEventListener('contextmenu', onContextMenu)
    el?.addEventListener('click', onActionUsed)
    el?.addEventListener('scroll', onScrollAway, { capture: true, passive: true })
    document.addEventListener('touchstart', onDocTouch, { passive: true })
    window.addEventListener('sticki:syncscroll', onSync)
    return () => {
      window.removeEventListener('sticki:grew', rePin)
      window.removeEventListener('sticki:inputgrew', onInputGrew)
      window.clearInterval(keepalive)
      el?.removeEventListener('wheel', onWheel)
      el?.removeEventListener('touchstart', onTouchStart)
      el?.removeEventListener('touchmove', onTouchMove)
      el?.removeEventListener('touchend', onTouchEnd)
      el?.removeEventListener('touchcancel', onTouchEnd)
      el?.removeEventListener('contextmenu', onContextMenu)
      el?.removeEventListener('click', onActionUsed)
      el?.removeEventListener('scroll', onScrollAway, { capture: true })
      document.removeEventListener('touchstart', onDocTouch)
      cancelPress()
      window.removeEventListener('sticki:syncscroll', onSync)
    }
  }, [scrollLocked, pane.id, pane.syncScroll, smoothScroll])

  // jump-to-message requests (clicking a reply reference)
  useEffect(() => {
    const onJump = (e: Event): void => {
      const detail = (e as CustomEvent<JumpEventDetail>).detail
      if (detail.channel !== pane.channel) return
      const idx = messagesRef.current.findIndex((m) => m.id === detail.msgId)
      if (idx < 0) return
      // jumping to an old message PARKS the view — new arrivals must not yank it back down
      stopFollowing()
      listRef.current?.toIndex(idx)
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
      followingRef.current = true
      setFollowing(true)
      listRef.current?.toBottom()
    }
    window.addEventListener('sticki:sent', onSent)
    return () => window.removeEventListener('sticki:sent', onSent)
  }, [pane.channel])

  return (
    <div className="msg-list-wrap" ref={wrapRef}>
      <ChatList
        ref={listRef}
        messages={messages}
        layoutKey={layoutKey}
        following={followingRef}
        smooth={smoothScroll}
        locked={scrollLocked}
        onUserScrolledUp={stopFollowing}
        onAtBottomChange={(b) => {
          setAtBottom(b)
          if (b) {
            followingRef.current = true
            setFollowing(true)
          }
        }}
        renderRow={(msg, index) => (
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
        <div className="new-msgs-chip" onClick={() => listRef.current?.toBottom()}>
          ↓ {t('misc.newMessages')}
        </div>
      )}
    </div>
  )
}
