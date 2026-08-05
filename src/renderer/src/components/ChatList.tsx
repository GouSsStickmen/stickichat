import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { ChatMessage } from '../types'

/**
 * The chat list, done the way Chatterino does it rather than the way a DOM virtualizer does.
 *
 * The difference that matters is not speed, it is WHO KNOWS THE HEIGHTS. A generic virtualizer
 * renders a row, measures it, and caches that measurement AGAINST ITS INDEX. Our indices move
 * every time the ring buffer cuts its head, so every trim asks the library to re-map its whole
 * size cache onto new indices — and that re-map is where the chat went blank for up to a fifth
 * of a second, where the scroll landed twenty thousand pixels from where it belonged, and where
 * most of a week of bug reports came from.
 *
 * Here the cache is keyed BY MESSAGE ID. Trimming the head cannot invalidate anything, because
 * nothing about the surviving messages changed. Their heights are still known, their order is
 * still the same, and the only thing that moves is the sum of what was in front of them — which
 * is a number we can compute exactly and subtract from scrollTop in the same frame. Nothing is
 * estimated after the fact, so nothing has to be corrected after the fact.
 *
 * Everything else follows from that:
 *  - total content height is a real sum, not a projection, so "pin to the bottom" is one exact
 *    assignment and can never drift;
 *  - a row that grows later (a link preview finishing) shifts the rows below it, and if it sits
 *    above the viewport we move the scroll by the same amount, so the reader sees nothing;
 *  - only the rows on screen exist in the DOM, plus a screenful either side.
 */

/** rows above/below the viewport that are rendered anyway, so scrolling never shows a gap */
const OVERSCAN = 700
/** what an unmeasured row is assumed to be until it has been on screen once */
const FALLBACK_HEIGHT = 34

export interface ChatListHandle {
  /** jump to the newest message */
  toBottom: () => void
  /** put message `index` in the middle of the view */
  toIndex: (index: number) => void
  /** the scrolling element, for the few things that need it directly */
  scroller: () => HTMLElement | null
  /** distance from the bottom, in px */
  distanceFromBottom: () => number
}

interface Props {
  messages: ChatMessage[]
  renderRow: (msg: ChatMessage, index: number) => React.ReactNode
  /**
   * Anything that changes how tall a row is: font size, spacing, zoom, emote size. Changing it
   * throws the height cache away and every row is measured again. Deliberately a coarse signal
   * — these are settings people change occasionally, not per message.
   */
  layoutKey: string
  /** true while the view should stay glued to the newest message */
  following: React.MutableRefObject<boolean>
  /** glide to the bottom instead of jumping */
  smooth: boolean
  /** chat is paused — do not move the scroll at all */
  locked: boolean
  onAtBottomChange?: (atBottom: boolean) => void
  /** the user scrolled up by their own hand (wheel, scrollbar, keyboard) */
  onUserScrolledUp?: () => void
}

