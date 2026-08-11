import { ChatOverlayConfig } from '../types'
import {
  Anchor9,
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
