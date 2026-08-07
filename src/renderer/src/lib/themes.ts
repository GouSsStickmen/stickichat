/**
 * Themes as data.
 *
 * A theme used to be a `'dark' | 'light'` union plus a matching CSS block, which meant every
 * new theme was a code change in three places and a user could never make one. Here a theme is
 * just a name and a bag of token values; `applyTheme` writes them onto the document root, so
 * the exact same code path serves the built-ins and anything a user assembles later.
 *
 * Adding a theme = one entry in THEMES. Tokens left out fall back to `dark`, so a theme only
 * has to state what it actually changes.
 */

import { useSettingsStore } from '../store/settings'
import type { TabColors } from '../types'

export interface Theme {
  id: string
  /** shown in the picker; proper names stay untranslated, dark/light go through i18n */
  name: string
  /**
   * Is this a dark theme? Not cosmetic — nick colours are contrast-corrected against the
   * background (`ensureReadable`), so this decides whether they get lightened or darkened.
   */
  dark: boolean
  tokens: Record<string, string>
  /**
   * Corner roundness as a percentage of the design scale. Part of the THEME, not a global
   * setting: roundness is as much a theme's identity as its palette, and a global one would
   * mean a soft theme and a sharp theme could never coexist.
   */
  radius?: number
  /** the tab strip's own palette; anything omitted falls back to the theme's surfaces */
  tabColors?: Partial<TabColors>
}

/** every token a theme may set; also the fallback layer for partial themes */
const DARK: Record<string, string> = {
  '--bg': '#0e0e10',
  '--surface': '#18181b',
  '--surface-2': '#1f1f23',
  '--surface-3': '#26262c',
  '--border': '#303036',
  '--text': '#efeff1',
  '--text-muted': '#adadb8',
  '--text-faint': '#77777f',
  '--accent': '#a970ff',
  '--accent-strong': '#9147ff',
  '--accent-text': '#ffffff',
  '--danger': '#eb4c4c',
  '--live': '#e91916',
  '--success': '#45c26f',
  '--warning': '#f5b83d',
  '--highlight-bg': 'rgba(255, 92, 92, 0.12)',
  '--system-text': '#adadb8',
  '--link': '#8ab4f8',
  '--scrollbar': '#3a3a41',
  '--msg-separator': '#303036',
  '--shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.35)',
  '--shadow-md': '0 4px 14px rgba(0, 0, 0, 0.4)',
  '--shadow': '0 8px 30px rgba(0, 0, 0, 0.55)',
  '--shadow-lg': '0 12px 40px rgba(0, 0, 0, 0.55)',
  '--scrim': 'rgba(0, 0, 0, 0.42)',
  '--checker-a': '#33333b',
  '--checker-b': '#1c1c20'
}

/** the token names a theme is allowed to define — used to validate imported themes */
export const THEME_TOKENS = Object.keys(DARK)

// --mention-bg is deliberately absent from every theme: the user picks that colour and its
// opacity in settings, and App writes it after the theme so their choice always wins.

