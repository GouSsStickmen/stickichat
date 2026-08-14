import type { Anchor9, BoxStyle, Fill, NodeBase, Radius, Shadow, TextStyle } from './overlayScene'

/**
 * One element → the CSS that draws it. Deliberately pure and dependency-free.
 *
 * The editor canvas and the overlay page have to agree PERFECTLY on where something sits: the
 * canvas is a promise about what OBS will show, and a promise that is off by three pixels is
 * worse than no preview at all. Two implementations would drift the first time either side was
 * touched, so there is one, it takes a node and returns a style object, and both sides call it.
 *
 * No imports beyond the types, so this can also be handed to the overlay page — which is plain
 * script served from the main process and cannot reach into the renderer's bundle.
 */

/** where a nine-point anchor sits, as fractions of the box */
export function anchorFractions(a: Anchor9): { fx: number; fy: number } {
  const fx = a === 'tl' || a === 'left' || a === 'bl' ? 0 : a === 'top' || a === 'center' || a === 'bottom' ? 0.5 : 1
  const fy = a === 'tl' || a === 'top' || a === 'tr' ? 0 : a === 'left' || a === 'center' || a === 'right' ? 0.5 : 1
  return { fx, fy }
}

function radiusCss(r: Radius | undefined): string | undefined {
  if (r === undefined) return undefined
  return typeof r === 'number' ? `${r}px` : r.map((v) => `${v}px`).join(' ')
}

function stopsCss(fill: Fill): string {
  const stops = fill.stops?.length ? fill.stops : [{ at: 0, color: fill.color ?? '#000' }, { at: 1, color: 'transparent' }]
  return [...stops]
    .sort((a, b) => a.at - b.at)
    .map((s) => `${s.color} ${Math.round(s.at * 100)}%`)
    .join(', ')
}

/** a fill as the `background` shorthand, or undefined when there is nothing to paint */
export function fillCss(fill: Fill | undefined): string | undefined {
  if (!fill || fill.kind === 'none') return undefined
  switch (fill.kind) {
    case 'solid':
      return fill.color
    case 'linear':
      return `linear-gradient(${fill.angle ?? 90}deg, ${stopsCss(fill)})`
    case 'radial':
      return `radial-gradient(circle at 50% 50%, ${stopsCss(fill)})`
    case 'image': {
      if (!fill.image) return undefined
      const size = fill.fit === 'tile' ? 'auto' : fill.fit === 'stretch' ? '100% 100%' : (fill.fit ?? 'cover')
      const repeat = fill.fit === 'tile' ? 'repeat' : 'no-repeat'
      return `url("${fill.image}") center / ${size} ${repeat}`
    }
    default:
      return undefined
  }
}

function shadowsCss(shadows: Shadow[] | undefined): string[] {
  return (shadows ?? []).map(
    (s) => `${s.inset ? 'inset ' : ''}${s.x}px ${s.y}px ${s.blur}px ${s.spread ?? 0}px ${s.color}`
  )
}

/** fills, stroke, radius, shadows and backdrop blur — everything a box wears */
export function boxStyleCss(style: BoxStyle | undefined): Record<string, string | undefined> {
  if (!style) return {}
  const shadows = shadowsCss(style.shadows)
  if (style.stroke && style.stroke.width > 0) {
    // as a shadow rather than a border, so the stroke never changes the element's size — a border
    // would move everything pinned to its edges the moment the width changed
    shadows.unshift(
      `${style.stroke.inset ? 'inset ' : ''}0 0 0 ${style.stroke.width}px ${style.stroke.color}`
    )
  }
  return {
    background: fillCss(style.fill),
    borderRadius: radiusCss(style.radius),
    boxShadow: shadows.length ? shadows.join(', ') : undefined,
    backdropFilter: style.backdrop ? `blur(${style.backdrop}px)` : undefined
  }
}

