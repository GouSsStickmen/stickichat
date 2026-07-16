import { ChatOverlayConfig, DEFAULT_CHAT_OVERLAY } from '../types'

/**
 * Built-in starting points for the overlay editor. A preset is a partial config applied
 * over the defaults — everything stays editable afterwards. `randomizeOverlay` shuffles
 * the key visual knobs for a "surprise me" starting point.
 */
export interface OverlayPreset {
  id: string
  /** i18n-free display name (shown as-is) */
  name: string
  patch: Partial<ChatOverlayConfig>
}

export const OVERLAY_PRESETS: OverlayPreset[] = [
  {
    id: 'classic',
    name: 'Класика',
    patch: {
      layout: 'list',
      plateMode: 'none',
      nickPos: 'inline',
      animIn: 'slide',
      animDir: 'down',
      outlineWidth: 2
    }
  },
  {
    id: 'minimal-dark',
    name: 'Мінімал',
    patch: {
      layout: 'list',
      plateMode: 'line',
      plateBg: { kind: 'solid', color: '#000000', opacity: 0.55, color2: '#000000', angle: 0 },
      plateRadius: [6, 6, 6, 6],
      outlineWidth: 0,
      shadowBlur: 4,
      nickPos: 'inline',
      animIn: 'fade'
    }
  },
  {
    id: 'bubbles',
    name: 'Бульбашки',
    patch: {
      layout: 'bubble',
      plateMode: 'fit',
      plateBg: { kind: 'solid', color: '#18181b', opacity: 0.92, color2: '#18181b', angle: 0 },
      plateRadius: [14, 14, 14, 4],
      platePadX: 12,
      platePadY: 6,
      nickPos: 'above',
      nickBgEnabled: true,
      nickBg: { kind: 'solid', color: '#9147ff', opacity: 1, color2: '#3a0ca3', angle: 135 },
      nickBgRadius: 10,
      outlineWidth: 0,
      animIn: 'pop',
      lineGap: 8
    }
  },
  {
    id: 'neon',
    name: 'Неон',
    patch: {
      layout: 'bubble',
      plateMode: 'fit',
      plateBg: { kind: 'gradient', color: '#12031f', opacity: 0.9, color2: '#2b0a4d', angle: 135 },
      plateRadius: [12, 12, 12, 12],
      plateBorderWidth: 1,
      plateBorderColor: '#c77dff',
      plateShadowBlur: 18,
      plateShadowColor: '#9d4edd',
      glowSize: 6,
      glowColor: '#c77dff',
      outlineWidth: 0,
      nickPos: 'above',
      animIn: 'slide',
      animDir: 'left',
      lineGap: 10
    }
  },
  {
    id: 'glass',
    name: 'Скло',
    patch: {
      layout: 'bubble',
      plateMode: 'fit',
      plateBg: { kind: 'solid', color: '#ffffff', opacity: 0.14, color2: '#ffffff', angle: 0 },
      plateRadius: [16, 16, 16, 16],
      plateBorderWidth: 1,
      plateBorderColor: '#ffffff',
      plateShadowBlur: 12,
      plateShadowColor: '#000000',
      outlineWidth: 0,
      shadowBlur: 3,
      nickPos: 'above',
      animIn: 'fade',
      lineGap: 8,
      customCss: '.content { backdrop-filter: blur(8px); }'
    }
  },
  {
    id: 'messenger',
    name: 'Месенджер',
    patch: {
      layout: 'compact',
      plateMode: 'fit',
      plateBg: { kind: 'solid', color: '#1f1f23', opacity: 0.95, color2: '#1f1f23', angle: 0 },
      plateRadius: [4, 14, 14, 14],
      platePadX: 12,
      platePadY: 6,
      avatarShow: true,
      avatarSize: 32,
      avatarRadius: 50,
      nickPos: 'above',
      outlineWidth: 0,
      animIn: 'slide',
      animDir: 'left',
      lineGap: 8
    }
  },
  {
    id: 'ticker',
    name: 'Рядок унизу',
    patch: {
      layout: 'horizontal',
      anchor: 'bottom',
      plateMode: 'fit',
      plateBg: { kind: 'solid', color: '#ffffff', opacity: 0.95, color2: '#ffffff', angle: 0 },
      plateRadius: [999, 999, 999, 999],
      plateShape: 'pill',
      platePadX: 14,
      platePadY: 6,
      textColor: '#1f1f23',
      outlineWidth: 0,
      avatarShow: true,
      avatarSize: 26,
      nickPos: 'inline',
      nickColorMode: 'fixed',
      nickFixedColor: '#b91c1c',
      animIn: 'slide',
      animDir: 'right',
      edgeFade: 120,
      lineGap: 10,
      maxMessages: 8,
      fadeAfter: 30
    }
  },
  {
    id: 'retro',
    name: 'Ретро-термінал',
    patch: {
      layout: 'list',
      plateMode: 'panel',
      plateBg: { kind: 'solid', color: '#0a1a0a', opacity: 0.85, color2: '#0a1a0a', angle: 0 },
      plateRadius: [6, 6, 6, 6],
      plateBorderWidth: 1,
      plateBorderColor: '#22c55e',
      textColor: '#22c55e',
      nickColorMode: 'fixed',
      nickFixedColor: '#86efac',
      outlineWidth: 0,
      glowSize: 3,
      glowColor: '#22c55e',
      font: 'Consolas',
      animIn: 'none',
      tsShow: true,
      tsColor: '#15803d'
    }
  },
  {
    id: 'candy',
    name: 'Цукерка',
    patch: {
      layout: 'bubble',
      plateMode: 'fit',
      plateBg: { kind: 'gradient', color: '#ff9a9e', opacity: 1, color2: '#fad0c4', angle: 120 },
      plateRadius: [18, 18, 18, 18],
      platePadX: 14,
      platePadY: 7,
      textColor: '#5b2333',
      nickPos: 'above',
      nickBgEnabled: true,
      nickBg: { kind: 'solid', color: '#ffffff', opacity: 0.85, color2: '#ffffff', angle: 0 },
      nickBgRadius: 999,
      nickColorMode: 'palette',
      outlineWidth: 0,
      animIn: 'bounce',
      lineGap: 10
    }
  },
  {
    id: 'slant',
    name: 'Кіберспорт',
    patch: {
      layout: 'list',
      plateMode: 'fit',
      plateShape: 'slant',
      plateBg: { kind: 'gradient', color: '#0f172a', opacity: 0.92, color2: '#1e3a8a', angle: 100 },
      platePadX: 18,
      platePadY: 5,
      plateBorderWidth: 0,
      nickPos: 'inline',
      nickTransform: 'upper',
      nickScale: 90,
      bold: true,
      outlineWidth: 0,
      animIn: 'slide',
      animDir: 'left',
      lineGap: 6
    }
  }
]

