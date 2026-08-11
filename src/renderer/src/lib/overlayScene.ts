/**
 * Overlay elements as DATA, so that adding something adjustable stops being a three-place change.
 *
 * The overlay we have today is one flat config: `avatarOffsetX`, `badgeOffsetY`, `nickRotate`,
 * `tsOffsetX` and about two hundred more named fields. Every new knob has to be added by hand in
 * three places — a field here, a form row in the editor (already 1827 lines), and a branch in the
 * page that draws it (another 1770). "Every plate, badge, trigger and decoration freely editable"
 * would mean hundreds of such knobs, and a second overlay type would mean doing all of it again.
 *
 * So elements become a list of nodes that all share one envelope: where it is, how big, how
 * turned, how transparent, what it is filled with. One renderer walks the list; one inspector
 * edits whatever is selected. A new property is written once and every element has it. A new
 * overlay type — alerts, goals, a counter — is new node kinds and a different root, with the same
 * editor and the same renderer.
 *
 * TWO SPACES, because the domain has two and pretending otherwise is what makes editors like this
 * collapse:
 *
 *   scene     the overlay screen. Decorations, trigger reactions, and later an alert box or a
 *             goal bar. One of each, positioned against the screen.
 *   template  the inside of ONE message plate, which is then repeated for every message. The
 *             nick, the badges, the avatar, the text. Positioned against the plate.
 *
 * A nick cannot be dragged to an absolute screen position — there are thirty of them on screen and
 * they move. Inside the template it can go anywhere.
 */

/** the nine handles of a box: corners, edge midpoints, centre */
export type Anchor9 =
  | 'tl'
  | 'top'
  | 'tr'
  | 'left'
  | 'center'
  | 'right'
  | 'bl'
  | 'bottom'
  | 'br'

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'

/** one colour stop of a gradient, `at` in 0..1 */
export interface FillStop {
  at: number
  color: string
}

/**
 * What fills a shape, a text or a plate.
 *
 * Solid and gradient are the same thing at different lengths, so they are one type rather than a
 * colour field plus a separate "use gradient" checkbox — the checkbox version is how you end up
 * with a colour that is ignored and nobody can tell why.
 */
export interface Fill {
  kind: 'none' | 'solid' | 'linear' | 'radial' | 'image'
  color?: string
  stops?: FillStop[]
  /** linear: degrees, 0 = to the right */
  angle?: number
  /** image fills: an asset reference or url */
  image?: string
  fit?: 'cover' | 'contain' | 'tile' | 'stretch'
  /** 0..1, multiplied with the node's own opacity */
  opacity?: number
}

export interface Stroke {
  width: number
  color: string
  /** draw inside the shape's box rather than on its edge */
  inset?: boolean
}

export interface Shadow {
  x: number
  y: number
  blur: number
  spread?: number
  color: string
  inset?: boolean
}

/** corner radii, clockwise from the top-left; a single number means all four */
export type Radius = number | [number, number, number, number]

export interface BoxStyle {
  fill?: Fill
  stroke?: Stroke
  radius?: Radius
  shadows?: Shadow[]
  /** backdrop blur in px — the "glass" look */
  backdrop?: number
}

export interface TextStyle {
  font?: string
  size?: number
  weight?: number
  italic?: boolean
  /** a plain colour is the common case; `fill` takes over for gradient text */
  color?: string
  fill?: Fill
  outline?: { width: number; color: string }
  shadows?: Shadow[]
  align?: 'left' | 'center' | 'right'
  letterSpacing?: number
  lineHeight?: number
  case?: 'none' | 'upper' | 'lower'
}

/**
 * The envelope every element shares.
 *
 * `anchor` and `origin` are what make free placement survive a box that changes size: `anchor`
 * says which point of the CONTAINER the coordinates are measured from, `origin` says which point
 * of the ELEMENT lands there. Pin a badge to the plate's right edge by its own right edge and it
 * stays put however long the message turns out to be — which is the difference between "free
 * placement" and "free placement that breaks on the next message".
 */
export interface NodeBase {
  id: string
  /** shown in the layer list; free text, defaults to the type's name */
  name: string
  hidden?: boolean
  locked?: boolean
  /** id of the containing group, if any */
  parent?: string

  x: number
  y: number
  anchor: Anchor9
  origin: Anchor9
  /** px; undefined means "as big as the content" */
  w?: number
  h?: number
  /** keep the width/height ratio while resizing */
  lockAspect?: boolean
  /** the ratio to keep, width / height; undefined = whatever it is when the lock is turned on */
  aspect?: number

  rotate: number
  /** multiplier applied after w/h, 1 = none */
  scale: number
  opacity: number
  blend?: BlendMode
}

export interface GroupNode extends NodeBase {
  kind: 'group'
  /** drawn as one unit: children clip to the group's box */
  clip?: boolean
}

/** a rectangle/ellipse — the plate, a bar, a divider, a colour block */
export interface BoxNode extends NodeBase {
  kind: 'box'
  shape: 'rect' | 'ellipse'
  style: BoxStyle
}

/** an uploaded picture: decoration, a frame, a logo */
export interface ImageNode extends NodeBase {
  kind: 'image'
  image: string
  fit?: 'cover' | 'contain' | 'stretch'
  style?: BoxStyle
}

