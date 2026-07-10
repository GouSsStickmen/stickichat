/**
 * Pointer-based live reordering (replacement for HTML5 drag&drop): the cursor stays a
 * normal arrow, there is no floating ghost and no "no drop" sign — the list simply
 * rearranges under the finger, with the dragged item highlighted by the caller.
 */
export interface PointerReorderOptions {
  /** the pointerdown event that starts the interaction */
  e: { clientX: number; clientY: number; button: number }
  /** element that contains the reorderable items */
  container: HTMLElement
  /** selector matching the reorderable items inside the container */
  itemSelector: string
  /** index of the pressed item at drag start */
  index: number
  /** swap handler — receives CURRENT index of the dragged item and the target index */
  onMove: (from: number, to: number) => void
  /** called with true once the drag actually starts (passed threshold), false on finish */
  onDragState: (dragging: boolean) => void
  axis: 'x' | 'y' | 'both'
  /** px of movement before the drag engages (protects normal clicks) */
  threshold?: number
}

/** true briefly after a reorder-drag finished — lets click handlers ignore the ghost click */
export let justReordered = false

export function startPointerReorder(opts: PointerReorderOptions): void {
  if (opts.e.button !== 0) return
  const start = { x: opts.e.clientX, y: opts.e.clientY }
  const threshold = opts.threshold ?? 5
  let active = false
  let current = opts.index

  const items = (): HTMLElement[] =>
    Array.from(opts.container.querySelectorAll<HTMLElement>(opts.itemSelector))

  const onMove = (ev: PointerEvent): void => {
    const dx = ev.clientX - start.x
    const dy = ev.clientY - start.y
    if (!active) {
      if (Math.hypot(dx, dy) < threshold) return
      active = true
      opts.onDragState(true)
      document.getSelection()?.removeAllRanges()
    }
    const list = items()
    const target = list.findIndex((el) => {
      const r = el.getBoundingClientRect()
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom
    })
    if (target === -1 || target === current) return
    const r = list[target].getBoundingClientRect()
    // only reorder after the pointer crosses the target's middle — no boundary flicker
    const pastMiddle =
      opts.axis === 'y'
        ? ev.clientY > r.top + r.height / 2
        : ev.clientX > r.left + r.width / 2
    const shouldMove = (current < target && pastMiddle) || (current > target && !pastMiddle)
    if (!shouldMove) return
    opts.onMove(current, target)
    current = target
  }

  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (active) {
      opts.onDragState(false)
      justReordered = true
      window.setTimeout(() => {
        justReordered = false
      }, 0)
    }
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
