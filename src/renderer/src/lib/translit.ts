/**
 * "Forgot to switch the layout" converter: remaps text typed on the wrong keyboard
 * layout between QWERTY and the Ukrainian ЙЦУКЕН layout (both directions).
 */
import { useSettingsStore } from '../store/settings'
import { useEmotesStore } from '../store/emotes'

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
  // punctuation-key shifts
  ['{', 'Х'],
  ['}', 'Ї'],
  [':', 'Ж'],
  ['"', 'Є'],
  ['<', 'Б'],
  ['>', 'Ю'],
  ['~', '₴'],
  // digit-row shifts that differ between the US and Ukrainian layouts
  ['@', '"'], // shift+2
  ['#', '№'], // shift+3
  ['$', ';'], // shift+4
  ['^', ':'], // shift+6
  ['&', '?'] // shift+7
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
  // …and so are EMOTE CODES. Converting "Kappa" into "Клзздф" turns a working emote into
  // gibberish, which is never what the layout fix is for. Covers Twitch, 7TV, BTTV and FFZ,
  // since they all live in the same lookup.
  const isEmote = emoteChecker()
  return text
    .split(/(\s+)/)
    .map((tok) =>
      /^\s+$/.test(tok) || exclude.has(tok.toLowerCase()) || isEmote(tok) ? tok : convert(tok, map)
    )
    .join('')
}

/**
 * "Is this word an emote?" across every open channel plus the global sets — the converter runs
 * on a field, not on a specific chat, so it can't know which channel the text is destined for.
 */
function emoteChecker(): (code: string) => boolean {
  const st = useEmotesStore.getState()
  return (code) => {
    if (!code) return false
    if (st.globalEmotes.has(code)) return true
    for (const map of Object.values(st.channelEmotes)) if (map.has(code)) return true
    for (const list of Object.values(st.twitchByAccount)) {
      if (list.some((e) => e.code === code)) return true
    }
    return false
  }
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
