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
  // Apple artwork (the set Telegram uses) — emoji-datasource files are named with the FULL
  // codepoint sequence incl. FE0F, which matches our join exactly (Twemoji 404'd on those)
  return `https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/${code}.png`
}

function buildList(): EmojiEntry[] {
  // Rendering is IMAGE-based (Apple set + Noto fallback), so every emoji in the data is
  // displayable — the old canvas "does the system font support it?" filter only hid
  // things (including every Unicode 16 emoji) and is gone.
  const out: EmojiEntry[] = []
  for (const g of emojiGroups as EmojiGroup[]) {
    // "component" = bare skin-tone / hair modifiers; they aren't standalone emoji
    if (g.slug === 'component') continue
    for (const e of g.emojis) {
      if (e.emoji === '🇷🇺') continue // substituted with 💩 (already in the list)
      out.push({ char: e.emoji, name: e.name, nameUk: ukNameOf(e.emoji) })
    }
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
