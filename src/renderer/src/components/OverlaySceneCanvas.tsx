import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Anchor9,
  OverlayNode,
  OverlayScene,
  updateNode
} from '../lib/overlayScene'
import { boxStyleCss, layoutCss, nodeRect, offsetsForRect, textStyleCss } from '../lib/overlayNodeStyle'

/**
 * The editing surface: what the overlay will look like, with handles on it.
 *
 * Everything here works in CONTAINER PIXELS and converts to the node's anchor-relative offsets
 * only at the moment of writing, through `offsetsForRect`. Dragging in anchor space directly
 * looks fine until an element is pinned to the right edge, where every movement then has to be
 * inverted — and getting that wrong is how editors end up with handles that fight the cursor.
 */

const HANDLES: { id: Anchor9; cursor: string }[] = [
  { id: 'tl', cursor: 'nwse-resize' },
  { id: 'top', cursor: 'ns-resize' },
  { id: 'tr', cursor: 'nesw-resize' },
  { id: 'left', cursor: 'ew-resize' },
  { id: 'right', cursor: 'ew-resize' },
  { id: 'bl', cursor: 'nesw-resize' },
  { id: 'bottom', cursor: 'ns-resize' },
  { id: 'br', cursor: 'nwse-resize' }
]

/** how close, in px, before an edge grabs — generous enough to feel magnetic, small enough to escape */
const SNAP = 6

interface Guide {
  axis: 'x' | 'y'
  at: number
}

interface Props {
  scene: OverlayScene
  space: 'scene' | 'template'
  /** the drawing area, in overlay pixels */
  size: { w: number; h: number }
  selected: string | null
  onSelect: (id: string | null) => void
  onChange: (scene: OverlayScene) => void
  /** draw the real overlay behind the elements, so placement is judged against the real thing */
  backdrop?: React.ReactNode
}

