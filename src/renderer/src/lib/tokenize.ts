import { ChatMessage, Emote } from '../types'
import { useSettingsStore } from '../store/settings'

export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'emote'; emote: Emote; overlays: Emote[] }
  | { kind: 'link'; url: string; label: string }
  | { kind: 'mention'; name: string; color: string; bare?: boolean }
  | { kind: 'emoji'; char: string }
  /** a "!command" at the very start of the message — right-click inserts it into the input */
  | { kind: 'command'; text: string }
  /** a cheermote like "Cheer100" — bit icon + colored amount */
  | { kind: 'cheer'; url: string; bits: number; color: string }
  /** a GIPHY gif sent by a tier 2/3 subscriber; `label` is the placeholder text it replaces */
  | { kind: 'gif'; url: string; label: string }

// an emoji plus any variation selectors / ZWJ continuation (👨‍👩‍👧 etc.), or a country
// flag (two regional indicators — those are NOT Extended_Pictographic!)
const EMOJI_RE =
  /(?:[\u{1F1E6}-\u{1F1FF}]{2}|\p{Extended_Pictographic}\uFE0F?[\u{1F3FB}-\u{1F3FF}]?(?:\u200D\p{Extended_Pictographic}\uFE0F?[\u{1F3FB}-\u{1F3FF}]?)*)/gu

