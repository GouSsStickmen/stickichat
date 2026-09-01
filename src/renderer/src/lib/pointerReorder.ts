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
  /**
   * Where the drag was released, when it went somewhere outside the list.
   *
   * Reordering answers "in what order", and dropping answers "into what" — the same gesture, two
   * questions. Returning true means the drop was taken and the reorder should be treated as
   * cancelled rather than applied at whatever index the pointer happened to be over.
   */
  onDropOutside?: (target: Element | null) => boolean
  /** carry a copy of the dragged element under the cursor, so the drag is visible as a drag */
  ghost?: boolean
  /**
   * Somewhere else the drag can be aimed at.
   *
   * While the pointer is over one of these, it takes the class and the list stops rearranging —
   * travelling to a drop target passed over half the collection on the way and shuffled all of it.
   */
  hoverTarget?: { selector: string; className: string }
}

/** true briefly after a reorder-drag finished — lets click handlers ignore the ghost click */
export let justReordered = false

export function startPointerReorder(opts: PointerReorderOptions): void {
  if (opts.e.button !== 0) return
  const start = { x: opts.e.clientX, y: opts.e.clientY }
  const threshold = opts.threshold ?? 5
  let active = false
  let lastSwapAt: { x: number; y: number } | null = null

  const items = (): HTMLElement[] =>
    Array.from(opts.container.querySelectorAll<HTMLElement>(opts.itemSelector))

  // The element being dragged, not its index. React re-renders asynchronously, so after a
  // swap the next pointermove could still see the OLD dom order while a locally-tracked index
  // had already moved on — the two disagreed and the drag started shuffling rows it was never
  // touching. The node itself survives reordering (React moves it, keyed by id), so asking
  // the dom where it is right now can't desync.
  let dragEl: HTMLElement | null = null
  let ghostEl: HTMLElement | null = null
  let hovered: Element | null = null

  const moveGhost = (ev: PointerEvent): void => {
    if (!ghostEl) return
    /*
     * Utility windows zoom themselves with `zoom` on the root element, and that changes what a
     * fixed position means: pointer coordinates arrive in the unzoomed viewport while a fixed
     * element inside the zoomed root is laid out in the zoomed one. Without dividing it back out,
     * the ghost drifts away from the cursor by exactly the zoom factor — further the more it is
     * zoomed, which is why it looked fine in the main window and flew off in the picker's own.
     */
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom || '1') || 1
    ghostEl.style.left = `${ev.clientX / zoom}px`
    ghostEl.style.top = `${ev.clientY / zoom}px`
  }

  const markHover = (ev: PointerEvent): Element | null => {
    if (!opts.hoverTarget) return null
    const under = document
      .elementFromPoint(ev.clientX, ev.clientY)
      ?.closest(opts.hoverTarget.selector) ?? null
    if (under !== hovered) {
      if (hovered) hovered.classList.remove(opts.hoverTarget.className)
      if (under) under.classList.add(opts.hoverTarget.className)
      hovered = under
    }
    return under
  }

  const onMove = (ev: PointerEvent): void => {
    const dx = ev.clientX - start.x
    const dy = ev.clientY - start.y
    if (!active) {
      if (Math.hypot(dx, dy) < threshold) return
      active = true
      dragEl = items()[opts.index] ?? null
      opts.onDragState(true)
      if (opts.ghost && dragEl) {
        ghostEl = dragEl.cloneNode(true) as HTMLElement
        ghostEl.className = `${ghostEl.className} reorder-ghost`
        document.body.appendChild(ghostEl)
        moveGhost(ev)
      }
      document.getSelection()?.removeAllRanges()
    }
    moveGhost(ev)
    // aimed at a drop target: nothing in the list moves while the pointer is over one
    if (markHover(ev)) return
    const list = items()
    if (!dragEl) return
    const current = list.indexOf(dragEl)
    if (current === -1) return
    const target = list.findIndex((el) => {
      const r = el.getBoundingClientRect()
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom
    })
    if (target === -1 || target === current) return
    // a swap reflows the whole list — if the pointer hasn't moved since the last one,
    // whatever is under it now is a layout artifact, not user intent (kills A↔B loops
    // when tabs of different widths shuffle between wrapped rows)
    if (lastSwapAt && Math.hypot(ev.clientX - lastSwapAt.x, ev.clientY - lastSwapAt.y) < 8) return
    const r = list[target].getBoundingClientRect()
    const curRect = list[current].getBoundingClientRect()
    // in a wrapping horizontal list the target may sit on ANOTHER row — being inside it
    // is unambiguous there, and comparing x-middles across rows is meaningless
    const sameRow = opts.axis !== 'x' || Math.abs(r.top - curRect.top) < r.height / 2
    // only reorder after the pointer crosses the target's middle — no boundary flicker
    const pastMiddle =
      opts.axis === 'y'
        ? ev.clientY > r.top + r.height / 2
        : ev.clientX > r.left + r.width / 2
    const shouldMove =
      !sameRow || (current < target && pastMiddle) || (current > target && !pastMiddle)
    if (!shouldMove) return
    opts.onMove(current, target)
    lastSwapAt = { x: ev.clientX, y: ev.clientY }
  }

  const cleanupVisuals = (): void => {
    ghostEl?.remove()
    ghostEl = null
    if (hovered && opts.hoverTarget) hovered.classList.remove(opts.hoverTarget.className)
    hovered = null
  }

  const onUp = (ev?: PointerEvent): void => {
    cleanupVisuals()
    // a release over something that is not part of the list is a drop, and the caller decides
    if (active && opts.onDropOutside && ev) {
      const under = document.elementFromPoint(ev.clientX, ev.clientY)
      if (!under?.closest(opts.itemSelector)) opts.onDropOutside(under)
    }
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    // touch only: if the browser decides mid-drag that the gesture was a scroll after all, `pointerup`
    // never comes and without this the listeners — and the caller's "dragging" highlight — stay behind
    window.removeEventListener('pointercancel', onUp)
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
  window.addEventListener('pointercancel', onUp)
}
