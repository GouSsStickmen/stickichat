import { ChatOverlayConfig } from '../types'
import {
  Anchor9,
  Fill,
  ImageNode,
  OverlayNode,
  OverlayScene,
  TriggerNode,
  baseNode,
  emptyScene
} from './overlayScene'

/**
 * Build a starting scene out of an overlay the user already has.
 *
 * The beta must never open on a blank page. Someone who has spent an evening placing decorations
 * and trigger reactions should switch it on and find exactly what they had — then discover they
 * can now rotate it, tint it, and put it behind something. An empty canvas would read as "your
 * work is gone", and nobody would turn it on twice.
 *
 * Only decorations and triggers are converted here. They are already lists of things with a
 * position and a size, so the mapping is honest and one-to-one. The message plate's own parts —
 * nick, badges, avatar, text — are still fixed slots in the flat config with offsets bolted on;
 * they come across in the next step, when the template renderer exists to draw them.
 */

/** the six anchors decorations use map straight onto the nine-point grid */
function decorAnchor(a: string): Anchor9 {
  switch (a) {
    case 'tl':
    case 'tr':
    case 'bl':
    case 'br':
    case 'top':
    case 'bottom':
      return a
    default:
      return 'tl'
  }
}

function triggerAnchor(p: string): Anchor9 {
  switch (p) {
    case 'tl':
    case 'top':
    case 'tr':
    case 'left':
    case 'right':
    case 'bl':
    case 'bottom':
    case 'br':
      return p
    default:
      return 'center'
  }
}

export function sceneFromConfig(cfg: ChatOverlayConfig): OverlayScene {
  const out = emptyScene()
  // the message parts first, so the plate and the text are already there when decorations land
  out.template.push(...templateFromConfig(cfg))

  for (const d of cfg.decors ?? []) {
    const node: ImageNode = {
      ...baseNode('image', 'Декор'),
      kind: 'image',
      image: d.image,
      fit: 'contain',
      // it hugged its corner before and it still does: the element's own matching corner sits on
      // the container's, so the offsets keep meaning what they meant
      anchor: decorAnchor(d.anchor),
      origin: decorAnchor(d.anchor),
      x: d.dx,
      y: d.dy,
      w: d.size,
      lockAspect: true,
      opacity: d.opacity
    }
    const space = d.scope === 'zone' ? 'scene' : 'template'
    // `above` was a boolean because there were only two places to be. In a stack it is an
    // ordering: everything that used to sit behind goes in first
    if (d.above) out[space].push(node)
    else out[space].unshift(node)
  }

  for (const t of cfg.triggers ?? []) {
    const node: TriggerNode = {
      ...baseNode('trigger', t.word || 'Тригер'),
      kind: 'trigger',
      on: t.on,
      word: t.word,
      image: t.image,
      anim: t.anim,
      durationS: t.durationS,
      anchor: triggerAnchor(t.pos),
      origin: triggerAnchor(t.pos),
      x: t.dx,
      y: t.dy,
      w: t.size,
      lockAspect: true
    }
    out[t.attach === 'message' ? 'template' : 'scene'].push(node as OverlayNode)
  }

  return out
}

/** has anything been placed yet — used to decide whether opening the beta needs a conversion */
export function sceneIsEmpty(scene: OverlayScene | undefined): boolean {
  return !scene || (scene.scene.length === 0 && scene.template.length === 0)
}

/**
 * Build the message TEMPLATE out of the overlay's existing settings.
 *
 * This is the part that decides whether the beta is useful or a curiosity. Without it the editor
 * only ever adds NEW things, while the nick, the plate, the badges and the message — everything
 * anyone actually wants to move — stay locked behind the classic form. The first reaction to that
 * is the correct one: "what I set up here lives separately from what I already have."
 *
 * So the template starts as the overlay itself, converted: the same plate, the same avatar, the
 * same badges, the same nick and text, at the sizes and colours already chosen. From there every
 * one of them is a normal element — drag it, turn it, restyle it, put a plate behind just the
 * nick, hide the timestamp. Nothing is invented and nothing is lost.
 *
 * The message text is the FLOW element: it is what the plate sizes itself to. Everything else is
 * pinned around whatever size that turns out to be, which is what "the plate hugs the message"
 * has always meant here.
 */