const URL_RE = /^https?:\/\/[^\s]+$/i
// bare links without a protocol: www.foo.bar, twitch.tv/xqc, sub.domain.co.ua/path?x=1 …
const BARE_URL_RE = /^(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#][^\s]*)?$/i

/** biggest available size of an emote image (hover previews, gigantified emotes) */
export function hiResEmoteUrl(u: string): string {
  if (u.includes('betterttv')) return u.replace(/\/2x$/, '/3x')
  return u
    .replace('/2.0', '/3.0') // twitch
    .replace(/\/2x(\.\w+)?$/, '/4x$1') // 7tv
    .replace(/\/2$/, '/4') // ffz
}

function twitchEmoteUrl(id: string): string {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`
}

interface Range {
  start: number
  end: number
  id: string
}

/** Twitch `emotes=` tag positions are measured in unicode code points */
function parseEmotesTag(tag: string): Range[] {
  const ranges: Range[] = []
  if (!tag) return ranges
  for (const group of tag.split('/')) {
    const colon = group.indexOf(':')
    if (colon === -1) continue
    const id = group.slice(0, colon)
    for (const r of group.slice(colon + 1).split(',')) {
      const [s, e] = r.split('-')
      const start = parseInt(s, 10)
      const end = parseInt(e, 10)
      if (!isNaN(start) && !isNaN(end)) ranges.push({ start, end, id })
    }
  }
  ranges.sort((a, b) => a.start - b.start)
  return ranges
}

/** "0-38|QbvMbYwhBqzvxzYRYI|https://media1.giphy.com/..." — range, giphy id, and the file */
function parseGifsTag(tag: string): { start: number; end: number; url: string } | null {
  if (!tag) return null
  const [range, , url] = tag.split('|')
  if (!range || !url || !/^https?:\/\//.test(url)) return null
  const [s, e] = range.split('-')
  const start = parseInt(s, 10)
  const end = parseInt(e, 10)
  if (isNaN(start) || isNaN(end)) return null
  return { start, end, url }
}

/**
 * Turns a message into render tokens: twitch emotes from the IRC tag,
 * third-party emotes by word lookup, links, mentions, zero-width overlays.
 */
export function tokenizeMessage(
  msg: Pick<ChatMessage, 'text' | 'emotesTag' | 'gifsTag'>,
  emoteLookup: (code: string) => Emote | undefined,
  mentionColorLookup?: (login: string) => string | undefined,
  dark = true,
  cheermoteLookup?: (word: string) => { bits: number; tier: { url: string; color: string } } | undefined,
  /** "is this word a real chatter here?" — enables coloring nicks typed without a leading @ */
  knownChatter?: (login: string) => boolean
): Token[] {
  const cp = Array.from(msg.text) // code points

  /*
   * A GIF replaces the whole message, so it is handled before anything else is looked at.
   *
   * Twitch sends it as a normal message whose text is a placeholder — "[Christmas Spongebob GIF by
   * Respective]" — plus a `gifs` tag holding "start-end|id|url", the same range convention the
   * emotes tag uses. One per message: the composer sends a GIF instead of a message, not inside one.
   */
  const gif = parseGifsTag(msg.gifsTag ?? '')
  if (gif) {
    const label = cp.slice(gif.start, Math.min(gif.end + 1, cp.length)).join('') || msg.text
    return [{ kind: 'gif', url: gif.url, label }]
  }

  const ranges = parseEmotesTag(msg.emotesTag ?? '')

  // slice the message into words/twitch-emote segments
  interface Seg {
    text: string
    twitchEmoteId?: string
  }
  const segs: Seg[] = []
  let pos = 0
  for (const r of ranges) {
    if (r.start > cp.length) break
    if (r.start > pos) segs.push({ text: cp.slice(pos, r.start).join('') })
    segs.push({ text: cp.slice(r.start, r.end + 1).join(''), twitchEmoteId: r.id })
    pos = r.end + 1
  }
  if (pos < cp.length) segs.push({ text: cp.slice(pos).join('') })
  if (segs.length === 0) segs.push({ text: msg.text })

  const tokens: Token[] = []
  const pushText = (t: string): void => {
    const last = tokens[tokens.length - 1]
    if (last?.kind === 'text') last.text += t
    else tokens.push({ kind: 'text', text: t })
  }
  const pushEmote = (emote: Emote): void => {
    // zero-width emotes stack onto the previous emote
    if (emote.zeroWidth) {
      for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i]
        if (t.kind === 'emote') {
          t.overlays.push(emote)
          return
        }
        if (t.kind === 'text' && t.text.trim() !== '') break
        if (t.kind !== 'text') break
      }
    }
    tokens.push({ kind: 'emote', emote, overlays: [] })
  }

  for (const seg of segs) {
    if (seg.twitchEmoteId) {
      pushEmote({
        code: seg.text,
        url: twitchEmoteUrl(seg.twitchEmoteId),
        provider: 'twitch'
      })
      continue
    }
    // split preserving whitespace
    for (const piece of seg.text.split(/(\s+)/)) {
      if (piece === '') continue
      if (/^\s+$/.test(piece)) {
        pushText(piece)
        continue
      }
      const emote = emoteLookup(piece)
      if (emote) {
        pushEmote(emote)
        continue
      }
      // cheermotes ("Cheer100", "Kappa50"…) render as a bit icon + colored amount
      const cheer = cheermoteLookup?.(piece)
      if (cheer) {
        tokens.push({ kind: 'cheer', url: cheer.tier.url, bits: cheer.bits, color: cheer.tier.color })
        continue
      }
      // a "!command" word anywhere in the message (incl. /me): right-click puts it into the input
      if (/^![^\s!]\S*$/.test(piece)) {
        tokens.push({ kind: 'command', text: piece })
        continue
      }
      // a real http(s):// link, even when glued to text ("текстhttps://x.com"): split off the
      // leading text and make the URL part clickable
      const embedded = /https?:\/\/\S+/i.exec(piece)
      if (embedded) {
        if (embedded.index > 0) pushText(piece.slice(0, embedded.index))
        tokens.push({ kind: 'link', url: embedded[0], label: embedded[0] })
        continue
      }
      // protocol-less domains (www.foo.bar) — only when NOT glued to other letters, since a
      // bare word with a dot is far too ambiguous
      const glued = /[Ѐ-ӿ]/.test(piece)
      if (BARE_URL_RE.test(piece) && !piece.includes('@') && !glued) {
        // open with https, but show the text exactly as the user typed it
        tokens.push({ kind: 'link', url: `https://${piece}`, label: piece })
        continue
      }
      if (piece.length > 1 && piece.startsWith('@')) {
        const login = piece.slice(1).replace(/[^\w]+$/, '').toLowerCase()
        const raw = (mentionColorLookup?.(login)) || fallbackColor(login)
        tokens.push({ kind: 'mention', name: piece, color: ensureReadable(raw, dark) })
        continue
      }
      // a nick typed WITHOUT the "@" still gets the user's color. Gated on the word actually
      // belonging to someone who has written in this channel, so ordinary words stay plain;
      // 3+ chars and not all-digits keeps short/numeric noise out.
      if (knownChatter && piece.length >= 3 && /^\w[\w]*[^\w]{0,2}$/.test(piece)) {
        const login = piece.replace(/[^\w]+$/, '').toLowerCase()
        if (login.length >= 3 && !/^\d+$/.test(login) && knownChatter(login)) {
          const raw = (mentionColorLookup?.(login)) || fallbackColor(login)
          tokens.push({ kind: 'mention', name: piece, color: ensureReadable(raw, dark), bare: true })
          continue
        }
      }
      // split out emoji so they get their own token (right-click → insert, like emotes)
      if (EMOJI_RE.test(piece)) {
        EMOJI_RE.lastIndex = 0
        let last = 0
        for (const m of piece.matchAll(EMOJI_RE)) {
          if (m.index! > last) pushText(piece.slice(last, m.index))
          tokens.push({ kind: 'emoji', char: m[0] })
          last = m.index! + m[0].length
        }
        if (last < piece.length) pushText(piece.slice(last))
        continue
      }
      pushText(piece)
    }
  }
  return tokens
}