export default function OverlaySceneCanvas({
  scene,
  space,
  size,
  selected,
  onSelect,
  onChange,
  backdrop
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  /** measured sizes of content-sized elements, so handles sit on what is actually drawn */
  const measured = useRef(new Map<string, { w: number; h: number }>())
  const [, forceMeasure] = useState(0)

  const nodes = scene[space]
  const sel = selected ? nodes.find((n) => n.id === selected) : undefined

  // an element with no explicit width is as big as its content, and only the DOM knows how big
  // that is — the handles would otherwise sit on a zero-sized box
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    let changed = false
    for (const n of nodes) {
      const el = host.querySelector<HTMLElement>(`[data-node="${n.id}"]`)
      if (!el) continue
      const r = { w: el.offsetWidth, h: el.offsetHeight }
      const was = measured.current.get(n.id)
      if (!was || was.w !== r.w || was.h !== r.h) {
        measured.current.set(n.id, r)
        changed = true
      }
    }
    if (changed) forceMeasure((v) => v + 1)
  })

  const rectOf = useCallback(
    (n: OverlayNode) => nodeRect(n, size, measured.current.get(n.id)),
    [size]
  )

  /**
   * Candidate lines to snap against: the container's edges and middles, plus every other
   * element's edges and middles. Photoshop's rulers do the same thing and it is the single
   * feature that makes free placement usable rather than fiddly.
   */
  const snapLines = useCallback(
    (exceptId: string) => {
      const xs = [0, size.w / 2, size.w]
      const ys = [0, size.h / 2, size.h]
      for (const n of nodes) {
        if (n.id === exceptId || n.hidden) continue
        const r = rectOf(n)
        xs.push(r.x, r.x + r.w / 2, r.x + r.w)
        ys.push(r.y, r.y + r.h / 2, r.y + r.h)
      }
      return { xs, ys }
    },
    [nodes, rectOf, size]
  )

  const snap = (value: number, candidates: number[]): { v: number; hit: number | null } => {
    let best: number | null = null
    let dist = SNAP
    for (const c of candidates) {
      const d = Math.abs(value - c)
      if (d < dist) {
        dist = d
        best = c
      }
    }
    return { v: best ?? value, hit: best }
  }

  const beginDrag = (e: React.PointerEvent, node: OverlayNode, handle: Anchor9 | 'move' | 'rotate'): void => {
    if (e.button !== 0 || node.locked) return
    e.preventDefault()
    e.stopPropagation()
    const host = hostRef.current
    if (!host) return
    const hostBox = host.getBoundingClientRect()
    const scaleX = size.w / hostBox.width
    const start = { x: e.clientX, y: e.clientY }
    const startRect = rectOf(node)
    const startRotate = node.rotate
    const lines = snapLines(node.id)
    const centre = { x: startRect.x + startRect.w / 2, y: startRect.y + startRect.h / 2 }
    const ratio = node.aspect ?? (startRect.h ? startRect.w / startRect.h : 1)

    const onMove = (ev: PointerEvent): void => {
      const dx = (ev.clientX - start.x) * scaleX
      const dy = (ev.clientY - start.y) * scaleX
      const shown: Guide[] = []

      if (handle === 'rotate') {
        const a0 = Math.atan2(start.y - (hostBox.top + centre.y / scaleX), start.x - (hostBox.left + centre.x / scaleX))
        const a1 = Math.atan2(ev.clientY - (hostBox.top + centre.y / scaleX), ev.clientX - (hostBox.left + centre.x / scaleX))
        let deg = startRotate + ((a1 - a0) * 180) / Math.PI
        // holding shift steps in fifteens, the angles anyone actually wants
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15
        onChange(updateNode(scene, node.id, { rotate: Math.round(deg) }))
        return
      }

      let rect = { ...startRect }
      if (handle === 'move') {
        rect.x += dx
        rect.y += dy
        const l = snap(rect.x, lines.xs)
        const r = snap(rect.x + rect.w, lines.xs)
        const cx = snap(rect.x + rect.w / 2, lines.xs)
        if (l.hit !== null) { rect.x = l.v; shown.push({ axis: 'x', at: l.v }) }
        else if (r.hit !== null) { rect.x = r.v - rect.w; shown.push({ axis: 'x', at: r.v }) }
        else if (cx.hit !== null) { rect.x = cx.v - rect.w / 2; shown.push({ axis: 'x', at: cx.v }) }
        const t = snap(rect.y, lines.ys)
        const b = snap(rect.y + rect.h, lines.ys)
        const cy = snap(rect.y + rect.h / 2, lines.ys)
        if (t.hit !== null) { rect.y = t.v; shown.push({ axis: 'y', at: t.v }) }
        else if (b.hit !== null) { rect.y = b.v - rect.h; shown.push({ axis: 'y', at: b.v }) }
        else if (cy.hit !== null) { rect.y = cy.v - rect.h / 2; shown.push({ axis: 'y', at: cy.v }) }
      } else {
        const west = handle === 'tl' || handle === 'left' || handle === 'bl'
        const east = handle === 'tr' || handle === 'right' || handle === 'br'
        const north = handle === 'tl' || handle === 'top' || handle === 'tr'
        const south = handle === 'bl' || handle === 'bottom' || handle === 'br'
        if (west) { rect.x = startRect.x + dx; rect.w = startRect.w - dx }
        if (east) rect.w = startRect.w + dx
        if (north) { rect.y = startRect.y + dy; rect.h = startRect.h - dy }
        if (south) rect.h = startRect.h + dy
        // shift, or a locked aspect, keeps the proportions — driven by whichever side moved
        if (ev.shiftKey || node.lockAspect) {
          if (west || east) rect.h = rect.w / ratio
          else rect.w = rect.h * ratio
        }
        rect.w = Math.max(4, rect.w)
        rect.h = Math.max(4, rect.h)
      }

      const next = offsetsForRect(node, rect, size)
      const patch: Partial<OverlayNode> = { x: Math.round(next.x), y: Math.round(next.y) }
      if (handle !== 'move') {
        patch.w = Math.round(rect.w / node.scale)
        patch.h = Math.round(rect.h / node.scale)
      }
      setGuides(shown)
      onChange(updateNode(scene, node.id, patch))
    }

    const onUp = (): void => {
      setGuides([])
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // arrow keys nudge; with shift, ten at a time
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!sel || sel.locked) return
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, select')) return
      const step = e.shiftKey ? 10 : 1
      const d: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step]
      }
      const move = d[e.key]
      if (!move) return
      e.preventDefault()
      onChange(updateNode(scene, sel.id, { x: sel.x + move[0], y: sel.y + move[1] }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel, scene, onChange])

  const selRect = sel ? rectOf(sel) : null

  return (
    <div
      className="osc-host"
      ref={hostRef}
      style={{ width: size.w, height: size.h }}
      onPointerDown={() => onSelect(null)}
    >
      {backdrop && <div className="osc-backdrop">{backdrop}</div>}

      {nodes.map((n) => (
        <div
          key={n.id}
          data-node={n.id}
          className={`osc-node ${n.id === selected ? 'sel' : ''} ${n.locked ? 'locked' : ''}`}
          style={layoutCss(n) as React.CSSProperties}
          onPointerDown={(e) => {
            onSelect(n.id)
            beginDrag(e, n, 'move')
          }}
        >
          <NodeBody node={n} />
        </div>
      ))}

      {/* the frame is drawn OUTSIDE the node so it is never rotated or faded with it */}
      {sel && selRect && (
        <div
          className="osc-frame"
          style={{
            left: selRect.x,
            top: selRect.y,
            width: selRect.w,
            height: selRect.h,
            transform: sel.rotate ? `rotate(${sel.rotate}deg)` : undefined,
            transformOrigin: 'center'
          }}
        >
          {!sel.locked &&
            HANDLES.map((h) => (
              <span
                key={h.id}
                className={`osc-handle h-${h.id}`}
                style={{ cursor: h.cursor }}
                onPointerDown={(e) => beginDrag(e, sel, h.id)}
              />
            ))}
          {!sel.locked && (
            <span className="osc-rotate" onPointerDown={(e) => beginDrag(e, sel, 'rotate')} />
          )}
        </div>
      )}

      {guides.map((g, i) => (
        <div
          key={i}
          className={`osc-guide ${g.axis}`}
          style={g.axis === 'x' ? { left: g.at } : { top: g.at }}
        />
      ))}
    </div>
  )
}

