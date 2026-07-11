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
  const prevRects = useRef(new Map<string, DOMRect>())
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    for (const el of Array.from(container.querySelectorAll<HTMLElement>(itemSelector))) {
      const id = el.dataset.flipid
      if (!id) continue
      const rect = el.getBoundingClientRect()
      if (dragging) {
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