const ChatList = forwardRef<ChatListHandle, Props>(function ChatList(
  { messages, renderRow, layoutKey, following, smooth, locked, onAtBottomChange, onUserScrolledUp },
  ref
) {
  const scRef = useRef<HTMLDivElement | null>(null)
  const heights = useRef(new Map<string, number>())
  const [, bump] = useState(0)
  const rerender = useCallback(() => bump((n) => n + 1), [])

  const scrollTopRef = useRef(0)
  const viewRef = useRef(0)
  /**
   * The message the view is holding on to, and how far above the viewport's top edge it sits.
   *
   * This is the whole scroll-stability mechanism when the reader is not at the bottom: whatever
   * happens to the array — the head cut, a row growing, the browser clamping scrollTop after a
   * shrink — this one message goes back to the same place on screen afterwards.
   */
  const anchor = useRef<{ id: string; gap: number } | null>(null)
  /** the head changed in this update — set during render, consumed by the layout effect */
  const headMoved = useRef(false)
  const prevRef = useRef<ChatMessage[]>([])
  /**
   * The index the FIRST message in the array carries.
   *
   * A message must keep the same number for as long as it is on screen, because the row
   * striping is `index % 2`. Array position is not that number: trimming the head shifts every
   * position by a couple of hundred, so the parity of every single message flips at once and
   * the light and dark rows swap places — reported exactly that way. Counting the head changes
   * keeps the numbering attached to the messages instead of to their slots.
   */
  const baseIndex = useRef(0)
  const atBottomRef = useRef(true)
  /** the last scrollTop WE wrote, so a scroll event can tell our move from the user's */
  const ourScrollTop = useRef(-1)

  /**
   * Rows that finish growing AFTER they were measured — an emote or a link preview arriving.
   *
   * Rows are positioned absolutely from their cached height, so a row that grows in the DOM
   * without the cache noticing overlaps the one below it until something else forces a render.
   * That is the "messages jump very fast and come back" report: the gap between the row
   * getting taller and us finding out. Only the rows currently on screen are watched — a few
   * dozen — and the observer is disconnected wholesale each pass rather than tracked per row.
   */
  const rerenderRef = useRef<() => void>(() => {})
  rerenderRef.current = rerender
  const sizeWatch = useRef<ResizeObserver | null>(null)
  if (!sizeWatch.current && typeof ResizeObserver !== 'undefined') {
    sizeWatch.current = new ResizeObserver((entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement
        const id = el.dataset.mid
        if (!id) continue
        const h = el.offsetHeight
        if (h === 0 || heights.current.get(id) === h) continue
        // one render is enough: the measure pass reads every row and fixes them all at once
        rerenderRef.current()
        return
      }
    })
  }
  useEffect(() => () => sizeWatch.current?.disconnect(), [])

  /**
   * A font or spacing change makes every cached height wrong — but do NOT throw them away.
   *
   * Clearing meant every row instantly became the 34px fallback, the total collapsed, and for
   * one frame the visible range covered almost nothing: caught in the log as "showing 1 of 799
   * rows". A stale height is a far better estimate than a constant, and it is only ever an
   * estimate for a moment: the measure pass below overwrites any row whose real height differs
   * the frame it appears, and rows off screen get corrected as they scroll in. So the layout
   * key only needs to force one re-render; the numbers repair themselves.
   */
  const layoutRef = useRef(layoutKey)
  if (layoutRef.current !== layoutKey) layoutRef.current = layoutKey

  // ---- offsets: a prefix sum over the CURRENT array, recomputed per render ----
  // Eight hundred to three thousand map lookups is tens of microseconds and it is the reason
  // there is no incremental-update bookkeeping anywhere in here to get subtly wrong.
  const offsets: number[] = new Array(messages.length)
  let total = 0
  for (let i = 0; i < messages.length; i++) {
    offsets[i] = total
    total += heights.current.get(messages[i].id) ?? FALLBACK_HEIGHT
  }

  // ---- how far the NUMBERING moved, so a message keeps its index for its whole life ----
  // (the scroll itself is handled by the anchor, which needs none of this)
  {
    const prev = prevRef.current
    if (prev !== messages && prev.length && messages.length) {
      const firstId = messages[0].id
      if (prev[0].id !== firstId) {
        // the front moved: everything below it slid, so the view has to be put back
        headMoved.current = true
        const prepended = messages.findIndex((m) => m.id === prev[0].id)
        if (prepended > 0) {
          // history arrived in front of everything we had
          baseIndex.current -= prepended
        } else {
          let removed = 0
          while (removed < prev.length && prev[removed].id !== firstId) removed++
          // the new head really is further along the old list; otherwise the two are unrelated
          // (channel cleared) and the numbering starts over
          baseIndex.current = removed < prev.length ? baseIndex.current + removed : 0
        }
      }
    }
    prevRef.current = messages
  }

  // ---- which rows to actually render ----
  //
  // When the head has just been cut, `scrollTopRef` still holds the position from BEFORE the
  // cut, and every offset below has moved up by the height of what went. Slicing with the old
  // number picks rows for a place in the document that no longer exists — one frame drawn from
  // the wrong part of the list, which is the micro-blink that shows up as soon as the buffer
  // is small enough to be trimmed often. The layout effect repairs the scroll a moment later,
  // but by then the frame has been painted.
  //
  // So slice from where the scroll is ABOUT to be, which is known: the bottom if we are
  // following it, or the anchor's new position if we are not.
  const view = viewRef.current || 1
  if (headMoved.current) {
    // the same rule the layout effect uses, so the slice and the scroll agree
    const glued = following.current && !locked && !smooth
    if (glued) {
      scrollTopRef.current = Math.max(0, total - view)
    } else if (anchor.current) {
      const a = anchor.current
      const i = messages.findIndex((m) => m.id === a.id)
      if (i >= 0) scrollTopRef.current = Math.max(0, offsets[i] - a.gap)
    }
  }
  const from = lowerBound(offsets, scrollTopRef.current - OVERSCAN)
  const to = upperBound(offsets, scrollTopRef.current + view + OVERSCAN)

  // the current layout, readable from callbacks that must not be rebuilt on every message
  const offsetsRef = useRef<number[]>([])
  const msgsRef = useRef<ChatMessage[]>([])
  offsetsRef.current = offsets
  msgsRef.current = messages

  /** remember the topmost message on screen and how far above the edge it starts */
  const grabAnchor = useCallback((top: number): void => {
    const off = offsetsRef.current
    const msgs = msgsRef.current
    if (msgs.length === 0) {
      anchor.current = null
      return
    }
    const at = Math.min(lowerBound(off, top), msgs.length - 1)
    anchor.current = { id: msgs[at].id, gap: off[at] - top }
  }, [])

  /** pin to the newest message — exact, because `total` is a real sum and not a guess */
  const pin = useCallback((el: HTMLElement, height: number) => {
    const target = Math.max(0, height - el.clientHeight)
    el.scrollTop = target
    ourScrollTop.current = target
    scrollTopRef.current = target
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      toBottom: () => {
        const el = scRef.current
        if (el) pin(el, el.scrollHeight)
      },
      toIndex: (index: number) => {
        const el = scRef.current
        if (!el || index < 0 || index >= offsets.length) return
        const h = heights.current.get(messages[index].id) ?? FALLBACK_HEIGHT
        const target = Math.max(0, offsets[index] - (el.clientHeight - h) / 2)
        el.scrollTop = target
        ourScrollTop.current = target
        scrollTopRef.current = target
      },
      scroller: () => scRef.current,
      distanceFromBottom: () => {
        const el = scRef.current
        return el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0
      }
    }),
    [messages, offsets, pin]
  )

  /**
   * After the DOM exists and before it is painted: measure what is on screen, compensate for
   * anything that changed height ABOVE the viewport, apply the head-trim shift, and re-pin.
   *
   * The order matters. Trim compensation and above-viewport growth both move content under the
   * reader; doing them here means the reader never sees an intermediate position.
   */
  useLayoutEffect(() => {
    const el = scRef.current
    if (!el) return
    viewRef.current = el.clientHeight

    // 1. measure. Re-arm the growth watcher on exactly the rows that exist now, so rows that
    //    scrolled away stop being watched and the observer never accumulates.
    let changed = false
    sizeWatch.current?.disconnect()
    for (const row of Array.from(el.querySelectorAll<HTMLElement>('[data-mid]'))) {
      const id = row.dataset.mid
      if (!id) continue
      sizeWatch.current?.observe(row)
      const h = row.offsetHeight
      if (h === 0) continue
      if (heights.current.get(id) === h) continue
      heights.current.set(id, h)
      changed = true
    }

    // 2. put the view back where it was — by ANCHOR, and ONLY when something moved it.
    //
    //    Holding a specific message still is immune to everything: it does not care who
    //    touched scrollTop or why, nor whether rows above changed height. Subtracting the
    //    removed height instead was wrong in a way the log stated outright — "trim 1456px:
    //    scrollTop was 7440 before the commit, 6057 after" — the browser had already moved
    //    1383 of those pixels by clamping a shrunken document, so subtracting double-counted.
    //
    //    THE GATE IS THE OTHER HALF, and leaving it out broke scrolling outright. This effect
    //    runs after EVERY render, including the one the scroll handler itself causes, so an
    //    ungated restore put the scroll straight back where it came from: the wheel did
    //    nothing, and at the bottom every arriving message yanked the view. Restore only when
    //    the content actually moved under the reader — the head was cut, or a row changed
    //    height. A plain scroll changes neither and must be left completely alone.
    const moved = headMoved.current || changed
    headMoved.current = false

    // Instant mode pins to the newest message and that is the whole behaviour.
    //
    // Smooth mode goes through the anchor even while following, and that is what makes it
    // smooth at all. Once the buffer is full, an arriving message does not make the document
    // taller — thirty pixels appear at the bottom and thirty vanish off the top, so the view
    // is still exactly at the end and a distance-based glide has nothing to travel. Holding
    // the anchor instead leaves the same text on screen, which CREATES that thirty pixels of
    // distance, and the animation below then eats it. That is the difference between a chat
    // that crawls and one that steps a line at a time.
    if (following.current && !locked && !smooth) {
      pin(el, el.scrollHeight)
    } else if (moved) {
      const a = anchor.current
      if (a) {
        const i = messages.findIndex((m) => m.id === a.id)
        if (i >= 0) {
          const next = Math.max(0, offsets[i] - a.gap)
          if (Math.abs(next - el.scrollTop) > 0.5) {
            el.scrollTop = next
            ourScrollTop.current = next
            scrollTopRef.current = next
          }
        }
      }
    }

    // 3. remember what to hold on to next time, from wherever the scroll ended up
    grabAnchor(el.scrollTop)

    if (changed) rerender()
  })

  /** the glide: one animation that never restarts, so a faster chat just moves it faster */
  useEffect(() => {
    if (!smooth || locked) return
    let raf = 0
    const step = (): void => {
      raf = requestAnimationFrame(step)
      const el = scRef.current
      if (!el || !following.current) return
      const away = el.scrollHeight - el.scrollTop - el.clientHeight
      if (away < 0.5) return
      // beyond a screen and a half this is a correction, not an animation — gliding across it
      // would be half a second of showing the wrong part of the conversation
      const next =
        away > el.clientHeight * 1.5
          ? el.scrollHeight - el.clientHeight
          : el.scrollTop + Math.max(1.5, away * 0.28)
      el.scrollTop = next
      ourScrollTop.current = next
      scrollTopRef.current = next
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [smooth, locked, following])

  // a width change rewraps every message, so every height is now an estimate rather than a
  // fact — same as a settings change, and handled the same way: re-render and let the measure
  // pass correct what is on screen. Nothing is discarded (see the layout-key note above).
  useEffect(() => {
    const el = scRef.current
    if (!el) return
    let lastW = el.clientWidth
    let lastH = el.clientHeight
    const ro = new ResizeObserver(() => {
      viewRef.current = el.clientHeight
      /**
       * The viewport changed height — the input grew a line, a banner appeared.
       *
       * scrollTop is measured from the TOP, so it survives the resize untouched and the BOTTOM
       * edge does all the moving: whatever the reader was looking at slides under the input,
       * deeper with every line it gains. The bottom is what has to stay still.
       *
       * Glued to the end: pin to the exact end. Reading history: shift by the delta, which
       * leaves the same line sitting on the input's top edge. Both mean "the chat rises with
       * the input"; the first is simply exact. (atBottom as well as following, because with
       * smooth scroll the glide can be a few pixels short when the resize lands.)
       */
      if (el.clientHeight !== lastH) {
        const delta = el.clientHeight - lastH
        lastH = el.clientHeight
        if (!locked) {
          const wanted =
            following.current || atBottomRef.current
              ? el.scrollHeight - el.clientHeight
              : el.scrollTop - delta
          const target = Math.max(0, Math.min(wanted, el.scrollHeight - el.clientHeight))
          if (Math.abs(el.scrollTop - target) > 0.5) {
            el.scrollTop = target
            scrollTopRef.current = target
            ourScrollTop.current = target
          }
        }
        // Re-anchor NOW, at whatever position the resize left us on.
        //
        // The anchor holds "message X, this far below the top" and the layout effect restores
        // it whenever content moves. It was captured before the resize, so any render that
        // followed dragged the view straight back to the old scroll position and undid the
        // re-pin — the chat ended up parked exactly one input-line short of the bottom and
        // stayed there. The scroll event that would have refreshed it arrives too late: it is
        // dispatched asynchronously, and the restoring render can happen first.
        grabAnchor(el.scrollTop)
      }
      if (el.clientWidth === lastW) return
      lastW = el.clientWidth
      rerender()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [rerender, following, locked, grabAnchor])

  const onScroll = useCallback((): void => {
    const el = scRef.current
    if (!el) return
    scrollTopRef.current = el.scrollTop
    ourScrollTop.current = el.scrollTop
    // The anchor has to follow the reader, not lag a frame behind them. It is what the layout
    // effect restores to, so an anchor left over from before this scroll would drag the view
    // back the moment anything else changed — which, while scrolling into unmeasured rows, is
    // every single frame.
    grabAnchor(el.scrollTop)
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 40
    if (bottom !== atBottomRef.current) {
      atBottomRef.current = bottom
      onAtBottomChange?.(bottom)
    }
    rerender()
  }, [onAtBottomChange, rerender])

  /**
   * Dragging the SCROLLBAR is a scroll, and it fires no wheel event.
   *
   * The previous attempt at this inferred intent from the direction of the scroll — "it went
   * up and we did not move it, so the user did" — and that is wrong in the one case that
   * matters: shrinking the content makes the browser clamp scrollTop downward by itself, which
   * happens on every head trim. So the chat let go of the bottom for no reason, at random.
   * A pointerdown past the content width is in the scrollbar gutter and nowhere else, which
   * settles it with no inference at all.
   */
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const el = scRef.current
      if (!el || e.target !== el) return
      if (e.nativeEvent.offsetX < el.clientWidth) return
      onUserScrolledUp?.()
    },
    [onUserScrolledUp]
  )

  // first fill: start at the newest message rather than at the top of the scrollback
  const seededRef = useRef(false)
  useLayoutEffect(() => {
    if (seededRef.current || messages.length === 0) return
    seededRef.current = true
    const el = scRef.current
    if (el) pin(el, el.scrollHeight)
  }, [messages.length, pin])

  const rows: React.ReactNode[] = []
  for (let i = from; i < to && i < messages.length; i++) {
    const m = messages[i]
    rows.push(
      <div
        key={m.id}
        data-mid={m.id}
        // flow-root so a message's own vertical margins are INSIDE the box we measure —
        // otherwise they escape the wrapper and every row is reported shorter than it draws
        style={{ position: 'absolute', top: offsets[i], left: 0, right: 0, display: 'flow-root' }}
      >
        {renderRow(m, baseIndex.current + i)}
      </div>
    )
  }

  return (
    <div
      ref={scRef}
      className="chat-scroller"
      data-chat-scroller="true"
      onScroll={onScroll}
      onPointerDown={onPointerDown}
    >
      <div style={{ height: total, position: 'relative' }}>{rows}</div>
    </div>
  )
})

/** first index whose row still ends after `y` */
function lowerBound(offsets: number[], y: number): number {
  let lo = 0
  let hi = offsets.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] < y) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, lo - 1)
}

/** one past the last index that starts before `y` */
function upperBound(offsets: number[], y: number): number {
  let lo = 0
  let hi = offsets.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] <= y) lo = mid + 1
    else hi = mid
  }
  return Math.min(offsets.length, lo + 1)
}

export default ChatList
