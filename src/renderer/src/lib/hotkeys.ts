import { DEFAULT_HOTKEYS, HotkeyAction, Settings } from '../types'

/** effective accelerator for an action: user override or the built-in default */
export function hotkeyFor(settings: Settings, action: HotkeyAction): string {
  return settings.hotkeys[action] || DEFAULT_HOTKEYS[action]
}

/**
 * Builds an accelerator string ("Ctrl+Shift+T", "F5", "Ctrl+Enter") from a keydown event.
 * Uses the PHYSICAL key (e.code) for letters/digits so it works on the Ukrainian layout.
 * Returns null for modifier-only presses.
 */
export function eventToAccel(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  const code = e.code
  let key: string | null = null
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code
  else if (code === 'Enter' || code === 'NumpadEnter') key = 'Enter'
  else if (code === 'Space') key = 'Space'
  else if (code === 'Backspace') key = 'Backspace'
  else if (code === 'Delete') key = 'Delete'
  else if (code === 'Tab') key = 'Tab'
  else if (/^Arrow(Up|Down|Left|Right)$/.test(code)) key = code.slice(5)
  else if (code === 'Home' || code === 'End' || code === 'PageUp' || code === 'PageDown') key = code
  else if (/^(Backquote|Minus|Equal|Bracket|Semicolon|Quote|Comma|Period|Slash|Backslash)/.test(code))
    key = code
  if (!key) return null
  parts.push(key)
  return parts.join('+')
}

/** true when the keydown event matches the accelerator string */
export function matchHotkey(e: KeyboardEvent | React.KeyboardEvent, accel: string): boolean {
  if (!accel) return false
  return eventToAccel(e) === accel
}

/**
 * For hold-style hotkeys (press-and-hold to pause). Handles bare modifier accelerators
 * ("Alt", "Ctrl", "Shift") — which `eventToAccel` returns null for — by matching the
 * modifier key itself, so keydown/keyup on the modifier register. Falls back to matchHotkey.
 */
const BARE_MOD: Record<string, string> = { Alt: 'Alt', Ctrl: 'Control', Shift: 'Shift' }
export function matchHoldKey(e: KeyboardEvent, accel: string): boolean {
  if (!accel) return false
  if (BARE_MOD[accel]) return e.key === BARE_MOD[accel]
  return matchHotkey(e, accel)
}
