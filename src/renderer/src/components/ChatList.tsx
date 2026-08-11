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

/**
 * Rows rendered outside the viewport, so scrolling never shows a gap — and, more importantly,
 * so a row is MEASURED before it is looked at.
 *
 * Deliberately lopsided. Reading history means travelling upward, and every row up there is
 * unmeasured: it is drawn at an estimate, corrected the moment it exists in the DOM, and the
 * correction moves everything below it. Measuring a long way ahead of the reader turns those
 * corrections into something that happens off screen. Downward the rows are almost always
 * measured already, so a screenful is plenty.
 */
const OVERSCAN_UP = 1200
const OVERSCAN_DOWN = 600
/**
 * What an unmeasured row is assumed to be.
 *
 * A constant is a bad guess: 34px was a small font with no spacing, and at a large font with
 * message spacing a real row is half again to twice that. Every one of those rows then lurches
 * when its real height lands, which is what deep upward scrolling looked like — messages
 * flickering as if drawn twice. The average of what HAS been measured is the same arithmetic
 * and a far better guess, and it costs one counter.
 */
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
  /** running mean of every row measured so far — the estimate for rows not yet seen */
  const avgHeight = useRef(FALLBACK_HEIGHT)
  const measuredCount = useRef(0)
  const measuredSum = useRef(0)
  /**
   * The guess handed to a row we have never measured — remembered, so it cannot change later.
   *
   * `avgHeight` moves a little every time a row is measured, and it used to be read fresh on every
   * rebuild. That silently re-valued EVERY unmeasured row at once, including the hundreds sitting
   * above the reader: their offsets shifted, the anchor restore faithfully followed the shift, and
   * the page crept. With the scroll locked and the buffer full — nothing arriving, nothing
   * growing — a row was measured sliding thirteen pixels down the screen in six seconds, about a
   * pixel per message, which is exactly what it looked like.
   *
   * Freezing each row's estimate the first time it is needed makes the geometry above the reader
   * stop moving for reasons that have nothing to do with the reader. The estimate is thrown away
   * the moment the row is really measured, so this costs nothing in accuracy.
   */
  const estimates = useRef(new Map<string, number>())
  const heightFor = useCallback((id: string): number => {
    const real = heights.current.get(id)
    if (real !== undefined) return real
    const kept = estimates.current.get(id)
    if (kept !== undefined) return kept
    const fresh = avgHeight.current
    estimates.current.set(id, fresh)
    return fresh
  }, [])
  const [, bump] = useState(0)
  const rerender = useCallback(() => bump((n) => n + 1), [])

  const scrollTopRef = useRef(0)
  const viewRef = useRef(0)
  /** the current layout, readable from callbacks that must not be rebuilt on every message */
  const offsetsRef = useRef<number[]>([])
  const msgsRef = useRef<ChatMessage[]>([])
  /** the slice actually on screen, so a scroll that does not change it can skip the render */
  const rangeRef = useRef({ from: 0, to: 0 })
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
  /**
   * The array itself changed in this update — set during render, consumed by the layout effect.
   *
   * Not the same thing as the head moving. Unfolding a mass-gift group INSERTS twenty rows into
   * the middle of the list: the head is untouched, and if those rows happen to be a height we
   * already know then nothing was re-measured either, so both of the old "something moved"
   * signals stayed false and the view was left wherever the insertion pushed it. Any change to
   * the array can move content under the reader, so any change re-asserts the anchor. When
   * nothing actually shifted — the usual case, a message appended at the end — the restore
   * computes the position the view is already at and the 0.5px guard drops it.
   */
  const listMoved = useRef(false)
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
  /** the glide's own fractional position; -1 when it is not running (see the glide) */
  const glidePos = useRef(-1)
  /** the deferred re-slice (see onScroll), and where the last one was taken from */
  const sliceRaf = useRef(0)
  const lastSliceAt = useRef(0)
  /** bumped whenever a height is written; the prefix sum is rebuilt only when it moves */
  const geomVersion = useRef(0)
  const builtFor = useRef(-1)
  const totalRef = useRef(0)

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
  /**
   * Which row element is currently under the growth watcher.
   *
   * The measure pass used to disconnect the observer and re-observe all ~60 rows every time it
   * ran, which on a scroll meant sixty removals and sixty additions per event — and, because
   * `observe()` re-fires an initial observation, sixty callbacks the next frame for rows that
   * had not moved a pixel. Keeping the element per id turns the whole thing into the two or
   * three rows that actually entered or left the slice.
   */
  const watched = useRef(new Map<string, HTMLElement>())
  /**
   * Rows whose cached height the observer has just contradicted.
   *
   * The measure pass reads `offsetHeight` off every row on screen, and the answer is almost
   * always the number already in the cache — sixty reads per commit to learn nothing. It only
   * needs to read a row it has never seen, or one this observer says has changed. Everything
   * else it already knows, and knowing it is the entire point of caching by message id.
   */
  const dirty = useRef(new Set<string>())
  if (!sizeWatch.current && typeof ResizeObserver !== 'undefined') {
    sizeWatch.current = new ResizeObserver((entries) => {
      let hit = false
      for (const e of entries) {
        const el = e.target as HTMLElement
        const id = el.dataset.mid
        if (!id) continue
        const h = el.offsetHeight
        if (h === 0 || heights.current.get(id) === h) continue
        dirty.current.add(id)
        hit = true
      }
      // one render for the batch: the measure pass fixes every marked row at once
      if (hit) rerenderRef.current()
    })
  }
  useEffect(
    () => () => {
      sizeWatch.current?.disconnect()
      if (sliceRaf.current) cancelAnimationFrame(sliceRaf.current)
    },
    []
  )
  /**
   * A settings change makes every cached height a guess again — but only for rows that come
   * back on screen, which is why a flag would not do. The generation number rides alongside
   * each measurement: anything stamped with an older one gets re-read the next time it is
   * rendered, and rows nobody looks at cost nothing until somebody does.
   */
  const generation = useRef(0)
  const measuredAt = useRef(new Map<string, number>())
  /** a row the reader deliberately opened or closed, consumed by the next layout effect */
  const deliberate = useRef(false)

  /**
   * A row announcing that it just changed height on purpose — a link card opened or closed, a
   * gift list unfolded. The re-render is scheduled from inside the reporter's LAYOUT effect, so
   * React flushes it before the browser paints: the measure pass, the new offsets and the
   * anchor restore all land in the same frame the row grew in. Left to the size observer alone
   * this arrives a frame later, and a frame is exactly what "the chat jumped" is made of.
   */
  useEffect(() => {
    const onRowResized = (e: Event): void => {
      // Both kinds need the same-frame re-render — that is what this signal is for. Only a
      // deliberate one also means "put it there NOW"; content arriving on its own is left to the
      // glide, which is already travelling to the bottom and picks the extra height up on its way.
      const detail = (e as CustomEvent<{ deliberate?: boolean }>).detail
      if (detail?.deliberate !== false) deliberate.current = true
      rerender()
    }
    window.addEventListener('sticki:rowresized', onRowResized)
    return () => window.removeEventListener('sticki:rowresized', onRowResized)
  }, [rerender])

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
  if (layoutRef.current !== layoutKey) {
    layoutRef.current = layoutKey
    generation.current++
    // the stale heights stay (see above) but the estimate for unmeasured rows is about to
    // change, so the sum has to be walked again
    geomVersion.current++
  }

  /**
   * The prefix sum, rebuilt only when it can have changed.
   *
   * It used to be recomputed on every render — a walk over the whole buffer with a map lookup
   * per message. At three thousand messages that is three thousand lookups for a wheel notch
   * that added one row to the slice, and it happens on the same thread as the scroll: not a
   * freeze, but a hitch you can feel, which is exactly how it was described. Two things can
   * invalidate it and nothing else can: the array changing, or a height being measured. Both
   * bump a counter, so the common case — the reader scrolling through rows nobody has touched
   * — reuses the array it already has.
   */
  const arrayChanged = prevRef.current !== messages
  if (arrayChanged || builtFor.current !== geomVersion.current) {
    const fresh: number[] = new Array(messages.length)
    let sum = 0
    for (let i = 0; i < messages.length; i++) {
      fresh[i] = sum
      sum += heightFor(messages[i].id)
    }
    offsetsRef.current = fresh
    totalRef.current = sum
    builtFor.current = geomVersion.current
  }
  const offsets = offsetsRef.current
  const total = totalRef.current

  // ---- how far the NUMBERING moved, so a message keeps its index for its whole life ----
  // (the scroll itself is handled by the anchor, which needs none of this)
  {
    const prev = prevRef.current
    if (prev !== messages) listMoved.current = true
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
  const from = lowerBound(offsets, scrollTopRef.current - OVERSCAN_UP)
  const to = upperBound(offsets, scrollTopRef.current + view + OVERSCAN_DOWN)

  // the current layout, readable from callbacks that must not be rebuilt on every message
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
  const pin = useCallback(
    (el: HTMLElement, height: number) => {
      const target = Math.max(0, height - el.clientHeight)
      el.scrollTop = target
      ourScrollTop.current = target
      scrollTopRef.current = target
      // re-anchor in the same breath. The scroll event that would otherwise do it is delivered
      // asynchronously, and any render arriving first would restore the anchor from before the
      // jump and quietly undo it — the same trap the resize handler documents.
      grabAnchor(target)
    },
    [grabAnchor]
  )

  useImperativeHandle(
    ref,
    () => ({
      toBottom: () => {
        const el = scRef.current
        if (el) pin(el, el.scrollHeight)
      },
      toIndex: (index: number) => {
        const el = scRef.current
        const off = offsetsRef.current
        const msgs = msgsRef.current
        if (!el || index < 0 || index >= off.length) return
        const h = heightFor(msgs[index].id)
        const target = Math.max(0, off[index] - (el.clientHeight - h) / 2)
        el.scrollTop = target
        ourScrollTop.current = target
        scrollTopRef.current = target
        grabAnchor(target)
      },
      scroller: () => scRef.current,
      distanceFromBottom: () => {
        const el = scRef.current
        return el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0
      }
    }),
    // everything in here reads through refs, so the handle is built once instead of on every
    // arriving message — which also stops the parent's effects from being torn down and rebuilt
    [pin, grabAnchor]
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
    // what is on screen is decided here, not during render: a render React discards would
    // otherwise leave the scroll handler comparing against a slice that was never committed,
    // and the render it then skipped is the one that fills the gap the reader scrolled into
    rangeRef.current = { from, to }

    // 1. measure, keeping the growth watcher armed on exactly the rows that exist now — rows
    //    that scrolled away stop being watched, and nothing is re-armed for no reason.
    let changed = false
    /** a row that was already on screen changed height, rather than a new one appearing */
    let corrected = false
    const gen = generation.current
    // a row the reader opened or closed in this very commit — read before the measure pass,
    // which has to treat it as a row it knows nothing about
    const opened = deliberate.current
    deliberate.current = false
    const shown = new Map<string, HTMLElement>()
    for (const row of Array.from(el.querySelectorAll<HTMLElement>('[data-mid]'))) {
      const id = row.dataset.mid
      if (!id) continue
      shown.set(id, row)
      // an element we have not seen before is either a row scrolling in or one React rebuilt,
      // and in both cases its height is worth reading even if we think we know it
      const entered = watched.current.get(id) !== row
      if (entered) sizeWatch.current?.observe(row)
      const was = heights.current.get(id)
      if (opened) {
        // a row the reader just opened or closed is the same element with the same generation
        // and nothing has contradicted it yet, so every test below would wave it through — and
        // the whole point of the pre-paint signal is that this height changes NOW rather than
        // whenever the observer gets round to saying so. It is one pass, on a click.
        const h = row.offsetHeight
        if (h === 0) continue
        dirty.current.delete(id)
        estimates.current.delete(id)
        measuredAt.current.set(id, gen)
        if (was === h) continue
        if (was === undefined) measuredCount.current++
        else {
          measuredSum.current -= was
          corrected = true
        }
        measuredSum.current += h
        avgHeight.current = measuredSum.current / measuredCount.current
        heights.current.set(id, h)
        geomVersion.current++
        changed = true
        continue
      }
      // Already known, still the same element, nobody has contradicted it, and the settings
      // that decide how tall a row draws have not moved: there is nothing to learn from reading
      // the DOM, and reading it is what made this loop cost sixty layout queries per commit
      // instead of the two or three rows that actually arrived.
      if (
        !entered &&
        was !== undefined &&
        !dirty.current.has(id) &&
        measuredAt.current.get(id) === gen
      ) {
        continue
      }
      const h = row.offsetHeight
      if (h === 0) continue
      dirty.current.delete(id)
      estimates.current.delete(id)
      measuredAt.current.set(id, gen)
      if (was === h) continue
      // a row we already knew has changed size — an emote or a badge finished loading and
      // rewrapped the line. Not an arrival, and it must not be animated like one (see the pin)
      if (was !== undefined) corrected = true
      // keep the running mean honest: a row measured twice replaces its own contribution
      if (was === undefined) measuredCount.current++
      else measuredSum.current -= was
      measuredSum.current += h
      avgHeight.current = measuredSum.current / measuredCount.current
      heights.current.set(id, h)
      geomVersion.current++
      changed = true
    }
    for (const [id, node] of watched.current) {
      if (shown.get(id) !== node) sizeWatch.current?.unobserve(node)
    }
    watched.current = shown

    /**
     * Forget the messages the ring buffer has already forgotten.
     *
     * Heights are keyed by message id and nothing ever removed them, so a night on a busy
     * channel left tens of thousands of entries for messages that no longer exist — and the
     * running mean was still averaging every one of them, which makes the estimate for a new
     * row slowly stop reflecting the rows actually on screen. Rebuilding at four times the
     * buffer size is rare enough to be free and keeps both honest.
     */
    if (heights.current.size > Math.max(4000, messages.length * 4)) {
      const keptH = new Map<string, number>()
      const keptG = new Map<string, number>()
      let sum = 0
      for (const m of messages) {
        const h = heights.current.get(m.id)
        if (h === undefined) continue
        keptH.set(m.id, h)
        sum += h
        const g = measuredAt.current.get(m.id)
        if (g !== undefined) keptG.set(m.id, g)
      }
      heights.current = keptH
      measuredAt.current = keptG
      // the estimates are keyed the same way and go stale the same way
      const keptE = new Map<string, number>()
      for (const m of messages) {
        const e = estimates.current.get(m.id)
        if (e !== undefined) keptE.set(m.id, e)
      }
      estimates.current = keptE
      geomVersion.current++
      measuredCount.current = keptH.size
      measuredSum.current = sum
      if (keptH.size) avgHeight.current = sum / keptH.size
    }

    /**
     * Rebuild the prefix sum from what was just measured — AND WRITE IT INTO THE DOM.
     *
     * Two separate faults lived here, and both of them read as "the chat moved on its own".
     *
     * `offsets` was built during render, BEFORE these corrections existed, and both the restore
     * below and the anchor grabbed at the end read from it. Working off numbers the measure
     * pass has already invalidated made every height correction nudge the view by its own error
     * instead of cancelling it.
     *
     * The second is worse and is why recomputing alone was not enough: the DOM is still laid
     * out from the render's numbers. The spacer is the OLD total, every row sits at its OLD
     * top. Assigning a scrollTop derived from the new geometry against the old document gets it
     * silently clamped when the new position is past the old end — and the correcting render
     * that follows has nothing left to tell it anything moved, so the view simply stays where
     * the clamp put it. Writing the spacer and the visible rows first makes the assignment land
     * in the document it was computed for, and makes this frame drawable as it stands: React's
     * catch-up render below is bookkeeping, not the thing the reader is waiting to see.
     */
    if (changed) {
      const fresh: number[] = new Array(messages.length)
      const indexOf = new Map<string, number>()
      let sum = 0
      for (let i = 0; i < messages.length; i++) {
        const id = messages[i].id
        fresh[i] = sum
        indexOf.set(id, i)
        sum += heightFor(id)
      }
      offsetsRef.current = fresh
      totalRef.current = sum
      builtFor.current = geomVersion.current
      const spacer = el.firstElementChild as HTMLElement | null
      if (spacer) spacer.style.height = `${sum}px`
      for (const [id, node] of shown) {
        const i = indexOf.get(id)
        if (i !== undefined) node.style.top = `${fresh[i]}px`
      }
    }
    const live = offsetsRef.current

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
    const moved = headMoved.current || listMoved.current || changed
    headMoved.current = false
    listMoved.current = false

    // Instant mode pins to the newest message and that is the whole behaviour.
    //
    // Smooth mode goes through the anchor even while following, and that is what makes it
    // smooth at all. Once the buffer is full, an arriving message does not make the document
    // taller — thirty pixels appear at the bottom and thirty vanish off the top, so the view
    // is still exactly at the end and a distance-based glide has nothing to travel. Holding
    // the anchor instead leaves the same text on screen, which CREATES that thirty pixels of
    // distance, and the animation below then eats it. That is the difference between a chat
    // that crawls and one that steps a line at a time.
    //
    // Two things are exceptions to smooth mode, and for the same reason: the glide exists to
    // animate messages ARRIVING, and neither of these is an arrival.
    //
    // A card the reader just opened is the page changing shape under the cursor; animating it
    // meant the card spent those frames sunk behind the input before rising into place.
    //
    // A row that was already on screen changing height is an emote or a badge finishing its
    // download and rewrapping the line — a correction, and one that lands well after the
    // message did. Gliding it produced the second, delayed nudge people described as the new
    // message "not quite finishing" its climb out from behind the input: the glide arrived,
    // stopped, and then a moment later crept a little further for no reason the reader could
    // see. Applied exactly, it is invisible.
    /** the anchor still describes where the view belongs — do not overwrite it below */
    let stillHeld = false
    /**
     * A row correcting its own height must not cancel a glide that is still in flight.
     *
     * `corrected` exists for the late correction — an emote, a badge or a link preview landing
     * after the message has already arrived and settled. Pinning exactly is right THEN: without
     * it the extra height starts a second, tiny glide a moment after the first ended, which reads
     * as the message creeping a little further for no reason.
     *
     * But the same flag fires while the first glide is still travelling, and pinning there spends
     * the entire remaining distance in one frame. Measured on this channel: a sent message with a
     * link moved 4, 6, then 87 pixels, while the identical message without one arrived in steps of
     * 4, 4, 3, 4, 3… The glide is already going to the bottom and picks the growth up on the way,
     * so it only needs to be left alone.
     */
    const settled = el.scrollHeight - el.clientHeight - el.scrollTop <= 2
    if (following.current && !locked && (!smooth || opened || (corrected && settled))) {
      pin(el, el.scrollHeight)
      stillHeld = true // pin re-anchors itself, in the same breath
    } else if (moved) {
      const a = anchor.current
      const i = a ? messages.findIndex((m) => m.id === a.id) : -1
      if (a && i >= 0) {
        const next = Math.max(0, (live[i] ?? 0) - a.gap)
        if (Math.abs(next - el.scrollTop) > 0.5) {
          el.scrollTop = next
          ourScrollTop.current = next
          scrollTopRef.current = next
        }
        stillHeld = true
      }
    }

    // 3. remember what to hold on to next time, from wherever the scroll ended up — but ONLY
    //    when we are not already holding on to something.
    //
    //    THIS IS WHERE THE PAGE USED TO CREEP. Re-anchoring ran unconditionally, including on the
    //    commits where the restore above had just been dropped by the half-pixel guard, and on the
    //    ones where assigning scrollTop lost a fraction to whole-pixel rounding. Either way the
    //    debt was real and small — and this line immediately rewrote the anchor to match where the
    //    view actually was, declaring the debt paid. Nothing ever collected it, so every trim gave
    //    away another fraction of a pixel in the same direction: with the scroll locked on a busy
    //    channel, a row measured sliding thirteen pixels down the screen in six seconds while the
    //    buffer height never changed.
    //
    //    Keeping the anchor makes the debt survive instead. It is still the same message and still
    //    the same intended gap; the correction simply waits until it is worth a whole pixel, and
    //    then it is spent. The view stops where it was put. An anchor whose message has been
    //    trimmed away is not held at all, so it falls through and a fresh one is taken.
    if (!stillHeld) grabAnchor(el.scrollTop)

    // 4. and only re-render if the corrections actually changed WHICH rows belong on screen.
    //    The geometry is already in the DOM, so a render that produces the same slice would
    //    write the same numbers back over themselves — and it is not one render, it is one per
    //    measure pass, which while scrolling into unmeasured history is every single event.
    if (changed) {
      const nf = lowerBound(live, el.scrollTop - OVERSCAN_UP)
      const nt = upperBound(live, el.scrollTop + el.clientHeight + OVERSCAN_DOWN)
      if (nf !== rangeRef.current.from || nt !== rangeRef.current.to) rerender()
    }
  })

  /**
   * The glide: one animation that never restarts, so a faster chat just moves it faster.
   *
   * Speed is proportional to how far behind it is, which makes the TIME to catch up roughly
   * constant whatever the distance — one line and ten lines both take about a quarter of a
   * second. That is the part that reads as smooth. The previous rule took a fixed fraction of
   * the remaining distance per FRAME, which spends most of the movement in the first two or
   * three frames and then crawls: for the one-line case that everybody actually watches, it
   * was over before the eye could follow it, which is why it looked no different from having
   * no animation at all. Frame time is measured rather than assumed, so a 144Hz screen glides
   * at the same speed as a 60Hz one instead of two and a half times faster.
   */
  useEffect(() => {
    if (!smooth || locked) return
    let raf = 0
    let last = performance.now()
    const step = (now: number): void => {
      raf = requestAnimationFrame(step)
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      const el = scRef.current
      if (!el || !following.current) {
        glidePos.current = -1
        return
      }
      const away = el.scrollHeight - el.scrollTop - el.clientHeight
      if (away < 0.5) {
        glidePos.current = -1
        return
      }
      // beyond a screen and a half this is a correction, not an animation — gliding across it
      // would be half a second of showing the wrong part of the conversation
      if (away > el.clientHeight * 1.5) {
        const end = el.scrollHeight - el.clientHeight
        el.scrollTop = end
        ourScrollTop.current = end
        scrollTopRef.current = end
        glidePos.current = -1
        return
      }
      /**
       * Fast enough to arrive, slow enough to be seen.
       *
       * Speed proportional to the distance is a time constant rather than a distance: a gap of
       * any size closes in about a tenth of a second. Too gentle and the chat outruns it and
       * the newest line never finishes climbing out from behind the input; too brisk and it is
       * over before the eye can follow, which is what taking a fixed fraction of the remaining
       * distance PER FRAME did.
       */
      const speed = Math.min(Math.max(away * 9, 90), 3000)
      /**
       * Keep the sub-pixel remainder OURSELVES, because scrollTop will not.
       *
       * The element rounds every scroll offset to a whole device pixel. Ask for 9702.9 and it
       * reads back 9702 — so a step smaller than a pixel is not slow, it is nothing at all, and
       * the next frame starts from the same place and throws away the same fraction again. At
       * 144Hz the step for a fifteen-pixel gap is 0.94px, so the glide simply stopped: measured
       * on a live chat, forty consecutive frames writing 9702.9 and reading 9702.0, while the
       * document height never moved. That is the whole "the new message does not quite arrive,
       * then creeps up later" report — later being whenever something else happened to nudge
       * the scroll across a pixel boundary. Carrying the fraction in a float of our own and
       * writing whole pixels means every frame's motion actually lands.
       */
      if (glidePos.current < 0 || Math.abs(el.scrollTop - Math.round(glidePos.current)) > 0.6) {
        glidePos.current = el.scrollTop
      }
      glidePos.current = Math.min(glidePos.current + speed * dt, el.scrollTop + away)
      const next = Math.round(glidePos.current)
      if (next === el.scrollTop) return
      el.scrollTop = next
      ourScrollTop.current = next
      scrollTopRef.current = next
      /**
       * Move the anchor WITH the glide, in the same breath.
       *
       * The anchor is otherwise refreshed by the scroll handler, and a scroll event is
       * dispatched asynchronously — so a render landing between a glide frame and its event
       * restores the anchor from before that frame and gives the pixels straight back. While
       * the glide is driving, it owns the anchor too.
       */
      grabAnchor(next)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [smooth, locked, following, grabAnchor])

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
        // Compensating happens even while the list is LOCKED. The lock means "do not chase new
        // messages", not "let the input eat the bottom of the page": with it on, a growing
        // input simply covered the last lines. Locked just takes the delta shift instead of the
        // pin, which is the same promise — the content under the reader does not move.
        const wanted =
          (following.current || atBottomRef.current) && !locked
            ? el.scrollHeight - el.clientHeight
            : el.scrollTop - delta
        const target = Math.max(0, Math.min(wanted, el.scrollHeight - el.clientHeight))
        if (Math.abs(el.scrollTop - target) > 0.5) {
          el.scrollTop = target
          scrollTopRef.current = target
          ourScrollTop.current = target
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
        // and say out loud where we ended up. `atBottom` is otherwise only recomputed in the
        // scroll handler, which runs asynchronously — long enough for a two-line jump in the
        // input to be read as "the reader has left the end", raising the new-messages chip and
        // handing the list to the anchor branch, which is what kept it parked below the end.
        const bottomNow = el.scrollHeight - el.scrollTop - el.clientHeight <= 40
        if (bottomNow !== atBottomRef.current) {
          atBottomRef.current = bottomNow
          onAtBottomChange?.(bottomNow)
        }
      }
      if (el.clientWidth === lastW) return
      lastW = el.clientWidth
      // a narrower pane rewraps every message, so every cached height is now a guess — the same
      // invalidation a font change gets, and for the same reason
      generation.current++
      rerender()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [rerender, following, locked, grabAnchor, onAtBottomChange])

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
    /**
     * Render only when the slice has to change.
     *
     * A wheel notch is dozens of events, and the overscan is a thousand pixels deep — most of
     * those events land inside rows that are already drawn, and the render they used to force
     * was a prefix sum over the whole buffer plus a reconciliation of every visible row plus a
     * measure pass, all to arrive at exactly the markup already on screen. Two binary searches
     * answer whether any of that is needed. This is the difference the reader feels as weight.
     */
    const off = offsetsRef.current
    const nf = lowerBound(off, el.scrollTop - OVERSCAN_UP)
    const nt = upperBound(off, el.scrollTop + el.clientHeight + OVERSCAN_DOWN)
    if (nf === rangeRef.current.from && nt === rangeRef.current.to) return

    /**
     * Re-slice on the NEXT frame, not inside the scroll event.
     *
     * A state update from a scroll handler is flushed synchronously, so the render, the measure
     * pass and the layout effect all ran before the browser was allowed to paint the frame the
     * reader had just scrolled. That is one dropped frame every time the slice changes — which,
     * at the edges of the overscan, is most of the way through a flick. It is exactly the shape
     * of "it stops for a moment and then carries on": the scroll itself is composited and
     * smooth, and we were the thing standing in front of it.
     *
     * Deferring is safe because the rows are already drawn a thousand pixels ahead. The one
     * case it is not safe is a fling that clears the whole overscan in a single frame, which
     * would show a band of nothing — so that one renders immediately, because a blank is worse
     * than a stutter.
     */
    const jumped = Math.abs(el.scrollTop - lastSliceAt.current) > OVERSCAN_DOWN
    if (jumped) {
      lastSliceAt.current = el.scrollTop
      if (sliceRaf.current) {
        cancelAnimationFrame(sliceRaf.current)
        sliceRaf.current = 0
      }
      rerender()
      return
    }
    if (sliceRaf.current) return
    sliceRaf.current = requestAnimationFrame(() => {
      sliceRaf.current = 0
      lastSliceAt.current = scRef.current?.scrollTop ?? lastSliceAt.current
      rerender()
    })
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