export function textStyleCss(style: TextStyle | undefined): Record<string, string | undefined> {
  if (!style) return {}
  const out: Record<string, string | undefined> = {
    fontFamily: style.font || undefined,
    fontSize: style.size ? `${style.size}px` : undefined,
    fontWeight: style.weight ? String(style.weight) : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    color: style.color,
    textAlign: style.align,
    letterSpacing: style.letterSpacing ? `${style.letterSpacing}px` : undefined,
    lineHeight: style.lineHeight ? String(style.lineHeight) : undefined,
    textTransform: style.case === 'upper' ? 'uppercase' : style.case === 'lower' ? 'lowercase' : undefined
  }
  if (style.outline && style.outline.width > 0) {
    out.WebkitTextStrokeWidth = `${style.outline.width}px`
    out.WebkitTextStrokeColor = style.outline.color
    // the stroke is drawn centred on the glyph edge and eats into it; painting the fill again on
    // top keeps thin letters legible at the outline widths people actually use on stream
    out.paintOrder = 'stroke fill'
  }
  if (style.shadows?.length) {
    // text-shadow has no spread and no inset — the two properties a box shadow carries that a
    // glyph cannot, so they are dropped rather than approximated into something that looks wrong
    out.textShadow = style.shadows.map((s) => `${s.x}px ${s.y}px ${s.blur}px ${s.color}`).join(', ')
  }
  if (style.fill && style.fill.kind !== 'none' && style.fill.kind !== 'solid') {
    // gradient text: paint the gradient and let the glyphs be the window onto it
    out.background = fillCss(style.fill)
    out.WebkitBackgroundClip = 'text'
    out.backgroundClip = 'text'
    out.color = 'transparent'
  }
  return out
}

/**
 * Placement.
 *
 * `anchor` picks the point of the CONTAINER the coordinates start from (a percentage offset), and
 * `origin` picks the point of the ELEMENT that lands there (a percentage translate of its own
 * size). Rotation and scale then happen about that same pinned point, so turning a badge pinned
 * to a corner pivots on the corner instead of wandering away from it.
 */
export function layoutCss(node: NodeBase): Record<string, string | number | undefined> {
  if (node.stretch) {
    // no anchors, no origin, no size: it simply is the container
    return {
      position: 'absolute',
      inset: 0,
      transform: node.rotate ? `rotate(${node.rotate}deg)` : undefined,
      opacity: node.opacity !== 1 ? node.opacity : undefined,
      mixBlendMode: node.blend && node.blend !== 'normal' ? node.blend : undefined,
      display: node.hidden ? 'none' : undefined
    }
  }
  const a = anchorFractions(node.anchor)
  const o = anchorFractions(node.origin)
  const parts = [
    `translate(${node.x}px, ${node.y}px)`,
    `translate(${-o.fx * 100}%, ${-o.fy * 100}%)`
  ]
  if (node.rotate) parts.push(`rotate(${node.rotate}deg)`)
  if (node.scale !== 1) parts.push(`scale(${node.scale})`)
  return {
    position: 'absolute',
    left: `${a.fx * 100}%`,
    top: `${a.fy * 100}%`,
    width: node.w !== undefined ? `${node.w}px` : undefined,
    height: node.h !== undefined ? `${node.h}px` : undefined,
    transform: parts.join(' '),
    transformOrigin: `${o.fx * 100}% ${o.fy * 100}%`,
    opacity: node.opacity !== 1 ? node.opacity : undefined,
    mixBlendMode: node.blend && node.blend !== 'normal' ? node.blend : undefined,
    display: node.hidden ? 'none' : undefined
  }
}

/**
 * The element's box on screen, in container pixels — what the editor needs for handles, snapping
 * and hit-testing. Rotation is deliberately ignored: the handles work on the unrotated box and
 * the whole frame is turned with it, which is what every editor does and what people expect.
 */
export function nodeRect(
  node: NodeBase,
  container: { w: number; h: number },
  measured?: { w: number; h: number }
): { x: number; y: number; w: number; h: number } {
  if (node.stretch) return { x: 0, y: 0, w: container.w, h: container.h }
  const a = anchorFractions(node.anchor)
  const o = anchorFractions(node.origin)
  const w = (node.w ?? measured?.w ?? 0) * node.scale
  const h = (node.h ?? measured?.h ?? 0) * node.scale
  return {
    x: a.fx * container.w + node.x - o.fx * w,
    y: a.fy * container.h + node.y - o.fy * h,
    w,
    h
  }
}

