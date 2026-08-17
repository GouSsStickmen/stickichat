import {
  DEFAULT_CHAT_OVERLAY,
  DEFAULT_EMOTE_OVERLAY,
  DEFAULT_FOLLOW_OVERLAY,
  DEFAULT_GOAL_OVERLAY,
  OverlayConfig
} from '../types'
import { nextId } from '../store/layout'

/**
 * Portable import/export of overlays so streamers can share their hand-built designs.
 * A single overlay or a whole set serialises to JSON with an app marker; importing merges
 * each entry over the CURRENT defaults for its kind (so an older export still gains any newer
 * fields) and assigns a fresh id to avoid collisions with existing overlays.
 */
const MARK = 'stickichat-overlay'
const VERSION = 1

export function exportOverlayJson(overlays: OverlayConfig | OverlayConfig[]): string {
  const list = Array.isArray(overlays) ? overlays : [overlays]
  return JSON.stringify({ _app: MARK, _version: VERSION, overlays: list }, null, 2)
}

/** the defaults an imported overlay is merged over; an export from before there were kinds has
 *  no `type` at all, and back then everything was a chat overlay */
function defaultsFor(type: unknown): Omit<OverlayConfig, 'id' | 'name'> {
  if (type === 'emotes') return DEFAULT_EMOTE_OVERLAY
  if (type === 'goal') return DEFAULT_GOAL_OVERLAY
  if (type === 'follow') return DEFAULT_FOLLOW_OVERLAY
  return DEFAULT_CHAT_OVERLAY
}

/** Parse an exported overlay file. Returns fresh, id-reassigned overlays, or null when the
 *  text isn't a StickiChat overlay export. */
export function parseOverlayImport(text: string): OverlayConfig[] | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const d = data as { _app?: string; overlays?: unknown; overlay?: unknown }
  if (!d || d._app !== MARK) return null
  const raw = Array.isArray(d.overlays) ? d.overlays : d.overlay ? [d.overlay] : []
  const out: OverlayConfig[] = []
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue
    const src = o as Partial<OverlayConfig>
    out.push({
      ...defaultsFor(src.type),
      ...src,
      id: nextId('ov'),
      name: src.name || 'Overlay'
    } as OverlayConfig)
  }
  return out.length ? out : null
}
