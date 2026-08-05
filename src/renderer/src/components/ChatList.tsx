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
  /** how far the head moved in this update, in pixels — subtracted from scrollTop before paint */
  const trimmedPx = useRef(0)
  const prevRef = useRef<ChatMessage[]>([])
  const atBottomRef = useRef(true)
  /** the last scrollTop WE wrote, so a scroll event can tell our move from the user's */
  const ourScrollTop = useRef(-1)

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

  // ---- how much disappeared off the front since the last render ----
  {
    const prev = prevRef.current
    if (prev !== messages && prev.length && messages.length) {
      const firstId = messages[0].id
      if (prev[0].id !== firstId) {
        let cut = 0
        for (const m of prev) {
          if (m.id === firstId) break
          cut += heights.current.get(m.id) ?? FALLBACK_HEIGHT
        }
        // only if we actually found the new head further along — otherwise the two lists are
        // unrelated (channel cleared) and there is nothing to compensate
        if (prev.some((m) => m.id === firstId)) trimmedPx.current += cut
      }
    }
    prevRef.current = messages
  }

  // ---- which rows to actually render ----
  const view = viewRef.current || 1
  const from = lowerBound(offsets, scrollTopRef.current - OVERSCAN)
  const to = upperBound(offsets, scrollTopRef.current + view + OVERSCAN)

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

    // 1. measure — and note how much of the change was above the fold
    let changed = false
    let shiftAbove = 0
    for (const row of Array.from(el.querySelectorAll<HTMLElement>('[data-mid]'))) {
      const id = row.dataset.mid
      if (!id) continue
      const h = row.offsetHeight
      if (h === 0) continue
      const was = heights.current.get(id)
      if (was === h) continue
      heights.current.set(id, h)
      changed = true
      if (was !== undefined && row.offsetTop < scrollTopRef.current) shiftAbove += h - was
    }

    // 2. the head was cut: everything left slid up by exactly that much, so slide the view too
    const cut = trimmedPx.current
    trimmedPx.current = 0

    if (locked) {
      if (cut || shiftAbove) {
        const next = Math.max(0, el.scrollTop - cut + shiftAbove)
        el.scrollTop = next
        ourScrollTop.current = next
        scrollTopRef.current = next
      }
    } else if (following.current && !smooth) {
      pin(el, el.scrollHeight)
    } else if (cut || shiftAbove) {
      const next = Math.max(0, el.scrollTop - cut + shiftAbove)
      el.scrollTop = next
      ourScrollTop.current = next
      scrollTopRef.current = next
    }

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
    const ro = new ResizeObserver(() => {
      viewRef.current = el.clientHeight
      if (el.clientWidth === lastW) return
      lastW = el.clientWidth
      rerender()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [rerender])

  const onScroll = useCallback((): void => {
    const el = scRef.current
    if (!el) return
    const top = el.scrollTop
    // our own writes come back as scroll events too; only a move we did not make is the user
    const mine = Math.abs(top - ourScrollTop.current) < 1.5
    scrollTopRef.current = top
    if (!mine && top < ourScrollTop.current - 1.5) onUserScrolledUp?.()
    ourScrollTop.current = top
    const bottom = el.scrollHeight - top - el.clientHeight <= 40
    if (bottom !== atBottomRef.current) {
      atBottomRef.current = bottom
      onAtBottomChange?.(bottom)
    }
    rerender()
  }, [onAtBottomChange, onUserScrolledUp, rerender])

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
        {renderRow(m, i)}
      </div>
    )
  }

  return (
    <div ref={scRef} className="chat-scroller" data-chat-scroller="true" onScroll={onScroll}>
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
