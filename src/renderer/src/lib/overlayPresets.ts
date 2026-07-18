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
  },
  {
    id: 'winsynth',
    name: 'Windows',
    patch: {
      layout: 'list',
      plateMode: 'none',
      nickPos: 'above',
      nickFloat: false,
      nickAlign: 'left',
      outlineWidth: 0,
      animIn: 'fade',
      animOut: 'fade',
      textColor: '#eaf0ff',
      customCss: `.content{background:#0b1030!important;border:1.5px solid #4d6bff!important;border-radius:10px!important;padding:0!important;overflow:hidden!important;min-width:300px;position:relative;box-shadow:0 0 0 1px rgba(120,150,255,.35),0 0 14px rgba(77,107,255,.55),0 8px 20px rgba(0,0,0,.55)!important}
.content::after{content:'';position:absolute;inset:27px 0 0 auto;width:46%;z-index:0;opacity:.55;pointer-events:none;background:radial-gradient(circle at 78% 24%,#ff64c0 0 7px,rgba(255,100,192,.3) 8px 16px,transparent 17px),linear-gradient(0deg,rgba(90,140,255,.28),transparent 55%),repeating-linear-gradient(90deg,transparent 0 22px,rgba(120,160,255,.4) 22px 23px),repeating-linear-gradient(0deg,transparent 0 15px,rgba(120,160,255,.3) 15px 16px);-webkit-mask-image:linear-gradient(to left,#000 30%,transparent);mask-image:linear-gradient(to left,#000 30%,transparent)}
.meta{display:flex!important;align-items:center!important;justify-content:flex-start!important;gap:6px!important;width:100%!important;margin:0!important;padding:4px 8px!important;box-sizing:border-box!important;position:relative;z-index:2;background:linear-gradient(180deg,#3f5fe0,#2a3fa0)!important;border-bottom:1px solid #6f86ff!important}
.meta::after{content:'＋  –  ▢  ✕';margin-left:auto;padding:0 6px;font-family:Consolas,monospace;font-size:11px;letter-spacing:2px;line-height:15px;color:#dfe6ff;border:1px solid rgba(255,255,255,.4);border-radius:3px}
.nick{color:#fff!important;font-weight:700!important;font-size:.95em;text-shadow:0 1px 2px rgba(0,0,0,.6)}
.body{padding:10px 12px!important;position:relative;z-index:1}
.body,.body>span:last-child{color:#eaf0ff!important;font-weight:700!important}
.body img.emote{height:1.5em!important}
.sysline{color:#ffd54a!important;padding:8px 12px!important}`
    }
  },
  {
    id: 'paper',
    name: 'Аркуш',
    patch: {
      layout: 'list',
      plateMode: 'none',
      nickPos: 'inline',
      nickFloat: false,
      outlineWidth: 0,
      direction: 'up',
      maxMessages: 8,
      lineGap: 2,
      animIn: 'typewriter',
      animInMs: 500,
      animOut: 'fold',
      animOutMs: 600,
      textColor: '#1b2742',
      customCss: `@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&display=swap');
#zone{left:20px!important;right:auto!important;width:400px!important;height:460px!important;overflow:hidden!important;padding:30px 34px 22px!important;box-sizing:border-box!important;justify-content:flex-end!important;border-radius:6px 10px 8px 12px!important;transform:rotate(-1.1deg)!important;transform-origin:50% 100%!important;background:linear-gradient(103deg,rgba(0,0,0,.05) 0 1px,transparent 1px 40%),linear-gradient(258deg,rgba(0,0,0,.045) 0 1px,transparent 1px 46%),radial-gradient(120% 90% at 30% 8%,#fbf6e6 0%,#f3ead0 60%,#ece0c2 100%)!important;box-shadow:0 2px 3px rgba(0,0,0,.25),0 14px 30px rgba(0,0,0,.45),inset 0 0 40px rgba(120,95,45,.12)!important;font-family:'Caveat','Segoe Script',cursive!important}
#zone::before{content:'';position:absolute;inset:0;z-index:0;pointer-events:none;opacity:.55;mix-blend-mode:multiply;border-radius:inherit;background-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%27170%27%20height%3D%27170%27%3E%3Cfilter%20id%3D%27n%27%3E%3CfeTurbulence%20type%3D%27fractalNoise%27%20baseFrequency%3D%270.8%27%20numOctaves%3D%272%27%20stitchTiles%3D%27stitch%27%2F%3E%3C%2Ffilter%3E%3Crect%20width%3D%27170%27%20height%3D%27170%27%20filter%3D%27url%28%23n%29%27%2F%3E%3C%2Fsvg%3E")}
#zone::after{content:'';position:absolute;inset:0;z-index:0;pointer-events:none;opacity:.5;background-repeat:no-repeat;background-position:center;background-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%27400%27%20height%3D%27340%27%3E%3Cg%20fill%3D%27none%27%20stroke%3D%27%2333508c%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M58%2070%20q8-15%2023-6%20q13%209%200%2021%20q-16%2012-31-3%20q-13-17%209-29%27%2F%3E%3Cpath%20d%3D%27M312%2056%20l6%2017%2017%201-13%2011%205%2017-15-10-15%2010%205-17-13-11%2017-1z%27%2F%3E%3Cpath%20d%3D%27M120%20158%20q30-19%2062%200%20t62%200%27%2F%3E%3Cpath%20d%3D%27M122%20158%20l122%207%20M128%20168%20l114-12%27%2F%3E%3Cpath%20d%3D%27M66%20250%20q44-31%2095-6%20M156%20236%20l13%208-15%207%27%2F%3E%3Cpath%20d%3D%27M42%20300%20q62%2013%20124%200%20t156%205%27%2F%3E%3Cpath%20d%3D%27M300%20250%20q-6%2024%2014%2030%20q22%205%2020-16%20q-2-16-20-14%20q-16%202-14%2022%20q2%2026%2030%2022%27%2F%3E%3C%2Fg%3E%3Ctext%20x%3D%27300%27%20y%3D%27262%27%20font-family%3D%27Comic%20Sans%20MS%2C%20cursive%27%20font-size%3D%2750%27%20font-weight%3D%27700%27%20fill%3D%27%233a5aa0%27%20transform%3D%27rotate%28-9%20312%20250%29%27%3E69%3C%2Ftext%3E%3C%2Fsvg%3E")}
.line{position:relative;z-index:1;font-size:21px;line-height:1.15}
.cwrap,.cwrap>.content{width:100%!important;max-width:100%!important}
.content{background:transparent!important;border:none!important;box-shadow:none!important;border-radius:0!important;padding:2px 0!important}
.nick{color:#22336b!important;font-weight:700!important;text-shadow:0 0 1px rgba(30,50,110,.4)}
.body,.body>span,.sysline{color:#1b2742!important;text-shadow:0 0 1px rgba(27,39,66,.35)}
.sysline{color:#7a1f5a!important}
.badges img{filter:grayscale(.35) contrast(.9);opacity:.9}
.body img.emote{height:1.35em!important;filter:sepia(.15) contrast(.95)}`
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