/** default nickname colors for users without a set color (mirrors twitch palette) */
const DEFAULT_COLORS = [
  '#FF0000', '#0000FF', '#00FF00', '#B22222', '#FF7F50', '#9ACD32', '#FF4500',
  '#2E8B57', '#DAA520', '#D2691E', '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F'
]

export function fallbackColor(login: string): string {
  let h = 0
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0
  return DEFAULT_COLORS[h % DEFAULT_COLORS.length]
}

/**
 * Nudges a nick color so it stays readable against the current theme, keeping its hue.
 * Too-dark colors on the dark theme (down to pure black) blend toward white; too-light
 * colors on the light theme (up to pure white) blend toward black — proportionally, so a
 * barely-dark color barely moves while pure black lifts to a clearly-visible grey.
 */
export function ensureReadable(color: string, dark: boolean): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color)
  if (!m) return color
  const n = parseInt(m[1], 16)
  let r = (n >> 16) & 0xff
  let g = (n >> 8) & 0xff
  let b = n & 0xff
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (dark && lum < 90) {
    // 0 lum (black) → 0.78 toward white; 90 lum → no change
    const amt = ((90 - lum) / 90) * 0.78
    r = Math.round(r + (255 - r) * amt)
    g = Math.round(g + (255 - g) * amt)
    b = Math.round(b + (255 - b) * amt)
    return `rgb(${r},${g},${b})`
  }
  if (!dark && lum > 190) {
    // 255 lum (white) → 0.72 toward black; 190 lum → no change
    const amt = ((lum - 190) / 65) * 0.72
    r = Math.round(r * (1 - amt))
    g = Math.round(g * (1 - amt))
    b = Math.round(b * (1 - amt))
    return `rgb(${r},${g},${b})`
  }
  return color
}

export function hexToRgba(hex: string, opacity: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${Math.max(0, Math.min(1, opacity))})`
}

/**
 * Exact, localized duration. The old version rounded to a single unit, so a 90s timeout read
 * as "2m" and 1h30m read as "2h" — plain wrong for a moderation line the streamer reads to
 * know how long someone is muted. Now every non-zero unit is kept, largest two shown.
 */
export function formatDuration(seconds: number): string {
  const secs = Math.max(0, Math.round(seconds))
  const lang = useSettingsStore.getState().settings.language
  const u = lang === 'uk' ? { d: 'д', h: 'год', m: 'хв', s: 'с' } : { d: 'd', h: 'h', m: 'm', s: 's' }
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const sec = secs % 60
  const parts: string[] = []
  if (d) parts.push(`${d}${u.d}`)
  if (h) parts.push(`${h}${u.h}`)
  if (m) parts.push(`${m}${u.m}`)
  if (sec || !parts.length) parts.push(`${sec}${u.s}`)
  // two units is enough precision to be useful without turning into "1д 2год 3хв 4с"
  return parts.slice(0, 2).join(' ')
}