export const THEMES: Theme[] = [
  { id: 'dark', name: 'Dark', dark: true, tokens: DARK },
  {
    id: 'light',
    name: 'Light',
    dark: false,
    tokens: {
      '--bg': '#f7f7f8',
      '--surface': '#ffffff',
      '--surface-2': '#f2f2f3',
      '--surface-3': '#e8e8ea',
      '--border': '#d8d8dc',
      '--text': '#0e0e10',
      '--text-muted': '#53535f',
      '--text-faint': '#6f6f7c',
      '--accent': '#9147ff',
      '--accent-strong': '#772ce8',
      '--danger': '#d43a3a',
      '--success': '#1a9648',
      '--warning': '#c98a12',
      '--highlight-bg': 'rgba(255, 92, 92, 0.14)',
      '--system-text': '#53535f',
      '--link': '#1a6dcc',
      '--scrollbar': '#c5c5cc',
      '--msg-separator': '#d8d8dc',
      // a light surface needs a much softer shadow or everything looks bruised
      '--shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.1)',
      '--shadow-md': '0 4px 14px rgba(0, 0, 0, 0.12)',
      '--shadow': '0 8px 30px rgba(0, 0, 0, 0.18)',
      '--shadow-lg': '0 12px 40px rgba(0, 0, 0, 0.2)',
      // a light UI needs far less dimming before the dialog reads as "on top"
      '--scrim': 'rgba(0, 0, 0, 0.2)',
      '--checker-a': '#c9c9d2',
      '--checker-b': '#eeeef2'
    }
  },
  {
    id: 'amoled',
    name: 'AMOLED',
    dark: true,
    tokens: {
      // true black: on an OLED panel these pixels are switched off, which is the point
      '--bg': '#000000',
      '--surface': '#0a0a0c',
      '--surface-2': '#121215',
      '--surface-3': '#1a1a1f',
      '--border': '#26262b',
      '--text': '#f2f2f4',
      '--scrollbar': '#2e2e34',
      '--msg-separator': '#26262b',
      '--checker-a': '#232329',
      '--checker-b': '#0c0c0f'
    }
  },
  {
    id: 'midnight',
    name: 'Midnight',
    dark: true,
    tokens: {
      '--bg': '#0d1117',
      '--surface': '#141b24',
      '--surface-2': '#1a2330',
      '--surface-3': '#22303f',
      '--border': '#2b3a4a',
      '--text': '#e6edf3',
      '--text-muted': '#9fb0c0',
      '--text-faint': '#6b7d8e',
      '--accent': '#58a6ff',
      '--accent-strong': '#3b82f6',
      '--link': '#79c0ff',
      '--success': '#3fb950',
      '--warning': '#d29922',
      '--danger': '#f85149',
      '--scrollbar': '#31404f',
      '--checker-a': '#2a3b4e',
      '--checker-b': '#161d27'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    dark: true,
    tokens: {
      '--bg': '#191d24',
      '--surface': '#22272f',
      '--surface-2': '#2e3440',
      '--surface-3': '#3b4252',
      '--border': '#434c5e',
      '--text': '#f0f4fa',
      '--text-muted': '#cdd6e3',
      '--text-faint': '#94a2b5',
      '--accent': '#8fd0e0',
      '--accent-strong': '#5e81ac',
      '--accent-text': '#161a20',
      '--link': '#96c8c6',
      '--success': '#a3be8c',
      '--warning': '#ebcb8b',
      '--danger': '#bf616a',
      '--highlight-bg': 'rgba(191, 97, 106, 0.16)',
      '--scrollbar': '#434c5e',
      // tinted with the palette's own deep tone: neutral black greys a mid-tone theme out
      '--scrim': 'rgba(12, 15, 19, 0.42)',
      '--checker-a': '#3b4252',
      '--checker-b': '#252a33'
    }
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    dark: true,
    tokens: {
      '--bg': '#121414',
      '--surface': '#1d2021',
      '--surface-2': '#282828',
      '--surface-3': '#32302f',
      '--border': '#453f3b',
      '--text': '#f6e8c8',
      '--text-muted': '#cdbe9f',
      '--text-faint': '#a3937f',
      '--accent': '#fabd2f',
      '--accent-strong': '#d79921',
      '--accent-text': '#121414',
      '--link': '#8ec07c',
      '--success': '#b8bb26',
      '--warning': '#fe8019',
      '--danger': '#fb4934',
      '--highlight-bg': 'rgba(251, 73, 52, 0.14)',
      '--scrollbar': '#453f3b',
      '--scrim': 'rgba(8, 9, 9, 0.42)',
      '--checker-a': '#3c3836',
      '--checker-b': '#1f2122'
    }
  },
  {
    id: 'rose',
    name: 'Rosé',
    dark: false,
    tokens: {
      '--bg': '#faf4ed',
      '--surface': '#fffaf3',
      '--surface-2': '#f2e9e1',
      '--surface-3': '#e9ded4',
      '--border': '#dfd4c8',
      '--text': '#403a5e',
      '--text-muted': '#5b567a',
      '--text-faint': '#6b6683',
      '--accent': '#a2506a',
      '--accent-strong': '#8f4a5e',
      '--link': '#286983',
      '--success': '#568f7c',
      '--warning': '#ea9d34',
      '--danger': '#b4637a',
      '--highlight-bg': 'rgba(180, 99, 122, 0.14)',
      '--system-text': '#5b567a',
      '--scrollbar': '#d7c9bb',
      '--shadow-sm': '0 1px 3px rgba(87, 82, 121, 0.12)',
      '--shadow-md': '0 4px 14px rgba(87, 82, 121, 0.14)',
      '--shadow': '0 8px 30px rgba(87, 82, 121, 0.18)',
      '--shadow-lg': '0 12px 40px rgba(87, 82, 121, 0.2)',
      '--scrim': 'rgba(87, 82, 121, 0.18)',
      '--checker-a': '#d3c2b4',
      '--checker-b': '#f4ece5'
    }
  }
]

export const DEFAULT_THEME = 'dark'

/**
 * The corner-radius scale at 100%. Kept here rather than only in CSS so the "roundness"
 * setting can scale every step from one place — a slider that only reached some of the
 * corners would look worse than no slider at all.
 */
export const RADIUS_BASE: Record<string, number> = {
  '--radius-xs': 3,
  '--radius-sm': 4,
  '--radius-md': 6,
  '--radius-lg': 8,
  '--radius-xl': 10,
  '--radius-2xl': 12
}

/** write the radius scale at `pct` percent; --radius-pill/circle stay as they are */
export function applyRadius(pct: number): void {
  const root = document.documentElement
  const k = Math.max(0, pct) / 100
  for (const [name, base] of Object.entries(RADIUS_BASE)) {
    root.style.setProperty(name, `${Math.round(base * k)}px`)
  }
}

/** the built-in dark palette, used as the fallback layer and as the editor's starting point */
export const DEFAULT_TOKENS = DARK

/** the colours the editor exposes, grouped the way they're shown. Everything NOT in here is
 *  derived by `deriveTokens` — those are the values that are easy to get wrong by hand. */
export const EDITABLE_TOKENS: { group: string; tokens: string[] }[] = [
  { group: 'base', tokens: ['--bg', '--surface', '--surface-2', '--surface-3', '--border'] },
  { group: 'text', tokens: ['--text', '--text-muted', '--text-faint', '--system-text'] },
  { group: 'accent', tokens: ['--accent', '--accent-strong', '--accent-text', '--link'] },
  { group: 'state', tokens: ['--danger', '--success', '--warning', '--live'] },
  // the rule between messages is a theme's decision, not a global one: on a dark theme it
  // wants to be barely there, on a light one it carries the whole structure
  { group: 'misc', tokens: ['--scrollbar', '--msg-separator'] }
]

/** #rrggbb -> relative luminance, for the contrast readout and the derived tones */
export function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const v = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2) || '0', 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
}