/**
 * Text — either fixed words or a value taken from the message.
 *
 * One node type rather than separate nick/timestamp/message ones, because everything that differs
 * between them is which string to draw. They style identically and they move identically.
 */
export interface TextNode extends NodeBase {
  kind: 'text'
  /** 'static' draws `text`; the rest are filled in per message */
  bind: 'static' | 'nick' | 'message' | 'timestamp' | 'channel' | 'event'
  text?: string
  style: TextStyle
  /** nick only: use the chatter's own colour instead of `style.color` */
  useChatColor?: boolean
  /** how many lines before it clips; 0 = unlimited */
  maxLines?: number
}

/** the row of chat badges */
export interface BadgesNode extends NodeBase {
  kind: 'badges'
  /** which badge kinds to draw; empty = all of them */
  kinds: string[]
  /** px per badge */
  itemSize: number
  gap: number
  direction: 'row' | 'column'
  style?: BoxStyle
}

/** the chatter's profile picture */
export interface AvatarNode extends NodeBase {
  kind: 'avatar'
  shape: 'circle' | 'rect'
  style?: BoxStyle
}

/** a picture that appears when a message contains a word */
export interface TriggerNode extends NodeBase {
  kind: 'trigger'
  word: string
  image: string
  anim: 'pop' | 'bounce' | 'fade' | 'slide' | 'wiggle'
  /** seconds on screen; 0 = stays */
  durationS: number
  style?: BoxStyle
}

export type OverlayNode =
  | GroupNode
  | BoxNode
  | ImageNode
  | TextNode
  | BadgesNode
  | AvatarNode
  | TriggerNode

export type NodeKind = OverlayNode['kind']

/**
 * A whole overlay, as elements.
 *
 * `v` is here from the first day on purpose: this is user-authored content that has to survive
 * every future change to the model, and a version costs nothing now and is impossible to add
 * later without guessing.
 */
export interface OverlayScene {
  v: 1
  /** elements positioned against the screen, back to front */
  scene: OverlayNode[]
  /** elements inside one message plate, back to front */
  template: OverlayNode[]
}

export function emptyScene(): OverlayScene {
  return { v: 1, scene: [], template: [] }
}

let seq = 0
export function nodeId(kind: NodeKind): string {
  seq += 1
  return `${kind}-${Date.now().toString(36)}-${seq.toString(36)}`
}

/** the envelope a brand-new element starts with */
export function baseNode(kind: NodeKind, name: string): NodeBase {
  return {
    id: nodeId(kind),
    name,
    x: 0,
    y: 0,
    anchor: 'tl',
    origin: 'tl',
    rotate: 0,
    scale: 1,
    opacity: 1
  }
}

// ---------------------------------------------------------------------------
// list operations — the layer panel is just this list, so they live with it
// ---------------------------------------------------------------------------

export function findNode(scene: OverlayScene, id: string): OverlayNode | undefined {
  return scene.scene.find((n) => n.id === id) ?? scene.template.find((n) => n.id === id)
}

/** which of the two spaces holds `id` */
export function spaceOf(scene: OverlayScene, id: string): 'scene' | 'template' | null {
  if (scene.scene.some((n) => n.id === id)) return 'scene'
  if (scene.template.some((n) => n.id === id)) return 'template'
  return null
}

export function updateNode(
  scene: OverlayScene,
  id: string,
  patch: Partial<OverlayNode>
): OverlayScene {
  const apply = (list: OverlayNode[]): OverlayNode[] =>
    list.map((n) => (n.id === id ? ({ ...n, ...patch } as OverlayNode) : n))
  return { ...scene, scene: apply(scene.scene), template: apply(scene.template) }
}

export function addNode(
  scene: OverlayScene,
  space: 'scene' | 'template',
  node: OverlayNode
): OverlayScene {
  return { ...scene, [space]: [...scene[space], node] } as OverlayScene
}

export function removeNode(scene: OverlayScene, id: string): OverlayScene {
  // a group takes its children with it
  const kill = new Set([id])
  for (const n of [...scene.scene, ...scene.template]) {
    if (n.parent && kill.has(n.parent)) kill.add(n.id)
  }
  const strip = (list: OverlayNode[]): OverlayNode[] => list.filter((n) => !kill.has(n.id))
  return { ...scene, scene: strip(scene.scene), template: strip(scene.template) }
}

/**
 * Move an element up or down the stack.
 *
 * The list is stored back to front, so "bring forward" is a move towards the END. Saying it out
 * loud here because every reader of a layer panel expects the opposite at least once.
 */
export function reorderNode(
  scene: OverlayScene,
  space: 'scene' | 'template',
  id: string,
  toIndex: number
): OverlayScene {
  const list = [...scene[space]]
  const from = list.findIndex((n) => n.id === id)
  if (from === -1) return scene
  const [moved] = list.splice(from, 1)
  list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, moved)
  return { ...scene, [space]: list } as OverlayScene
}

export function duplicateNode(scene: OverlayScene, id: string): OverlayScene {
  const space = spaceOf(scene, id)
  const node = findNode(scene, id)
  if (!space || !node) return scene
  const copy = { ...node, id: nodeId(node.kind), name: `${node.name} 2`, x: node.x + 8, y: node.y + 8 }
  const list = [...scene[space]]
  list.splice(list.findIndex((n) => n.id === id) + 1, 0, copy as OverlayNode)
  return { ...scene, [space]: list } as OverlayScene
}
