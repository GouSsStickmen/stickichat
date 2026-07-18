import { ChatOverlayConfig, DEFAULT_CHAT_OVERLAY } from '../types'
import { nextId } from '../store/layout'

/**
 * Portable import/export of chat overlays so streamers can share their hand-built designs.
 * A single overlay or a whole set serialises to JSON with an app marker; importing merges
 * each entry over the CURRENT defaults (so an older export still gains any newer fields)
 * and assigns a fresh id to avoid collisions with existing overlays.
 */
const MARK = 'stickichat-overlay'
const VERSION = 1

export function exportOverlayJson(overlays: ChatOverlayConfig | ChatOverlayConfig[]): string {
  const list = Array.isArray(overlays) ? overlays : [overlays]
  return JSON.stringify({ _app: MARK, _version: VERSION, overlays: list }, null, 2)
}

/** Parse an exported overlay file. Returns fresh, id-reassigned overlays, or null when the
 *  text isn't a StickiChat overlay export. */
export function parseOverlayImport(text: string): ChatOverlayConfig[] | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const d = data as { _app?: string; overlays?: unknown; overlay?: unknown }
  if (!d || d._app !== MARK) return null
  const raw = Array.isArray(d.overlays) ? d.overlays : d.overlay ? [d.overlay] : []
  const out: ChatOverlayConfig[] = []
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue
    const src = o as Partial<ChatOverlayConfig>
    out.push({
      ...DEFAULT_CHAT_OVERLAY,
      ...src,
      id: nextId('ov'),
      type: 'chat',
      name: src.name || 'Overlay'
    })
  }
  return out.length ? out : null
}