/** WCAG contrast ratio between two hex colours */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** shift a hex colour toward white or black by `amount` (0..1) */
function shift(hex: string, amount: number, toward: 'light' | 'dark'): string {
  const h = hex.replace('#', '')
  const target = toward === 'light' ? 255 : 0
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2) || '0', 16)
    return Math.round(c + (target - c) * amount)
  })
  return '#' + ch.map((c) => c.toString(16).padStart(2, '0')).join('')
}

/**
 * Fill in the tokens the editor doesn't ask for.
 *
 * These are exactly the ones that broke the built-in palettes when they were guessed: a light
 * theme wearing dark-theme shadows looks bruised, a flat 55%-black scrim fogs anything that
 * isn't near-black, and a checkerboard whose two squares land a few percent apart stops
 * reading as a checkerboard at all. Deriving them from `dark` and the palette means a
 * user-made theme cannot repeat any of it.
 */
export function deriveTokens(tokens: Record<string, string>, dark: boolean): Record<string, string> {
  const bg = tokens['--bg'] ?? DARK['--bg']
  const a = dark ? 0.14 : 0.1
  return {
    ...tokens,
    '--shadow-sm': dark ? '0 1px 3px rgba(0, 0, 0, 0.35)' : '0 1px 3px rgba(0, 0, 0, 0.1)',
    '--shadow-md': dark ? '0 4px 14px rgba(0, 0, 0, 0.4)' : '0 4px 14px rgba(0, 0, 0, 0.12)',
    '--shadow': dark ? '0 8px 30px rgba(0, 0, 0, 0.55)' : '0 8px 30px rgba(0, 0, 0, 0.18)',
    '--shadow-lg': dark ? '0 12px 40px rgba(0, 0, 0, 0.55)' : '0 12px 40px rgba(0, 0, 0, 0.2)',
    '--scrim': dark ? 'rgba(0, 0, 0, 0.42)' : 'rgba(0, 0, 0, 0.2)',
    // stepped off the background in both directions so the two squares always differ
    '--checker-a': shift(bg, a + 0.08, dark ? 'light' : 'dark'),
    '--checker-b': shift(bg, a - 0.06, dark ? 'light' : 'dark'),
    '--highlight-bg': `color-mix(in srgb, ${tokens['--danger'] ?? DARK['--danger']} ${dark ? 12 : 14}%, transparent)`
  }
}

