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
      '--text-faint': '#8a8a94',
      '--accent': '#9147ff',
      '--accent-strong': '#772ce8',
      '--danger': '#d43a3a',
      '--success': '#1a9648',
      '--warning': '#c98a12',
      '--highlight-bg': 'rgba(255, 92, 92, 0.14)',
      '--system-text': '#53535f',
      '--link': '#1a6dcc',
      '--scrollbar': '#c5c5cc',
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
      '--bg': '#2e3440',
      '--surface': '#343c4b',
      '--surface-2': '#3b4252',
      '--surface-3': '#434c5e',
      '--border': '#4c566a',
      '--text': '#eceff4',
      '--text-muted': '#c2cbd8',
      '--text-faint': '#8794a6',
      '--accent': '#88c0d0',
      '--accent-strong': '#5e81ac',
      '--accent-text': '#20242c',
      '--link': '#8fbcbb',
      '--success': '#a3be8c',
      '--warning': '#ebcb8b',
      '--danger': '#bf616a',
      '--highlight-bg': 'rgba(191, 97, 106, 0.16)',
      '--scrollbar': '#4c566a',
      // tinted with the palette's own deep tone: neutral black greys a mid-tone theme out
      '--scrim': 'rgba(17, 21, 28, 0.42)',
      '--checker-a': '#4c566a',
      '--checker-b': '#333a47'
    }
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    dark: true,
    tokens: {
      '--bg': '#1d2021',
      '--surface': '#282828',
      '--surface-2': '#32302f',
      '--surface-3': '#3c3836',
      '--border': '#504945',
      '--text': '#ebdbb2',
      '--text-muted': '#bdae93',
      '--text-faint': '#928374',
      '--accent': '#fabd2f',
      '--accent-strong': '#d79921',
      '--accent-text': '#1d2021',
      '--link': '#83a598',
      '--success': '#b8bb26',
      '--warning': '#fe8019',
      '--danger': '#fb4934',
      '--highlight-bg': 'rgba(251, 73, 52, 0.14)',
      '--scrollbar': '#504945',
      '--scrim': 'rgba(12, 13, 13, 0.42)',
      '--checker-a': '#4a4441',
      '--checker-b': '#2a2827'
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
      '--text': '#575279',
      '--text-muted': '#797593',
      '--text-faint': '#9893a5',
      '--accent': '#b4637a',
      '--accent-strong': '#8f4a5e',
      '--link': '#286983',
      '--success': '#568f7c',
      '--warning': '#ea9d34',
      '--danger': '#b4637a',
      '--highlight-bg': 'rgba(180, 99, 122, 0.14)',
      '--system-text': '#797593',
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

export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

/** is the active theme dark? drives nick contrast correction, not just looks */
export function isDarkTheme(id: string): boolean {
  return getTheme(id).dark
}

/**
 * Write a theme's tokens onto :root. Partial themes inherit the rest from dark, so every token
 * is always set to something — otherwise switching from a rich theme to a sparse one would
 * leave the previous theme's values behind.
 */
export function applyTheme(id: string): void {
  const theme = getTheme(id)
  const root = document.documentElement
  const tokens = { ...DARK, ...theme.tokens }
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value)
  // some CSS still keys off light/dark, and so do native controls (scrollbars, form widgets)
  root.dataset.theme = theme.dark ? 'dark' : 'light'
  // NOTE: deliberately no `color-scheme` here. Declaring one makes the root canvas opaque,
  // and that opacity is inherited by embedded documents — it turned the overlay editor's
  // preview iframe into a solid white (light theme) or black (dark) rectangle instead of
  // letting the transparent overlay page show the checkerboard behind it.
}
