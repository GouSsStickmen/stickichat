/**
 * Matching for the keyword and nick-spelling alert lists.
 *
 * Two modes, because both readings are legitimate. Loose (substring) catches every inflection
 * of a stem, which is what you want from "стікмен" in a language that declines everything.
 * Strict (whole word) is what you want from a short handle, where the loose reading fires on
 * "стікменсва" and on any longer word that happens to contain it.
 *
 * `\b` is unusable here: even with the `u` flag its word character is [A-Za-z0-9_], so a
 * Cyrillic needle has a boundary on every side and the assertion means nothing. The boundary
 * is spelled out against Unicode letters and digits instead.
 */

const WORD_CHAR = String.raw`[\p{L}\p{N}_]`
const isWordChar = /[\p{L}\p{N}_]/u

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** compiled whole-word patterns, keyed by needle — a regex per message per word is wasteful */
const cache = new Map<string, RegExp>()

function wholeWordRe(needle: string): RegExp {
  let re = cache.get(needle)
  if (!re) {
    // A boundary is only asserted at an end where the needle itself has a letter or digit.
    // "!drop" delimits itself on the left, and demanding a non-word character before "!"
    // would be asking the message to separate something that is already separate; the same
    // on the right for "c++", which must still match in "c++код". Lookarounds rather than a
    // captured boundary so overlapping candidates are not swallowed.
    const head = isWordChar.test(needle[0]) ? `(?<!${WORD_CHAR})` : ''
    const tail = isWordChar.test(needle[needle.length - 1]) ? `(?!${WORD_CHAR})` : ''
    re = new RegExp(`${head}${escapeRe(needle)}${tail}`, 'iu')
    if (cache.size > 500) cache.clear()
    cache.set(needle, re)
  }
  return re
}

/** does `text` contain `needle`, under the chosen mode? `needle` is matched case-insensitively */
export function matchesTerm(text: string, needle: string, wholeWord: boolean): boolean {
  const w = needle.trim()
  if (!w) return false
  if (!wholeWord) return text.toLowerCase().includes(w.toLowerCase())
  return wholeWordRe(w).test(text)
}

/** the first entry of `list` that `text` matches, or undefined */
export function findTerm(text: string, list: string[], wholeWord: boolean): string | undefined {
  return list.find((w) => matchesTerm(text, w, wholeWord))
}