export function templateFromConfig(cfg: ChatOverlayConfig): OverlayNode[] {
  const out: OverlayNode[] = []
  const fontSize = cfg.fontSize ?? 16

  // the plate itself, behind everything, sized by the flow element above it
  if (cfg.plateMode && cfg.plateMode !== 'none') {
    out.push({
      ...baseNode('box', 'Плашка'),
      kind: 'box',
      shape: 'rect',
      // as big as the message turned out to be — see NodeBase.stretch
      stretch: true,
      anchor: 'tl',
      origin: 'tl',
      x: 0,
      y: 0,
      style: {
        fill: fillFromOverlay(cfg.plateBg),
        radius: cfg.plateRadius ?? 8
      }
    } as OverlayNode)
  }

  if (cfg.avatarShow) {
    out.push({
      ...baseNode('avatar', 'Аватар'),
      kind: 'avatar',
      shape: (cfg.avatarRadius ?? 50) >= 50 ? 'circle' : 'rect',
      anchor: cfg.avatarPos === 'right' ? 'tr' : 'tl',
      origin: cfg.avatarPos === 'right' ? 'tr' : 'tl',
      x: cfg.avatarOffsetX ?? 0,
      y: cfg.avatarOffsetY ?? 0,
      w: cfg.avatarSize ?? 32,
      h: cfg.avatarSize ?? 32,
      lockAspect: true
    } as OverlayNode)
  }

  if (cfg.badgesShow) {
    out.push({
      ...baseNode('badges', 'Бейджі'),
      kind: 'badges',
      kinds: cfg.badgeKinds ?? [],
      itemSize: cfg.badgeSize ?? 18,
      gap: 3,
      direction: 'row',
      anchor: 'tl',
      origin: 'tl',
      x: cfg.badgeOffsetX ?? 0,
      y: cfg.badgeOffsetY ?? 0
    } as OverlayNode)
  }

  out.push({
    ...baseNode('text', 'Нік'),
    kind: 'text',
    bind: 'nick',
    // the chatter's own colour unless the overlay was told to use a fixed one
    useChatColor: cfg.nickColorMode !== 'fixed',
    anchor: 'tl',
    origin: 'tl',
    x: 0,
    y: 0,
    rotate: cfg.nickRotate ?? 0,
    // the nick's own plate already existed as nickBg* — it comes across as this element's box,
    // so it keeps hugging the name instead of becoming a rectangle somebody has to resize by hand
    box: cfg.nickBgEnabled ? { fill: fillFromOverlay(cfg.nickBg), radius: cfg.nickBgRadius ?? 0 } : undefined,
    padX: cfg.nickPadX,
    padY: cfg.nickPadY,
    style: {
      size: Math.round((fontSize * (cfg.nickScale ?? 100)) / 100),
      weight: cfg.nickBold ? 700 : 400,
      italic: cfg.nickItalic,
      color: cfg.nickColorMode === 'fixed' ? cfg.nickFixedColor : undefined,
      case: cfg.nickTransform === 'upper' ? 'upper' : cfg.nickTransform === 'lower' ? 'lower' : 'none'
    }
  } as OverlayNode)

  if (cfg.tsShow) {
    out.push({
      ...baseNode('text', 'Час'),
      kind: 'text',
      bind: 'timestamp',
      anchor: 'tr',
      origin: 'tr',
      x: cfg.tsOffsetX ?? 0,
      y: cfg.tsOffsetY ?? 0,
      style: { size: Math.round(fontSize * 0.8), color: cfg.tsColor }
    } as OverlayNode)
  }

  // last, and the one that grows
  out.push({
    ...baseNode('text', 'Текст повідомлення'),
    kind: 'text',
    bind: 'message',
    flow: true,
    anchor: 'tl',
    origin: 'tl',
    x: cfg.textOffsetX ?? 0,
    y: cfg.textOffsetY ?? 0,
    style: {
      size: fontSize,
      color: cfg.textColor,
      align: cfg.msgAlign ?? 'left'
    }
  } as OverlayNode)

  return out
}

/** the classic OverlayFill shape into the element model's Fill */
function fillFromOverlay(f: ChatOverlayConfig['plateBg'] | undefined): Fill | undefined {
  if (!f) return undefined
  const any = f as unknown as Record<string, unknown>
  const kind = String(any.kind ?? 'solid')
  if (kind === 'none') return { kind: 'none' }
  if (kind === 'gradient' || kind === 'linear') {
    return {
      kind: 'linear',
      angle: Number(any.angle ?? 90),
      stops: [
        { at: 0, color: String(any.color ?? '#000000') },
        { at: 1, color: String(any.color2 ?? any.color ?? '#000000') }
      ]
    }
  }
  if (kind === 'image') return { kind: 'image', image: String(any.image ?? ''), fit: 'cover' }
  return { kind: 'solid', color: String(any.color ?? '#000000cc') }
}
