import { RefObject, useLayoutEffect, useRef } from 'react'

/**
 * FLIP list animation: when the order of items changes (drag reorder, add, remove),
 * every item glides from its previous position to the new one — the Chrome-tabs feel.
 * Items are identified by their `data-flipid` attribute.
 *
 * While a drag is live, reorder instantly and only record positions: spawning an
 * animation per pointermove floods the compositor, and getBoundingClientRect() of a
 * mid-flight element feeds wrong rects back into the drag hit-testing (items "jump").
 */
export function useFlip(
  containerRef: RefObject<HTMLElement | null>,
  itemSelector: string,
  dragging: boolean
): void {
  const prevRects = useRef(new Map<string, { left: number; top: number }>())
  const prevSize = useRef({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    // A RESIZE is not a reorder. Tabs move because the row rewrapped, and gliding them from
    // where they used to be is wrong by intent — nothing was reordered, the box changed.
    //
    // Honest note: this was written to explain "tabs jump and cannot settle while resizing a
    // window with a busy chat", and it did NOT reproduce. A window resize does not re-render
    // the tab bar at all — flex-wrap rewraps the row in CSS, so this effect never runs and no
    // glide is ever started; measured, zero in both directions. Kept because animating a
    // reflow would still be wrong the moment something else does trigger a render mid-resize,
    // but it is not a confirmed fix for that report.
    const w = container.clientWidth
    const h = container.clientHeight
    const resized = w !== prevSize.current.w || h !== prevSize.current.h
    prevSize.current = { w, h }
    // offsetLeft/offsetTop, NOT getBoundingClientRect: rects include transforms, so measuring
    // an element mid-glide returns where it currently APPEARS, and storing that as its
    // "previous" position makes the next pass animate from a place it was never laid out in.
    // Offsets are pure layout and ignore the animation entirely.
    for (const el of Array.from(container.querySelectorAll<HTMLElement>(itemSelector))) {
      const id = el.dataset.flipid
      if (!id) continue
      const rect = { left: el.offsetLeft, top: el.offsetTop }
      if (dragging || resized) {
        prevRects.current.set(id, rect)
        continue
      }
      const prev = prevRects.current.get(id)
      if (prev) {
        const dx = prev.left - rect.left
        const dy = prev.top - rect.top
        if (dx !== 0 || dy !== 0) {
          el.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
            { duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
          )
        }
      }
      prevRects.current.set(id, rect)
    }
  })
}