/** built-ins plus the user's own, which behave identically everywhere */
export function allThemes(): Theme[] {
  const custom = useSettingsStore.getState().settings.customThemes ?? []
  return [
    ...THEMES,
    ...custom.map((c) => ({
      id: c.id,
      name: c.name,
      dark: c.dark,
      tokens: c.tokens,
      radius: c.radius,
      tabColors: c.tabColors
    }))
  ]
}

export function getTheme(id: string): Theme {
  return allThemes().find((t) => t.id === id) ?? THEMES[0]
}

/** is the active theme dark? drives nick contrast correction, not just looks */
export function isDarkTheme(id: string): boolean {
  return getTheme(id).dark
}

/** paint an arbitrary token set onto :root — used for the editor's live preview */
export function applyTokens(
  tokens: Record<string, string>,
  dark: boolean,
  radius = 100,
  tabColors?: Partial<TabColors>
): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries({ ...DARK, ...tokens })) {
    root.style.setProperty(name, value)
  }
  applyRadius(radius)
  for (const [key, prop] of TAB_PROPS) {
    const value = tabColors?.[key]
    if (value) root.style.setProperty(prop, value)
    else root.style.removeProperty(prop)
  }
  root.dataset.theme = dark ? 'dark' : 'light'
}

/**
 * Write a theme's tokens onto :root. Partial themes inherit the rest from dark, so every token
 * is always set to something — otherwise switching from a rich theme to a sparse one would
 * leave the previous theme's values behind.
 */
/** css custom property per TabColors field */
const TAB_PROPS: [keyof TabColors, string][] = [
  ['bg', '--tab-bg'],
  ['text', '--tab-text'],
  ['border', '--tab-border'],
  ['hoverBg', '--tab-hover-bg'],
  ['activeBg', '--tab-active-bg'],
  ['activeText', '--tab-active-text'],
  ['activeBorder', '--tab-active-border']
]

export function applyTheme(id: string): void {
  const theme = getTheme(id)
  const root = document.documentElement
  const tokens = { ...DARK, ...theme.tokens }
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value)
  // shape and tabs travel with the theme; anything the theme doesn't state is cleared so the
  // previous theme's values can't linger
  applyRadius(theme.radius ?? 100)
  for (const [key, prop] of TAB_PROPS) {
    const value = theme.tabColors?.[key]
    if (value) root.style.setProperty(prop, value)
    else root.style.removeProperty(prop)
  }
  // some CSS still keys off light/dark, and so do native controls (scrollbars, form widgets)
  root.dataset.theme = theme.dark ? 'dark' : 'light'
  // NOTE: deliberately no `color-scheme` here. Declaring one makes the root canvas opaque,
  // and that opacity is inherited by embedded documents — it turned the overlay editor's
  // preview iframe into a solid white (light theme) or black (dark) rectangle instead of
  // letting the transparent overlay page show the checkerboard behind it.
}
