/**
 * "Forgot to switch the layout" converter: remaps text typed on the wrong keyboard
 * layout between QWERTY and the Ukrainian ЙЦУКЕН layout (both directions).
 */

const LAT = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`"
const UKR = 'йцукенгшщзхїфівапролджєячсмитьбю.ґ'

// shifted symbol pairs that differ between the layouts (digits row etc.)
const LAT_SYM = '@#$^&?'
const UKR_SYM = '"№;:?,'

const latToUkr = new Map<string, string>()
const ukrToLat = new Map<string, string>()
for (let i = 0; i < LAT.length; i++) {
  latToUkr.set(LAT[i], UKR[i])
  ukrToLat.set(UKR[i], LAT[i])
  latToUkr.set(LAT[i].toUpperCase(), UKR[i].toUpperCase())
  ukrToLat.set(UKR[i].toUpperCase(), LAT[i].toUpperCase())
}
for (let i = 0; i < LAT_SYM.length; i++) {
  latToUkr.set(LAT_SYM[i], UKR_SYM[i])
  ukrToLat.set(UKR_SYM[i], LAT_SYM[i])
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
  return cyr > lat ? convert(text, ukrToLat) : convert(text, latToUkr)
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