const rnd = (arr: readonly unknown[]): number => Math.floor(Math.random() * arr.length)
const pick = <T,>(arr: readonly T[]): T => arr[rnd(arr)]
const range = (min: number, max: number): number => Math.round(min + Math.random() * (max - min))
const HUES = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#9147ff', '#18181b', '#0f172a']

/** shuffle the key visual knobs — a chaotic-but-plausible starting point */
export function randomizeOverlay(): Partial<ChatOverlayConfig> {
  const c1 = pick(HUES)
  const c2 = pick(HUES)
  const layout = pick(['list', 'bubble', 'compact'] as const)
  return {
    ...DEFAULT_CHAT_OVERLAY,
    layout,
    plateMode: pick(['none', 'fit', 'line'] as const),
    plateBg: { kind: pick(['solid', 'gradient'] as const), color: c1, opacity: 0.5 + Math.random() * 0.5, color2: c2, angle: range(0, 315) },
    plateRadius: (() => {
      const r = range(0, 20)
      return [r, r, r, r] as [number, number, number, number]
    })(),
    plateShape: pick(['rect', 'rect', 'rect', 'pill', 'slant', 'notch'] as const),
    plateBorderWidth: pick([0, 0, 0, 1, 2] as const),
    plateBorderColor: pick(HUES),
    plateShadowBlur: pick([0, 0, 8, 16] as const),
    platePadX: range(8, 16),
    platePadY: range(3, 8),
    nickPos: pick(['inline', 'above'] as const),
    nickBgEnabled: Math.random() < 0.3,
    nickBg: { kind: 'solid', color: pick(HUES), opacity: 1, color2: c2, angle: 135 },
    nickBgRadius: range(0, 16),
    animIn: pick(['fade', 'slide', 'pop', 'bounce', 'zoom', 'blur'] as const),
    animDir: pick(['left', 'right', 'up', 'down'] as const),
    outlineWidth: pick([0, 0, 2] as const),
    glowSize: pick([0, 0, 0, 4] as const),
    glowColor: pick(HUES),
    lineGap: range(4, 12),
    avatarShow: Math.random() < 0.3,
    tsShow: Math.random() < 0.2
  }
}