/** the inverse: where x/y must be for the element's box to land at `rect` */
export function offsetsForRect(
  node: NodeBase,
  rect: { x: number; y: number; w: number; h: number },
  container: { w: number; h: number }
): { x: number; y: number } {
  const a = anchorFractions(node.anchor)
  const o = anchorFractions(node.origin)
  return {
    x: rect.x + o.fx * rect.w - a.fx * container.w,
    y: rect.y + o.fy * rect.h - a.fy * container.h
  }
}

// ---------------------------------------------------------------------------
// compiling a scene for the overlay page
// ---------------------------------------------------------------------------

/**
 * One element, reduced to what the OBS page needs to draw it.
 *
 * The page is plain script served from the main process: it cannot import this module, and
 * copying the placement maths into it would guarantee the two drift apart the first time either
 * is touched. So the maths stays here and only the RESULT travels — a style object plus the few
 * runtime bits (which picture, which word, which field) that CSS cannot express.
 */
export interface CompiledNode {
  id: string
  kind: string
  css: Record<string, string | number | undefined>
  /** sits in the plate's normal flow and gives it its size */
  flow?: boolean
  hidden?: boolean
  image?: string
  bind?: string
  text?: string
  useChatColor?: boolean
  maxLines?: number
  word?: string
  anim?: string
  durationS?: number
  itemSize?: number
  gap?: number
  direction?: string
  shape?: string
  kinds?: string[]
}

export interface CompiledScene {
  scene: CompiledNode[]
  template: CompiledNode[]
}

function compileOne(node: OverlayNodeLike): CompiledNode {
  const css: Record<string, string | number | undefined> = {
    ...layoutCss(node as NodeBase)
  }
  if (node.kind === 'box' || node.kind === 'avatar') {
    Object.assign(css, boxStyleCss(node.style))
    if (node.shape === 'circle' || node.shape === 'ellipse') css.borderRadius = '50%'
  }
  if (node.kind === 'image' || node.kind === 'trigger') {
    Object.assign(css, boxStyleCss(node.style))
  }
  if (node.kind === 'text') {
    Object.assign(css, textStyleCss(node.style))
    // a text element's own plate: it grows with the words rather than being a box someone has to
    // keep resizing to match them
    if (node.box) Object.assign(css, boxStyleCss(node.box))
    if (node.padX || node.padY) css.padding = (node.padY ?? 0) + 'px ' + (node.padX ?? 0) + 'px'
  }
  // the flow element is what the plate sizes itself to, so it is NOT taken out of the flow
  if (node.flow) {
    css.position = 'relative'
    css.left = undefined
    css.top = undefined
  }
  return {
    id: node.id,
    kind: node.kind,
    css,
    flow: node.flow,
    hidden: node.hidden,
    image: node.image,
    bind: node.bind,
    text: node.text,
    useChatColor: node.useChatColor,
    maxLines: node.maxLines,
    word: node.word,
    anim: node.anim,
    durationS: node.durationS,
    itemSize: node.itemSize,
    gap: node.gap,
    direction: node.direction,
    shape: node.shape,
    kinds: node.kinds
  }
}

/** the loose shape compileOne reads — every optional field of every node kind */
type OverlayNodeLike = NodeBase & {
  kind: string
  box?: BoxStyle
  padX?: number
  padY?: number
  style?: BoxStyle & TextStyle
  image?: string
  bind?: string
  text?: string
  useChatColor?: boolean
  maxLines?: number
  word?: string
  anim?: string
  durationS?: number
  itemSize?: number
  gap?: number
  direction?: string
  shape?: string
  kinds?: string[]
}

export function compileScene(scene: { scene: unknown[]; template: unknown[] } | undefined): CompiledScene | undefined {
  if (!scene) return undefined
  return {
    scene: (scene.scene as OverlayNodeLike[]).map(compileOne),
    template: (scene.template as OverlayNodeLike[]).map(compileOne)
  }
}
