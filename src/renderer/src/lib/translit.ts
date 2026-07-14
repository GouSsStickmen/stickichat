/**
 * "Forgot to switch the layout" converter: remaps text typed on the wrong keyboard
 * layout between QWERTY and the Ukrainian ЙЦУКЕН layout (both directions).
 */
import { useSettingsStore } from '../store/settings'

// letter keys only (both cases handled below). Punctuation lives in the pair tables so it
// isn't wrongly upper-cased — "[".toUpperCase() === "[", which used to clobber "["→х into "["→Х.
const LAT_LETTERS = 'qwertyuiopasdfghjklzxcvbnm'
const UKR_LETTERS = 'йцукенгшщзфівапролдячсмить'

// unshifted punctuation keys: Latin (QWERTY) → Ukrainian (ЙЦУКЕН)
const PUNCT: [string, string][] = [
  ['[', 'х'],
  [']', 'ї'],
  [';', 'ж'],
  ["'", 'є'],
  [',', 'б'],
  ['.', 'ю'],
  ['/', '.'],
  ['`', "'"] // key left of "1": apostrophe on the Ukrainian layout, not ґ
]

// shifted keys: Latin (shift+…) → Ukrainian (shift+…)
const SHIFTED: [string, string][] = [
  ['{', 'Х'],
  ['}', 'Ї'],
  [':', 'Ж'],
  ['"', 'Є'],
  ['<', 'Б'],
  ['>', 'Ю'],
  ['?', ','],
  ['~', '₴'],
  // Ukrainian digit-row shifted symbols
  ['@', '"'],
  ['#', '№']
]

const latToUkr = new Map<string, string>()
const ukrToLat = new Map<string, string>()
for (let i = 0; i < LAT_LETTERS.length; i++) {
  const l = LAT_LETTERS[i]
  const u = UKR_LETTERS[i]
  latToUkr.set(l, u)
  ukrToLat.set(u, l)
  latToUkr.set(l.toUpperCase(), u.toUpperCase())
  ukrToLat.set(u.toUpperCase(), l.toUpperCase())
}
for (const [l, u] of [...PUNCT, ...SHIFTED]) {
  latToUkr.set(l, u)
  ukrToLat.set(u, l)
}

function convert(text: string, map: Map<string, string>): string {
  let out = ''
  for (const ch of text) out += map.get(ch) ?? ch
  return out
}

/** Swaps the text to the other layout, picking the direction by which alphabet dominates. */
export function swapLayout(text: string): string {
  let lat = 0
  let cyr = 0
  for (const ch of text) {
    if (/[a-z]/i.test(ch)) lat++
    else if (/[а-щьюяіїєґ]/i.test(ch)) cyr++
  }
  const map = cyr > lat ? ukrToLat : latToUkr
  // words on the exclude list (chat commands like "!followage") are left untouched, so a
  // whole-field swap doesn't mangle them
  const exclude = new Set(
    useSettingsStore.getState().settings.translitExcludeWords.map((w) => w.toLowerCase())
  )
  return text
    .split(/(\s+)/)
    .map((tok) => (/^\s+$/.test(tok) || exclude.has(tok.toLowerCase()) ? tok : convert(tok, map)))
    .join('')
}

/**
 * Converts the currently focused input/textarea in place (selection only, if any),
 * dispatching a native input event so React-controlled fields pick the change up.
 * Returns false when nothing editable is focused.
 */
export function swapLayoutInFocusedField(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false
  const { value, selectionStart, selectionEnd } = el
  const hasSelection =
    selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart
  const next = hasSelection
    ? value.slice(0, selectionStart!) + swapLayout(value.slice(selectionStart!, selectionEnd!)) + value.slice(selectionEnd!)
    : swapLayout(value)
  if (next === value) return true
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, next)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  if (hasSelection) el.setSelectionRange(selectionStart!, selectionEnd!)
  return true
}
