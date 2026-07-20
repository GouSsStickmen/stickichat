import emojiGroups from 'unicode-emoji-json/data-by-group.json'
import ukCompact from 'emojibase-data/uk/compact.json'

export interface EmojiEntry {
  char: string
  name: string
  nameUk: string
}

interface EmojiGroup {
  name: string
  slug: string
  emojis: { emoji: string; name: string }[]
}

interface UkEntry {
  unicode: string
  label?: string
}

// Ukrainian labels come keyed by the fully-qualified emoji; unicode-emoji-json uses the same
// base forms, but be tolerant about the FE0F variation selector when matching the two sets.
const stripVS = (s: string): string => s.replace(/️/g, '')
const ukNames = new Map<string, string>()
for (const e of ukCompact as UkEntry[]) {
  if (!e.label) continue
  ukNames.set(e.unicode, e.label)
  ukNames.set(stripVS(e.unicode), e.label)
}
const ukNameOf = (char: string): string => ukNames.get(char) ?? ukNames.get(stripVS(char)) ?? ''

/**
 * Not every emoji the Unicode standard defines exists in this Windows build's emoji font —
 * unsupported ones render as empty rectangles. Detect support by comparing the canvas
 * rendering against a known-missing glyph.
 */
function makeGlyphSupportTester(): (char: string) => boolean {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 24
    canvas.height = 24
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return () => true
    const render = (ch: string): string => {
      ctx.clearRect(0, 0, 24, 24)
      ctx.font = '18px "Segoe UI Emoji", "Segoe UI Symbol", sans-serif'
      ctx.fillText(ch, 0, 18)
      return canvas.toDataURL()
    }
    const missing = render('\u{10FFFE}') // guaranteed-unassigned code point → .notdef box
    return (char) => render(char) !== missing
  } catch {
    return () => true
  }
}

/**
 * Country flags are regional-indicator PAIRS: on systems without flag glyphs (Windows!)
 * they render as two letters instead of hitting .notdef, so the generic tester passes them.
 * Detect real support by width: a rendered flag is one glyph, letters are two.
 */
function flagsSupported(): boolean {
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.font = '18px "Segoe UI Emoji", "Segoe UI Symbol", sans-serif'
    const pair = ctx.measureText('🇺🇦').width
    const single = ctx.measureText('🇺').width
    return pair < single * 1.8
  } catch {
    return false
  }
}

const REGIONAL_PAIR_RE = /^[🇦-🇿]{2}$/u
const TAG_SEQ_RE = /[\u{E0020}-\u{E007F}]/u

const HAS_NATIVE_FLAGS = typeof document !== 'undefined' ? flagsSupported() : true

/**
 * Windows has no native flag glyphs — those emoji fall back to Twemoji images.
 * Returns the image URL when the char can't be rendered by the system font.
 */
/** user-requested substitutions applied wherever an emoji is displayed */
const EMOJI_SUBST: Record<string, string> = { '🇷🇺': '💩' }
export function displayEmoji(char: string): string {
  return EMOJI_SUBST[char] ?? char
}

export function emojiImageUrl(char: string): string | null {
  // EVERY emoji renders as a Twemoji image: the system font draws them at wildly different
  // widths/sizes (and breaks ZWJ people/activity sequences apart on Windows) — images give
  // one consistent look and exactly one cell everywhere. EmojiGlyph falls back to the
  // native glyph if the CDN can't serve a sequence.
  const code = [...char].map((c) => c.codePointAt(0)!.toString(16)).join('-')
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/${code}.png`
}

// The glyph-support scan (~2000 canvas renders) is expensive and identical in every
// window — cache the resulting list of supported chars so only the FIRST window pays.
const SUPPORT_CACHE_KEY = 'sticki:emojiSupported:v3'

function buildList(): EmojiEntry[] {
  let supported: Set<string> | null = null
  try {
    const raw = localStorage.getItem(SUPPORT_CACHE_KEY)
    if (raw) supported = new Set(JSON.parse(raw) as string[])
  } catch {
    /* rebuild below */
  }

  const out: EmojiEntry[] = []
  if (supported) {
    for (const g of emojiGroups as EmojiGroup[]) {
      for (const e of g.emojis) {
        if (!supported.has(e.emoji)) continue
        out.push({ char: e.emoji, name: e.name, nameUk: ukNameOf(e.emoji) })
      }
    }
    return out
  }

  const supports = makeGlyphSupportTester()
  for (const g of emojiGroups as EmojiGroup[]) {
    // "component" = bare skin-tone / hair modifiers; they render as dotted-box placeholders
    // and aren't standalone emoji — never list them
    if (g.slug === 'component') continue
    for (const e of g.emojis) {
      if (e.emoji === '🇷🇺') continue // substituted with 💩 (already in the list)
      const isFlagPair = REGIONAL_PAIR_RE.test(e.emoji)
      // subdivision/tag-sequence flags render broken without native support — drop those;
      // country flags are kept and rendered as Twemoji images instead
      if (!HAS_NATIVE_FLAGS && TAG_SEQ_RE.test(e.emoji)) continue
      if (!isFlagPair && !supports(e.emoji)) continue
      out.push({ char: e.emoji, name: e.name, nameUk: ukNameOf(e.emoji) })
    }
  }
  try {
    localStorage.setItem(SUPPORT_CACHE_KEY, JSON.stringify(out.map((e) => e.char)))
  } catch {
    /* best-effort */
  }
  return out
}

/** All emoji this system can actually render, with English + Ukrainian names. */
export const EMOJI_LIST: EmojiEntry[] = buildList()

const byChar = new Map(EMOJI_LIST.map((e) => [e.char, e]))

/** display label for an emoji according to the name-language setting */
export function emojiLabel(char: string, lang: 'uk' | 'en' | 'both'): string {
  const e = byChar.get(char)
  if (!e) return char
  const uk = e.nameUk || e.name
  if (lang === 'uk') return uk
  if (lang === 'en') return e.name
  return e.nameUk && e.nameUk !== e.name ? `${e.nameUk} · ${e.name}` : e.name
}

/** search text (matches BOTH languages regardless of the display setting) */
export function emojiSearchText(char: string): string {
  const e = byChar.get(char)
  return e ? `${e.name} ${e.nameUk}`.toLowerCase() : ''
}