/** what each kind of element actually draws */
function NodeBody({ node }: { node: OverlayNode }): React.JSX.Element | null {
  switch (node.kind) {
    case 'box':
      return (
        <div
          className="osc-box"
          style={{
            ...(boxStyleCss(node.style) as React.CSSProperties),
            borderRadius: node.shape === 'ellipse' ? '50%' : (boxStyleCss(node.style).borderRadius ?? undefined)
          }}
        />
      )
    case 'image':
    case 'trigger':
      return (
        <img
          className="osc-img"
          src={node.image}
          alt=""
          draggable={false}
          style={{
            // 'stretch' is our word for it; CSS calls it 'fill'
            objectFit:
              node.kind === 'image' ? (node.fit === 'stretch' ? 'fill' : (node.fit ?? 'contain')) : 'contain',
            ...(boxStyleCss(node.style) as React.CSSProperties)
          }}
        />
      )
    case 'text':
      return (
        <div className="osc-text" style={textStyleCss(node.style) as React.CSSProperties}>
          {node.bind === 'static' ? (node.text ?? '') : SAMPLE[node.bind]}
        </div>
      )
    case 'badges':
      return (
        <div
          className="osc-badges"
          style={{ display: 'flex', flexDirection: node.direction, gap: node.gap }}
        >
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: node.itemSize, height: node.itemSize }} className="osc-badge-dot" />
          ))}
        </div>
      )
    case 'avatar':
      return (
        <div
          className="osc-avatar"
          style={{
            borderRadius: node.shape === 'circle' ? '50%' : undefined,
            ...(boxStyleCss(node.style) as React.CSSProperties)
          }}
        />
      )
    case 'group':
      return null
    default:
      return null
  }
}

/** stand-ins for the bound fields, so the canvas shows something with the right shape */
const SAMPLE: Record<string, string> = {
  nick: 'Bobik069',
  message: 'приклад повідомлення',
  timestamp: '12:34',
  channel: 'gous_stickmen',
  event: 'подія'
}
