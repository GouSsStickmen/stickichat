import { Children, isValidElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { useAccountsStore } from '../../store/accounts'
import { useUiStore } from '../../store/ui'
import { useT, TranslationKey } from '../../i18n'
import {
  ChatOverlayConfig,
  CustomTheme,
  DEFAULT_CHAT_OVERLAY,
  DEFAULT_EMOTE_OVERLAY,
  DEFAULT_FOLLOW_OVERLAY,
  DEFAULT_GOAL_OVERLAY,
  DEFAULT_ROULETTE_OVERLAY,
  DEFAULT_HOTKEYS,
  DEFAULT_OVERLAY_STYLE,
  HighlightKind,
  HighlightRule,
  HotkeyAction,
  MESSAGE_ONLY_TYPES,
  ModActionType,
  ModButton,
  OverlayBase,
  OverlayConfig,
  OverlayKind,
  OverlayProfile,
  SOUND_PRESETS,
  Settings,
  TabColors,
  VALUELESS_HL_KINDS
} from '../../types'
import { nextId, useLayoutStore } from '../../store/layout'
import { exportOverlayJson, parseOverlayImport } from '../../lib/overlayShare'
import { startPointerReorder } from '../../lib/pointerReorder'
import { isMobile } from '../../lib/platform'
import { useFlip } from '../../lib/useFlip'
import { eventToAccel, hotkeyFor } from '../../lib/hotkeys'
import { hexToRgba } from '../../lib/tokenize'
import { removeAccountEverywhere, refreshModeratedChannels } from '../../services/accountService'
import {
  playMentionSound,
  playFirstMessageSound,
  playKeywordSound,
  playNickAlertSound,
  playStreamUpSound,
  playWhisperSound,
  playRaidSound,
  playHypeTrainStartSound,
  playHypeTrainLevelSound,
  playErrorSound
} from '../../lib/sound'
import { CHANGELOG } from '../../changelog'
import {
  exportConfigJson,
  importConfigJson,
  describeImport,
  CONFIG_PARTS,
  ConfigPart
} from '../../services/config'
import BtnIcon from '../BtnIcon'
import EmotePicker, { PinButton } from '../EmotePicker'
import { CHAT_FONT_MAX, UI_SCALE_MIN, UI_SCALE_MAX, clampUiScale } from '../../App'
import {
  TranslitIcon,
  PlayIcon,
  TrashIcon,
  PencilIcon,
  CloseIcon,
  TrayArrowIcon,
  PaletteIcon
} from '../Icons'
import {
  THEMES,
  getTheme,
  applyTheme,
  applyTokens,
  contrast,
  deriveTokens,
  DEFAULT_THEME,
  DEFAULT_TOKENS,
  EDITABLE_TOKENS
} from '../../lib/themes'
import { exportThemeJson, parseThemeImport, nextThemeId, uniqueThemeName } from '../../lib/themeShare'

type Section =
  | 'accounts'
  | 'appearance'
  | 'chat'
  | 'highlights'
  | 'notifications'
  | 'moderation'
  | 'hotkeys'
  | 'windows'
  | 'overlay'
  | 'advanced'
  | 'about'

const BUTTON_TYPES: ModActionType[] = [
  'timeout', 'ban', 'unban', 'delete', 'warn', 'shoutout', 'raid', 'announce', 'snippet', 'link', 'fill', 'copy',
  'resend', 'msgToInput'
]

const DEVELOPER = 'GouS_Stickmen'
const GITHUB_ISSUES = 'https://github.com/GouSsStickmen/stickichat/issues'
const TWITCH_PROFILE = 'https://www.twitch.tv/gous_stickmen'

export default function SettingsModal({
  standalone,
  initialSection
}: {
  standalone?: boolean
  initialSection?: string
}): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const close = (): void => (standalone ? window.close() : useUiStore.getState().setSettingsOpen(false))
  // NOTE: read-only in the initializer — StrictMode runs it twice, so clearing here
  // would wipe the requested section before the second run sees it
  /*
   * On a phone the panel is two screens, not two columns.
   *
   * A 160px list of eleven categories beside the controls leaves the controls 245px of a 411px
   * screen, and the categories are visible the whole time for no reason — you pick one and then read
   * one. So the list IS the first screen: `section` starts as null, tapping a row opens it, and the
   * header grows a back arrow. Nothing about the sections themselves changes.
   */
  const phone = isMobile()
  const [section, setSection] = useState<Section | null>(
    () =>
      ((initialSection ?? useUiStore.getState().settingsSection) as Section | null) ??
      (phone ? null : 'accounts')
  )
  useEffect(() => {
    useUiStore.getState().setSettingsSection(null)
  }, [])

  // Escape closes; clicking the backdrop intentionally does NOT (misclicks were annoying)
  useEffect(() => {
    if (standalone) return
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // on a phone this event is also what Android's back button becomes: back out of the section
      // first, and only leave the panel from its own front screen
      if (phone && section) setSection(null)
      else close()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standalone, phone, section])

  const openInWindow = (): void => {
    useUiStore.getState().setSettingsOpen(false)
    window.sticki.openSettingsWindow('settings')
  }

  const allSections: [Section, string][] = [
    ['accounts', t('set.accounts')],
    ['appearance', t('set.appearance')],
    ['chat', t('set.chat')],
    ['highlights', t('set.highlights')],
    ['notifications', t('set.notifications')],
    ['moderation', t('set.moderation')],
    ['hotkeys', t('set.hotkeys')],
    ['windows', t('set.windows')],
    ['overlay', t('set.overlay')],
    ['advanced', t('set.advanced')],
    ['about', t('set.about')]
  ]

  /*
   * Three categories are about things a phone does not have: physical shortcut keys, extra windows,
   * and the OBS overlay server, which only the desktop process runs. On a phone they are pages of
   * switches that cannot do anything, so they are not offered.
   */
  const PHONE_HIDDEN = new Set<Section>(['hotkeys', 'windows', 'overlay'])
  const sections = phone ? allSections.filter(([k]) => !PHONE_HIDDEN.has(k)) : allSections
  const sectionTitle = allSections.find(([k]) => k === section)?.[1] ?? t('set.title')

  const body = (
    <>
      <div className="modal-header">
        {phone && section && (
          <button className="ghost m-set-back" onClick={() => setSection(null)}>
            ‹
          </button>
        )}
        {phone ? sectionTitle : t('set.title')}
        <div className="spacer" />
        {/* language switcher lives in the header — always one click away */}
        <select
          value={settings.language}
          style={{ marginRight: 6, padding: '4px 7px', fontSize: 12 }}
          onChange={(e) => set({ language: e.target.value as 'uk' | 'en' })}
        >
          {/* no flags: Windows has no regional-indicator glyphs, so 🇺🇦 renders as the
              literal letters "UA" sitting in front of the name */}
          <option value="uk">Українська</option>
          <option value="en">English</option>
        </select>
        {standalone && <PinButton settingKey="settingsPinned" />}
        {!standalone && (
          <button
            className="ghost"
            data-desktop-only
            title={t('set.openInWindow')}
            onClick={openInWindow}
          >
            ⧉
          </button>
        )}
        {/* as a window it already has a title-bar close; as a modal it needs this one */}
        {!standalone && (
          <button className="ghost" onClick={close}>
            <CloseIcon />
          </button>
        )}
      </div>
      <div className={`settings-layout ${phone ? (section ? 'phone-section' : 'phone-index') : ''}`}>
        {/* on a phone the list and the section are separate screens, never both at once */}
        {(!phone || !section) && (
          <div className="settings-nav">
            {sections.map(([key, label]) => (
              <button key={key} className={section === key ? 'active' : ''} onClick={() => setSection(key)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {(!phone || section) && (
        <div className="settings-content">
          {section === 'accounts' && <AccountsSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'chat' && <ChatSection />}
          {section === 'highlights' && <HighlightsSection />}
          {section === 'notifications' && <NotificationsSection />}
          {section === 'moderation' && <ModerationSection />}
          {section === 'hotkeys' && <HotkeysSection />}
          {section === 'windows' && <WindowsSection />}
          {section === 'overlay' && <OverlaySection />}
          {section === 'advanced' && <AdvancedSection />}
          {section === 'about' && <AboutSection />}
        </div>
        )}
      </div>
    </>
  )

  if (standalone) return <div className="modal standalone-settings">{body}</div>

  // As a panel inside the chat window the scale slider did nothing: the app-level effect that
  // applies it zooms the document root, and it only runs in the utility windows — doing it
  // here would scale the chat along with the panel. So the panel scales ITSELF. Its own width
  // and height caps are in viewport units, which zoom multiplies, so they are divided back out
  // via --panel-scale; the panel grows with the setting but still stops at the window edge.
  const panelScale = clampUiScale(settings.windowScales?.settings ?? 100) / 100
  return (
    <div className="modal-backdrop">
      <div
        className="modal wide"
        style={{ zoom: panelScale, '--panel-scale': panelScale } as React.CSSProperties}
      >
        {body}
      </div>
    </div>
  )
}

/** nick list editor: free typing (commas, spaces, newlines) — parsed only on blur */
export function NickListArea({
  value,
  onCommit,
  placeholder
}: {
  value: string[]
  onCommit: (v: string[]) => void
  placeholder?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState(value.join(', '))
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!focusedRef.current) setDraft(value.join(', '))
  }, [value])
  return (
    <textarea
      rows={2}
      style={{ flex: 1, resize: 'vertical' }}
      placeholder={placeholder ?? 'nightbot, streamelements…'}
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        focusedRef.current = true
      }}
      onBlur={() => {
        focusedRef.current = false
        onCommit(
          draft
            .split(/[\s,;]+/)
            .map((x) => x.trim().toLowerCase().replace(/^@/, ''))
            .filter(Boolean)
        )
      }}
    />
  )
}

/** number input that lets you type ANY value freely (no clamp-while-typing); clamps only
 *  on blur/Enter. Fixes fields snapping to min/max mid-edit. */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  width = 90
}: {
  value: number
  onChange: (n: number) => void
  min: number
  max: number
  step?: number
  width?: number
}): React.JSX.Element {
  const [buf, setBuf] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setBuf(String(value))
  }, [value])
  const commit = (): void => {
    const n = parseFloat(buf)
    const v = Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : value
    onChange(v)
    setBuf(String(v))
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      style={{ width }}
      value={buf}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => {
        setBuf(e.target.value)
        const n = parseFloat(e.target.value)
        if (Number.isFinite(n) && n >= min && n <= max) onChange(n) // live only when valid
      }}
      onBlur={() => {
        focused.current = false
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

/** hex → HSV (h 0–360, s/v 0–1) */
function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const m = /^#?([0-9a-f]{6})/i.exec(hex)
  const n = m ? parseInt(m[1], 16) : 0
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d + 6) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return { h, s: max ? d / max : 0, v: max }
}

function hsvToHex(h: number, s: number, v: number): string {
  const f = (nn: number): number => {
    const k = (nn + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  const to = (x: number): string =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(f(5))}${to(f(3))}${to(f(1))}`
}

const EyedropperIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.71 3.29a3.08 3.08 0 0 0-4.35 0l-2.45 2.45-1.06-1.06-1.42 1.41 1.07 1.07-8.61 8.61a2 2 0 0 0-.54 1.02l-.63 3.22a1 1 0 0 0 1.17 1.17l3.22-.63c.39-.08.74-.26 1.02-.54l8.61-8.61 1.07 1.07 1.41-1.42-1.06-1.06 2.45-2.45a3.08 3.08 0 0 0 0-4.35zM6.06 17.94l7.87-7.87 1.06 1.06-7.87 7.87-1.33.26.27-1.32z" />
  </svg>
)

/** custom color picker: own palette popup (no built-in page eyedropper), SCREEN-wide eyedropper, saved/recent swatches */
export function ColorField({
  value,
  defaultValue,
  onChange
}: {
  value: string
  defaultValue: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const t = useT()
  const set = useSettingsStore((s) => s.setSettings)
  const savedColors = useSettingsStore((s) => s.settings.savedColors)
  const recentColors = useSettingsStore((s) => s.settings.recentColors)
  const [palOpen, setPalOpen] = useState(false)
  const [hsv, setHsv] = useState(() => hexToHsv(value))
  const [hexBuf, setHexBuf] = useState(value)
  const rootRef = useRef<HTMLSpanElement>(null)
  const svRef = useRef<HTMLDivElement>(null)
  const palRef = useRef<HTMLDivElement>(null)
  const [palStyle, setPalStyle] = useState<React.CSSProperties>()
  const draggingRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef(value)

  // dragging the SV area fires per-mousemove; pushing every tick through the settings
  // store (save + cross-window sync + overlay push) visibly lagged — emit once per frame
  const emit = (hex: string): void => {
    pendingRef.current = hex
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      onChange(pendingRef.current)
    })
  }

  // the popup uses FIXED positioning: it escapes scroll-container clipping, and when
  // there is no room below the field it flips above it (and clamps into the window)
  useLayoutEffect(() => {
    if (!palOpen) {
      setPalStyle(undefined)
      return
    }
    const anchor = rootRef.current?.getBoundingClientRect()
    const pop = palRef.current?.getBoundingClientRect()
    if (!anchor || !pop) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = Math.max(8, Math.min(anchor.left, vw - pop.width - 8))
    let top = anchor.bottom + 4
    if (top + pop.height > vh - 8) top = Math.max(8, anchor.top - pop.height - 4)
    // Undo the window scale. getBoundingClientRect() already reports where things really
    // are on screen, but this popup lives inside the zoomed root, so a length written into
    // its `left`/`top` gets multiplied by the zoom on the way back out — at 180% the palette
    // landed most of a window away from its swatch and off the edge.
    const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1
    setPalStyle({ position: 'fixed', left: left / zoom, top: top / zoom, right: 'auto' })
  }, [palOpen])

  // adopt external changes (reset, palette pick in another field…) unless the user is mid-drag
  useEffect(() => {
    if (draggingRef.current) return
    setHexBuf(value)
    setHsv((p) => (hsvToHex(p.h, p.s, p.v).toLowerCase() === value.toLowerCase() ? p : hexToHsv(value)))
  }, [value])

  useEffect(() => {
    if (!palOpen) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPalOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [palOpen])

  const commitRecent = (v: string): void => {
    const fresh = useSettingsStore.getState().settings
    set({ recentColors: [v, ...fresh.recentColors.filter((c) => c !== v)].slice(0, 10) })
  }
  const apply = (v: string): void => {
    onChange(v)
    commitRecent(v)
  }

  const pickSv = (e: { clientX: number; clientY: number }): void => {
    const r = svRef.current?.getBoundingClientRect()
    if (!r) return
    const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    setHsv((p) => {
      const n = { ...p, s, v }
      emit(hsvToHex(n.h, n.s, n.v))
      return n
    })
  }

  return (
    <span ref={rootRef} className="color-field">
      <button
        className="color-swatch-main"
        style={{ background: value }}
        title={`${value} · ${t('set.colorReset')}`}
        onClick={() => setPalOpen((v) => !v)}
        onContextMenu={(e) => {
          e.preventDefault()
          onChange(defaultValue)
        }}
      />
      <button
        className="ghost"
        title={t('set.eyedropper')}
        onClick={async () => {
          // OUR OWN picker: a fullscreen topmost screenshot window with a magnifier —
          // the Chromium EyeDropper loupe kept sinking behind other chat windows
          const hex = await window.sticki.pickScreenColor()
          if (hex) apply(hex)
        }}
      >
        {EyedropperIcon}
      </button>
      {palOpen && (
        <div className="color-pal" ref={palRef} style={palStyle ?? { visibility: 'hidden' }}>
          <div
            ref={svRef}
            className="color-sv"
            style={{
              background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h}, 100%, 50%))`
            }}
            onPointerDown={(e) => {
              draggingRef.current = true
              ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
              pickSv(e)
            }}
            onPointerMove={(e) => {
              if (draggingRef.current) pickSv(e)
            }}
            onPointerUp={() => {
              draggingRef.current = false
              commitRecent(hsvToHex(hsv.h, hsv.s, hsv.v))
            }}
          >
            <div
              className="color-sv-dot"
              style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value }}
            />
          </div>
          <input
            className="color-hue"
            type="range"
            min={0}
            max={360}
            value={Math.round(hsv.h)}
            onChange={(e) => {
              const h = Number(e.target.value)
              setHsv((p) => {
                const n = { ...p, h }
                emit(hsvToHex(n.h, n.s, n.v))
                return n
              })
            }}
            onMouseUp={() => commitRecent(hsvToHex(hsv.h, hsv.s, hsv.v))}
          />
          <input
            className="color-hex"
            type="text"
            value={hexBuf}
            spellCheck={false}
            onChange={(e) => {
              const v = e.target.value
              setHexBuf(v)
              if (/^#[0-9a-f]{6}$/i.test(v)) onChange(v)
            }}
            onBlur={() => {
              setHexBuf(value)
              commitRecent(value)
            }}
          />
          <div className="color-pal-title">{t('color.saved')}</div>
          <div className="color-pal-row">
            {savedColors.map((c) => (
              <button
                key={c}
                className="color-swatch"
                style={{ background: c }}
                title={`${c} · ${t('color.remove')}`}
                onClick={() => apply(c)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  set({ savedColors: savedColors.filter((x) => x !== c) })
                }}
              />
            ))}
            <button
              className="color-swatch color-swatch-add"
              title={t('color.save')}
              onClick={() => {
                if (!savedColors.includes(value)) set({ savedColors: [...savedColors, value].slice(0, 20) })
              }}
            >
              +
            </button>
          </div>
          {recentColors.length > 0 && (
            <>
              <div className="color-pal-title">{t('color.recent')}</div>
              <div className="color-pal-row">
                {recentColors.map((c) => (
                  <button
                    key={c}
                    className="color-swatch"
                    style={{ background: c }}
                    title={c}
                    onClick={() => apply(c)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </span>
  )
}

function AccountsSection(): React.JSX.Element {
  const t = useT()
  const accounts = useAccountsStore((s) => s.accounts)
  return (
    <div>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>{t('set.accounts.orderHint')}</p>
      {accounts.map((a, i) => (
        <div key={a.id} className="account-row">
          {i === 0 && <span className="ov-type" title={t('set.accounts.main')}>★</span>}
          {a.avatarUrl && <img src={a.avatarUrl} alt="" />}
          <div className="grow">
            <b>{a.displayName}</b>
            <span className="hint" style={{ marginLeft: 8 }}>
              {a.login} · mod in {a.moderatedChannelIds.length} channels
            </span>
          </div>
          <button
            title={t('set.accounts.up')}
            disabled={i === 0}
            onClick={() => useAccountsStore.getState().moveAccount(a.id, -1)}
          >
            ↑
          </button>
          <button
            title={t('set.accounts.down')}
            disabled={i === accounts.length - 1}
            onClick={() => useAccountsStore.getState().moveAccount(a.id, 1)}
          >
            ↓
          </button>
          <button onClick={() => refreshModeratedChannels(a.id)}>⟳</button>
          <button className="danger" onClick={() => removeAccountEverywhere(a.id)}>
            {t('set.accounts.remove')}
          </button>
        </div>
      ))}
      <div style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => useUiStore.getState().setAddAccountOpen(true)}>
          + {t('auth.addAccount')}
        </button>
      </div>
    </div>
  )
}

/**
 * Theme picker plus the editor for user-made themes.
 *
 * The grid shows built-ins and custom themes together on purpose: a theme the user built is
 * not a second-class thing, it goes through exactly the same registry and the same applyTheme.
 */
function ThemeSection(): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const custom = settings.customThemes ?? []
  const [editing, setEditing] = useState<CustomTheme | null>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const [ioMsg, setIoMsg] = useState('')

  const label = (th: { id: string; name: string }): string =>
    th.id === 'dark' ? t('set.theme.dark') : th.id === 'light' ? t('set.theme.light') : th.name

  const startNew = (): void => {
    const base = getTheme(settings.theme)
    setEditing({
      id: nextThemeId(custom),
      name: uniqueThemeName(
        label(base) + ' ' + t('theme.copySuffix'),
        new Set([...custom.map((c) => c.name), ...THEMES.map((c) => c.name)])
      ),
      dark: base.dark,
      tokens: { ...DEFAULT_TOKENS, ...base.tokens }
    })
  }

  const download = (json: string, name: string): void => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const safe = (x: string): string => x.replace(/[^\w\-. ]+/g, '_').trim() || 'theme'

  const importFile = (file: File | undefined): void => {
    if (!file) return
    void file.text().then((text) => {
      const parsed = parseThemeImport(text, custom)
      if (!parsed) {
        setIoMsg(t('theme.io.bad'))
        return
      }
      set({ customThemes: [...useSettingsStore.getState().settings.customThemes, ...parsed] })
      setIoMsg(t('theme.io.imported', { n: parsed.length }))
    })
  }

  if (editing) {
    return (
      <ThemeEditor
        draft={editing}
        onCancel={() => {
          setEditing(null)
          applyTheme(settings.theme)
        }}
        onSave={(th) => {
          const rest = custom.filter((c) => c.id !== th.id)
          set({ customThemes: [...rest, th], theme: th.id })
          setEditing(null)
        }}
      />
    )
  }

  return (
    <div className="set-row set-row-block">
      <label>{t('set.theme')}</label>
      {/* swatches rather than a dropdown: a theme is a set of colours, and picking one by
          name alone means switching back and forth to find out what it looks like */}
      <div className="theme-grid">
        {[...THEMES, ...custom].map((th) => {
          const tk = { ...DEFAULT_TOKENS, ...th.tokens }
          const mine = custom.some((c) => c.id === th.id)
          return (
            <div
              key={th.id}
              className={`theme-card ${settings.theme === th.id ? 'active' : ''}`}
              onClick={() => set({ theme: th.id })}
              style={{ background: tk['--bg'], borderColor: tk['--border'] }}
            >
              <span className="theme-dots">
                <i style={{ background: tk['--surface-2'] }} />
                <i style={{ background: tk['--accent'] }} />
                <i style={{ background: tk['--text'] }} />
              </span>
              {/* only "dark"/"light" are words; the rest are proper names and stay as-is */}
              <span className="theme-name" style={{ color: tk['--text'] }}>{label(th)}</span>
              {mine && (
                <span className="theme-card-actions">
                  <button
                    title={t('theme.edit')}
                    style={{ color: tk['--text-muted'] }}
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditing({ ...(th as CustomTheme), tokens: { ...DEFAULT_TOKENS, ...th.tokens } })
                    }}
                  >
                    <PencilIcon size={13} />
                  </button>
                  <button
                    title={t('theme.export')}
                    style={{ color: tk['--text-muted'] }}
                    onClick={(e) => {
                      e.stopPropagation()
                      download(exportThemeJson(th as CustomTheme), `${safe(th.name)}.stickichat-theme.json`)
                    }}
                  >
                    <TrayArrowIcon dir="out" size={13} />
                  </button>
                  <button
                    title={t('theme.delete')}
                    style={{ color: tk['--danger'] }}
                    onClick={(e) => {
                      e.stopPropagation()
                      // fall back to the built-in dark rather than leaving a dangling id
                      const next = custom.filter((c) => c.id !== th.id)
                      set({
                        customThemes: next,
                        theme: settings.theme === th.id ? DEFAULT_THEME : settings.theme
                      })
                    }}
                  >
                    <CloseIcon size={13} />
                  </button>
                </span>
              )}
            </div>
          )
        })}
        <button className="theme-card theme-card-new" onClick={startNew}>
          + {t('theme.new')}
        </button>
      </div>
      <div className="ov-io" style={{ marginTop: 2 }}>
        <button onClick={() => importRef.current?.click()}>
          <TrayArrowIcon dir="in" /> {t('theme.io.import')}
        </button>
        <button
          disabled={!custom.length}
          onClick={() =>
            download(
              exportThemeJson(custom),
              `stickichat-themes-${new Date().toISOString().slice(0, 10)}.json`
            )
          }
        >
          <TrayArrowIcon dir="out" /> {t('theme.io.exportAll')}
        </button>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            importFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {ioMsg && <span className="hint" style={{ color: 'var(--text-faint)' }}>{ioMsg}</span>}
      </div>
    </div>
  )
}

/**
 * The editor. Every change paints straight onto :root so the theme is judged in the running
 * app rather than in a swatch; cancelling puts the active theme back.
 *
 * Only colours are exposed. Shadows, the modal scrim, the transparency checkerboard and the
 * highlight tint are derived on save, because every one of those is a value the built-in
 * palettes originally got wrong by hand.
 */
function ThemeEditor({
  draft,
  onSave,
  onCancel
}: {
  draft: CustomTheme
  onSave: (t: CustomTheme) => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState(draft.name)
  const [dark, setDark] = useState(draft.dark)
  const [tokens, setTokens] = useState<Record<string, string>>(draft.tokens)
  const [radius, setRadius] = useState(draft.radius ?? 100)
  const [tabColors, setTabColors] = useState<Partial<TabColors>>(draft.tabColors ?? {})

  useEffect(() => {
    applyTokens(deriveTokens(tokens, dark), dark, radius, tabColors)
  }, [tokens, dark, radius, tabColors])

  const ratio = contrast(tokens['--text'] ?? '#ffffff', tokens['--bg'] ?? '#000000')
  const faint = contrast(tokens['--text-faint'] ?? '#888888', tokens['--bg'] ?? '#000000')

  return (
    <div className="set-row set-row-block theme-editor">
      {/* The editor used to open as one more row inside the "General" card, so its colour
          fields ran straight on into the app scale, font and text size below it and there was
          no telling where the theme stopped. It is its own titled panel now. */}
      <div className="theme-editor-title">
        <PencilIcon size={14} />
        {t('theme.editing')}
      </div>
      <div className="theme-editor-head">
        <input
          value={name}
          maxLength={40}
          placeholder={t('theme.name')}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="theme-dark-toggle" title={t('hint.themeDark')}>
          <input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} />
          {t('theme.isDark')}
        </label>
      </div>
      {/* the readout is the point: Nord and Gruvbox once shipped a third less contrasty than
          everything else, and nothing in the UI said so until it was measured */}
      <div className="theme-contrast">
        <span className={ratio < 9 ? 'bad' : ratio < 12 ? 'warn' : 'ok'}>
          {t('theme.contrastText')}: {ratio.toFixed(1)}
        </span>
        <span className={faint < 4.5 ? 'bad' : faint < 5.5 ? 'warn' : 'ok'}>
          {t('theme.contrastFaint')}: {faint.toFixed(1)}
        </span>
        <span className="hint">{t('theme.contrastHint')}</span>
      </div>
      {EDITABLE_TOKENS.map((grp) => (
        <div key={grp.group} className="theme-token-group">
          <div className="set-group-title">{t(THEME_GROUP_KEYS[grp.group])}</div>
          <div className="theme-token-grid">
            {grp.tokens.map((tk) => (
              <div key={tk} className="theme-token">
                <ColorField
                  value={tokens[tk] ?? '#000000'}
                  defaultValue={DEFAULT_TOKENS[tk] ?? '#000000'}
                  onChange={(v) => setTokens((prev) => ({ ...prev, [tk]: v }))}
                />
                {/* the token name is developer vocabulary; the label says what it PAINTS and
                    the hover says where you will actually see it change */}
                <span title={`${t(TOKEN_HINTS[tk])}

${tk}`}>{t(TOKEN_LABELS[tk])}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="theme-token-group">
        <div className="set-group-title">{t('theme.group.shape')}</div>
        <div className="set-row">
          <label className="has-hint" title={t('hint.uiRadius')}>{t('set.uiRadius')}</label>
          {/* one slider drives the whole radius scale — a control that reached only some of
              the corners would look worse than not having one */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range"
              min={0}
              max={200}
              step={10}
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
              style={{ width: 150 }}
            />
            <span className="hint" style={{ minWidth: 38, textAlign: 'right' }}>{radius}%</span>
          </div>
        </div>
      </div>
      <div className="theme-token-group">
        <div className="set-group-title">{t('set.group.tabs')}</div>
        <p className="hint" style={{ color: 'var(--text-faint)', margin: '0 0 6px' }}>
          {t('hint.tabColors')}
        </p>
        <div className="theme-token-grid">
          {TAB_COLOR_FIELDS.map(([key, label, def]) => (
            <div key={String(key)} className="theme-token">
              <ColorField
                value={tabColors[key] ?? tokens[def] ?? DEFAULT_TOKENS[def]}
                defaultValue={tokens[def] ?? DEFAULT_TOKENS[def]}
                onChange={(v) => setTabColors((prev) => ({ ...prev, [key]: v }))}
              />
              <span>{t(label)}</span>
            </div>
          ))}
        </div>
      </div>
      {/* Sticky, so on a palette this long the way out is never scrolled off screen. Save and
          cancel sit together on the left; "reset colours" throws away everything you just did,
          so it is pushed to the far right where it cannot be hit by accident. */}
      <div className="theme-editor-foot">
        <button
          className="primary"
          onClick={() =>
            onSave({
              id: draft.id,
              name: name.trim() || draft.name,
              dark,
              tokens: deriveTokens(tokens, dark),
              radius,
              tabColors
            })
          }
        >
          {t('theme.save')}
        </button>
        <button onClick={onCancel}>{t('theme.cancel')}</button>
        <button
          className="ghost theme-editor-reset"
          title={t('hint.themeReset')}
          onClick={() => {
            setTokens({ ...DEFAULT_TOKENS })
            setRadius(100)
            setTabColors({})
          }}
        >
          {t('theme.reset')}
        </button>
      </div>
    </div>
  )
}

/** tab colour field -> label, and the THEME token it falls back to when the theme says
 *  nothing about tabs. Seeding from the theme's own surfaces is why an untouched theme's
 *  tabs look right before the user has picked anything. */
const TAB_COLOR_FIELDS: [keyof TabColors, TranslationKey, string][] = [
  ['bg', 'tab.color.bg', '--surface'],
  ['text', 'tab.color.text', '--text-muted'],
  ['border', 'tab.color.border', '--border'],
  ['hoverBg', 'tab.color.hoverBg', '--surface-3'],
  ['activeBg', 'tab.color.activeBg', '--surface-2'],
  ['activeText', 'tab.color.activeText', '--text'],
  ['activeBorder', 'tab.color.activeBorder', '--border']
]

/**
 * The scale slider for the window it is drawn in.
 *
 * It cannot apply while you drag: the control resizes the window it lives in, so the thumb
 * slides out from under the cursor and the pointer ends up somewhere else entirely — the
 * scale becomes almost impossible to set. It shows the value live and commits on release.
 */
function WindowScaleSlider(): React.JSX.Element {
  const saved = useSettingsStore((s) => s.settings.windowScales?.settings ?? 100)
  const [draft, setDraft] = useState<number | null>(null)
  const value = draft ?? saved

  const commit = (v: number): void => {
    setDraft(null)
    const st = useSettingsStore.getState()
    st.setSettings({
      windowScales: { ...st.settings.windowScales, settings: clampUiScale(v) }
    })
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        type="range"
        min={UI_SCALE_MIN}
        max={UI_SCALE_MAX}
        step={10}
        value={value}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={(e) => commit(Number(e.currentTarget.value))}
        onKeyUp={(e) => commit(Number(e.currentTarget.value))}
        onBlur={(e) => commit(Number(e.currentTarget.value))}
        style={{ width: 150 }}
      />
      <span className="hint" style={{ minWidth: 38, textAlign: 'right' }}>
        {value}%
      </span>
    </div>
  )
}

/** export part -> its label */
const CONFIG_PART_LABELS: Record<ConfigPart, TranslationKey> = {
  appearance: 'io.part.appearance',
  chat: 'io.part.chat',
  notifications: 'io.part.notifications',
  highlightRules: 'io.part.highlightRules',
  modButtons: 'io.part.modButtons',
  favoriteEmotes: 'io.part.favoriteEmotes',
  overlays: 'io.part.overlays',
  hotkeys: 'io.part.hotkeys',
  other: 'io.part.other'
}

/** token -> i18n key. Typed lookups rather than template strings so a missing label is a
 *  compile error instead of a raw "--surface-2" leaking into the UI */
const TOKEN_LABELS: Record<string, TranslationKey> = {
  '--bg': 'token.bg',
  '--surface': 'token.surface',
  '--surface-2': 'token.surface2',
  '--surface-3': 'token.surface3',
  '--border': 'token.border',
  '--text': 'token.text',
  '--text-muted': 'token.textMuted',
  '--text-faint': 'token.textFaint',
  '--system-text': 'token.systemText',
  '--accent': 'token.accent',
  '--accent-strong': 'token.accentStrong',
  '--accent-text': 'token.accentText',
  '--link': 'token.link',
  '--danger': 'token.danger',
  '--success': 'token.success',
  '--warning': 'token.warning',
  '--live': 'token.live',
  '--scrollbar': 'token.scrollbar',
  '--msg-separator': 'token.msgSeparator'
}

/** one line per token saying where in the app it shows up — a colour picker with no idea
 *  what it repaints is a guessing game */
const TOKEN_HINTS: Record<string, TranslationKey> = {
  '--bg': 'token.bg.hint',
  '--surface': 'token.surface.hint',
  '--surface-2': 'token.surface2.hint',
  '--surface-3': 'token.surface3.hint',
  '--border': 'token.border.hint',
  '--text': 'token.text.hint',
  '--text-muted': 'token.textMuted.hint',
  '--text-faint': 'token.textFaint.hint',
  '--system-text': 'token.systemText.hint',
  '--accent': 'token.accent.hint',
  '--accent-strong': 'token.accentStrong.hint',
  '--accent-text': 'token.accentText.hint',
  '--link': 'token.link.hint',
  '--danger': 'token.danger.hint',
  '--success': 'token.success.hint',
  '--warning': 'token.warning.hint',
  '--live': 'token.live.hint',
  '--scrollbar': 'token.scrollbar.hint',
  '--msg-separator': 'token.msgSeparator.hint'
}

/** group id -> i18n key, so the lookup stays typed instead of a template string */
const THEME_GROUP_KEYS: Record<string, TranslationKey> = {
  base: 'theme.group.base',
  text: 'theme.group.text',
  accent: 'theme.group.accent',
  state: 'theme.group.state',
  misc: 'theme.group.misc'
}

function AppearanceSection(): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  return (
    <Framed>
      <div className="set-group-title">{t('set.group.general')}</div>
      <ThemeSection />
      <div className="set-row">
        <label className="has-hint" title={t('hint.uiScale')}>{t('set.uiScale')}</label>
        <WindowScaleSlider />
      </div>
      <div className="set-row">
        <label>{t('set.fontFamily')}</label>
        <FontPicker value={settings.fontFamily} onChange={(v) => set({ fontFamily: v })} />
      </div>
      <div className="set-row">
        <label>{t('set.fontSize')}</label>
        <NumberField
          min={10}
          max={CHAT_FONT_MAX}
          width={70}
          value={settings.fontSize}
          onChange={(v) => set({ fontSize: v })}
        />
      </div>
      <div className="set-group-title">{t('set.group.emotes')}</div>
      <div className="set-row">
        <label>{t('set.emoteScale')}</label>
        <select value={String(settings.emoteScale)} onChange={(e) => set({ emoteScale: parseFloat(e.target.value) })}>
          <option value="0.75">75%</option>
          <option value="1">100%</option>
          <option value="1.25">125%</option>
          <option value="1.5">150%</option>
          <option value="2">200%</option>
        </select>
      </div>
      <div className="set-row">
        <label>{t('set.badgeSize')}</label>
        <input
          type="number"
          min={12}
          max={32}
          style={{ width: 70 }}
          value={settings.badgeSize}
          onChange={(e) => set({ badgeSize: parseInt(e.target.value, 10) || 18 })}
        />
      </div>
      <div className="set-row" title={t('hint.emojiNameLang')}>
        <label>{t('set.emojiNameLang')}</label>
        <select
          value={settings.emojiNameLang}
          onChange={(e) => set({ emojiNameLang: e.target.value as Settings['emojiNameLang'] })}
        >
          <option value="uk">Українська</option>
          <option value="en">English</option>
          <option value="both">{t('set.emojiNameLang.both')}</option>
        </select>
      </div>
      <div className="set-row" title={t('hint.chatHoverSize')}>
        <label className="has-hint">{t('set.chatHoverSize')}</label>
        <input
          type="number"
          min={48}
          max={320}
          style={{ width: 70 }}
          value={settings.chatEmoteHoverSize}
          onChange={(e) => set({ chatEmoteHoverSize: parseInt(e.target.value, 10) || 128 })}
        />
      </div>
    </Framed>
  )
}

// One command per line so a command may contain spaces/commas (e.g. "!followage @user").
// Uses a local text buffer committed on blur so editing never re-collapses your whitespace.
function BotCommandsEditor(): React.JSX.Element {
  const stored = useSettingsStore((s) => s.settings.botCommands)
  const set = useSettingsStore((s) => s.setSettings)
  const [buf, setBuf] = useState(stored.join('\n'))
  // resync the buffer when the underlying list changes from elsewhere (e.g. settings import)
  const storedKey = stored.join('\n')
  useEffect(() => setBuf(storedKey), [storedKey])
  const commit = (): void => {
    const list = buf
      .split('\n')
      .map((w) => w.trim())
      .filter(Boolean)
      .map((w) => (w.startsWith('!') ? w : `!${w}`))
    set({ botCommands: list })
    setBuf(list.join('\n'))
  }
  return (
    <textarea
      rows={4}
      style={{ flex: 1, resize: 'vertical' }}
      placeholder={'!followage\n!points\n!song request'}
      value={buf}
      spellCheck={false}
      onChange={(e) => setBuf(e.target.value)}
      onBlur={commit}
    />
  )
}

function ChatSection(): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  return (
    <Framed>
      <div className="set-group-title">{t('set.group.messageLine')}</div>
      <Toggle label={t('set.timestamps')} hint={t('hint.timestamps')} value={settings.showTimestamps} onChange={(v) => set({ showTimestamps: v })} />
      {settings.showTimestamps && (
        <div className="set-sub">
          <Toggle label={t('set.timestampSeconds')} value={settings.timestampSeconds} onChange={(v) => set({ timestampSeconds: v })} />
        </div>
      )}
      <Toggle label={t('set.altBg')} hint={t('hint.altBg')} value={settings.alternatingBackground} onChange={(v) => set({ alternatingBackground: v })} />
      <Toggle label={t('set.msgSeparators')} hint={t('hint.msgSeparators')} value={settings.messageSeparators} onChange={(v) => set({ messageSeparators: v })} />
      <div className="set-group-title">{t('set.group.chatPane')}</div>
      <Toggle label={t('set.streamInfo')} hint={t('hint.streamInfo')} value={settings.showStreamInfo} onChange={(v) => set({ showStreamInfo: v })} />
      <Toggle label={t('set.smoothChatScroll')} hint={t('hint.smoothChatScroll')} value={settings.smoothChatScroll} onChange={(v) => set({ smoothChatScroll: v })} />
      <div className="set-group-title">{t('set.group.links')}</div>
      <div className="set-row" title={t('hint.linkDisplay')}>
        <label className="has-hint">{t('set.linkDisplay')}</label>
        <select value={settings.linkDisplay} onChange={(e) => set({ linkDisplay: e.target.value as Settings['linkDisplay'] })}>
          <option value="full">{t('set.linkDisplay.full')}</option>
          <option value="short">{t('set.linkDisplay.short')}</option>
          <option value="overlayShort">{t('set.linkDisplay.overlayShort')}</option>
        </select>
      </div>
      <div className="set-block">
      <Toggle label={t('set.linkPreviews')} hint={t('hint.linkPreviews')} value={settings.linkPreviews} onChange={(v) => set({ linkPreviews: v })} />
      {/*
        On touch this is one switch and no sub-options. Everything under here is about a pointer —
        open on hover, how big the floating card is, where it sits — and on a phone the answer to all
        of them is fixed: the tag after the link is the preview, and tapping it opens the card.
      */}
      {settings.linkPreviews && !isMobile() && (
        <div className="set-sub">
          <Toggle
            label={t('set.linkPreviewsClipsOnly')}
            hint={t('hint.linkPreviewsClipsOnly')}
            value={settings.linkPreviewsClipsOnly}
            onChange={(v) => set({ linkPreviewsClipsOnly: v })}
          />
          <Toggle
            label={t('set.linkPreviewsExpanded')}
            hint={t('hint.linkPreviewsExpanded')}
            value={settings.linkPreviewsExpanded}
            onChange={(v) => set({ linkPreviewsExpanded: v })}
          />
          <Toggle
            label={t('set.linkHoverPreview')}
            hint={t('hint.linkHoverPreview')}
            value={settings.linkHoverPreview}
            onChange={(v) => set({ linkHoverPreview: v })}
          />
          {settings.linkHoverPreview && (
            <>
              <Toggle
                label={t('set.linkHoverImagesOnly')}
                hint={t('hint.linkHoverImagesOnly')}
                value={settings.linkHoverImagesOnly}
                onChange={(v) => set({ linkHoverImagesOnly: v })}
              />
              <div className="set-row" title={t('hint.linkHoverSize')}>
                <label className="has-hint">{t('set.linkHoverSize')}</label>
                <NumberField value={settings.linkHoverSize} min={120} max={1400} step={20} width={80} onChange={(n) => set({ linkHoverSize: n })} />
              </div>
            </>
          )}
          <div className="set-row" title={t('hint.linkPreviewScale')}>
            <label className="has-hint">{t('set.linkPreviewScale')}</label>
            <NumberField value={settings.linkPreviewScale} min={50} max={150} step={5} width={80} onChange={(n) => set({ linkPreviewScale: n })} />
          </div>
        </div>
      )}
      </div>
      <div className="set-group-title">{t('set.group.events')}</div>
      <Toggle label={t('set.showBits')} hint={t('hint.showBits')} value={settings.showBits} onChange={(v) => set({ showBits: v })} />
      <Toggle label={t('set.showRedeems')} hint={t('hint.showRedeems')} value={settings.showRedeems} onChange={(v) => set({ showRedeems: v })} />
      <Toggle
        label={t('set.announceFollows')}
        hint={t('hint.announceFollows')}
        value={settings.announceFollows}
        onChange={(v) => set({ announceFollows: v })}
      />
      <div className="set-group-title">{t('set.group.input')}</div>
      <div className="set-row" title={t('hint.inputAccountDisplay')}>
        <label className="has-hint">{t('set.inputAccountDisplay')}</label>
        <select
          value={settings.inputAccountDisplay}
          onChange={(e) => set({ inputAccountDisplay: e.target.value as Settings['inputAccountDisplay'] })}
        >
          <option value="name">{t('set.inputAccountDisplay.name')}</option>
          <option value="avatar">{t('set.inputAccountDisplay.avatar')}</option>
        </select>
      </div>
      <div className="set-group-title">{t('set.group.density')}</div>
      <Toggle label={t('set.history')} hint={t('hint.history')} value={settings.loadHistory} onChange={(v) => set({ loadHistory: v })} />
      <div className="set-row" title={t('hint.lineSpacing')}>
        <label>{t('set.lineSpacing')}</label>
        <input
          type="number"
          min={0}
          max={24}
          style={{ width: 70 }}
          value={settings.lineSpacing}
          onChange={(e) => set({ lineSpacing: parseInt(e.target.value, 10) || 0 })}
        />
      </div>
      <div className="set-row" title={t('hint.messageSpacing')}>
        <label>{t('set.messageSpacing')}</label>
        <input
          type="number"
          min={0}
          max={20}
          style={{ width: 70 }}
          value={settings.messageSpacing}
          onChange={(e) => set({ messageSpacing: parseInt(e.target.value, 10) || 0 })}
        />
      </div>
      <div className="set-group-title">{t('input.send')}</div>
      <Toggle label={t('set.emoteSuggestions')} hint={t('hint.emoteSuggestions')} value={settings.emoteSuggestions} onChange={(v) => set({ emoteSuggestions: v })} />
      <div className="set-row" style={{ alignItems: 'flex-start' }} title={t('hint.botCommands')}>
        <label className="has-hint">{t('set.botCommands')}</label>
        <BotCommandsEditor />
      </div>
      <Toggle label={t('set.charCounter')} hint={t('hint.charCounter')} value={settings.showCharCounter} onChange={(v) => set({ showCharCounter: v })} />
      <Toggle
        label={
          <>
            {t('set.translit')} <TranslitIcon size={16} /> {t('set.translit.suffix')}
          </>
        }
        hint={t('hint.translit')}
        value={settings.translitEnabled}
        onChange={(v) => set({ translitEnabled: v })}
      />
      {settings.translitEnabled && (
        <div className="set-row" style={{ alignItems: 'flex-start' }} title={t('hint.translitExclude')}>
          <label className="has-hint">{t('set.translitExclude')}</label>
          <textarea
            rows={2}
            style={{ flex: 1, resize: 'vertical' }}
            placeholder="!followage, !drop"
            value={settings.translitExcludeWords.join(', ')}
            spellCheck={false}
            onChange={(e) =>
              set({ translitExcludeWords: e.target.value.split(',').map((w) => w.trim()).filter(Boolean) })
            }
          />
        </div>
      )}
      <Toggle label={t('set.caseSensitiveNicks')} hint={t('hint.caseSensitiveNicks')} value={settings.caseSensitiveNicks} onChange={(v) => set({ caseSensitiveNicks: v })} />
      <Toggle label={t('set.sevenTvColors')} hint={t('hint.sevenTvColors')} value={settings.sevenTvNickColors} onChange={(v) => set({ sevenTvNickColors: v })} />
      <Toggle label={t('set.announceEmoteChanges')} hint={t('hint.announceEmoteChanges')} value={settings.announceEmoteChanges} onChange={(v) => set({ announceEmoteChanges: v })} />
      {settings.mutedErrors.length > 0 && (
        <div className="set-row" title={t('hint.mutedErrors')}>
          <label className="has-hint">{t('set.mutedErrors')}</label>
          <button onClick={() => set({ mutedErrors: [] })}>
            {t('set.mutedErrors.clear', { n: settings.mutedErrors.length })}
          </button>
        </div>
      )}
      <Toggle label={t('set.bypassDuplicateLimit')} hint={t('hint.bypassDuplicateLimit')} value={settings.bypassDuplicateLimit} onChange={(v) => set({ bypassDuplicateLimit: v })} />
      <Toggle label={t('set.colorBareNicks')} hint={t('hint.colorBareNicks')} value={settings.colorBareNicks} onChange={(v) => set({ colorBareNicks: v })} />
      <Toggle label={t('set.thirdPartyBadges')} hint={t('hint.thirdPartyBadges')} value={settings.showThirdPartyBadges} onChange={(v) => set({ showThirdPartyBadges: v })} />
      <div className="set-group-title">{t('highlights.title')}</div>
      <Toggle
        label={t('set.highlightSidebar')}
        hint={t('hint.highlightSidebar')}
        value={settings.showHighlightSidebar}
        onChange={(v) => set({ showHighlightSidebar: v })}
      />
      <div className="set-row" title={t('hint.sidebarDefault')}>
        <label>{t('set.sidebarDefault')}</label>
        <select
          value={settings.highlightSidebarDefault}
          onChange={(e) => set({ highlightSidebarDefault: e.target.value as Settings['highlightSidebarDefault'] })}
        >
          <option value="highlights">{t('highlights.title')}</option>
          <option value="mentions">{t('highlights.mentions')}</option>
          <option value="redeems">{t('highlights.redeems')}</option>
        </select>
      </div>
    </Framed>
  )
}

function NotificationsSection(): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  return (
    <Framed>
      <div className="set-group-title">{t('set.group.chatAlerts')}</div>
      {/* the cooldown applies to every alert below, so it sits above them rather than between
          the mention switch and the mention sound where it read as a mention option */}
      <Toggle
        label={t('set.alertSoundCooldown')}
        hint={t('hint.alertSoundCooldown')}
        value={settings.alertSoundCooldown}
        onChange={(v) => set({ alertSoundCooldown: v })}
      />
      {/* one card per alert: the box answers "which rows belong to which switch" */}
      <div className="set-block">
        <Toggle label={t('set.mentionSound')} hint={t('hint.mentionSound')} value={settings.mentionSound} onChange={(v) => set({ mentionSound: v })} />
        {settings.mentionSound && (
          <div className="set-sub">
            <Toggle
              label={t('set.soundOnActive')}
              hint={t('hint.soundOnActive')}
              value={settings.mentionSoundOnActive}
              onChange={(v) => set({ mentionSoundOnActive: v })}
            />
            <SoundSettings kind="mention" />
          </div>
        )}
      </div>
      <div className="set-block">
        <Toggle
          label={t('set.firstMessageSound')}
          hint={t('hint.firstMessageSound')}
          value={settings.firstMessageSound}
          onChange={(v) => set({ firstMessageSound: v })}
        />
        {settings.firstMessageSound && (
          <div className="set-sub">
            <SoundSettings kind="firstMessage" />
          </div>
        )}
      </div>
      <div className="set-block">
        <Toggle label={t('set.keywordSound')} hint={t('hint.keywordSound')} value={settings.keywordSound} onChange={(v) => set({ keywordSound: v })} />
        {settings.keywordSound && (
          <div className="set-sub">
            <div className="set-row" style={{ alignItems: 'flex-start' }}>
              <label>{t('set.keywords')}</label>
              <textarea
                rows={4}
                style={{ flex: 1, resize: 'vertical' }}
                placeholder={t('set.keywords.placeholder')}
                value={settings.keywordAlerts.join('\n')}
                onChange={(e) => set({ keywordAlerts: e.target.value.split('\n') })}
                onBlur={(e) =>
                  set({ keywordAlerts: e.target.value.split('\n').map((w) => w.trim()).filter(Boolean) })
                }
              />
            </div>
            <Toggle
              label={t('set.wholeWord')}
              hint={t('hint.wholeWord')}
              value={settings.keywordWholeWord}
              onChange={(v) => set({ keywordWholeWord: v })}
            />
            <Toggle
              label={t('set.soundOnActive')}
              hint={t('hint.soundOnActive')}
              value={settings.keywordSoundOnActive}
              onChange={(v) => set({ keywordSoundOnActive: v })}
            />
            <SoundSettings kind="keyword" />
          </div>
        )}
      </div>
      {/* same matching as keywords, separate list + separate sound: being called by name is
          a different kind of ping than a topic word */}
      <div className="set-block">
      <Toggle label={t('set.nickAlertSound')} hint={t('hint.nickAlertSound')} value={settings.nickAlertSound} onChange={(v) => set({ nickAlertSound: v })} />
      {settings.nickAlertSound && (
        <div className="set-sub">
          <div className="set-row" style={{ alignItems: 'flex-start' }}>
            <label>{t('set.nickAlerts')}</label>
            <textarea
              rows={3}
              style={{ flex: 1, resize: 'vertical' }}
              placeholder={t('set.nickAlerts.placeholder')}
              value={settings.nickAlerts.join('\n')}
              onChange={(e) => set({ nickAlerts: e.target.value.split('\n') })}
              onBlur={(e) =>
                set({ nickAlerts: e.target.value.split('\n').map((w) => w.trim()).filter(Boolean) })
              }
            />
          </div>
          <Toggle
            label={t('set.wholeWord')}
            hint={t('hint.wholeWord')}
            value={settings.nickAlertWholeWord}
            onChange={(v) => set({ nickAlertWholeWord: v })}
          />
          <Toggle
            label={t('set.soundOnActive')}
            hint={t('hint.soundOnActive')}
            value={settings.nickAlertSoundOnActive}
            onChange={(v) => set({ nickAlertSoundOnActive: v })}
          />
          <SoundSettings kind="nickAlert" />
        </div>
      )}
      </div>
      <div className="set-group-title">{t('whisper.title')}</div>
      <div className="set-block">
        <Toggle label={t('set.whisperSound')} hint={t('hint.whisperSound')} value={settings.whisperSound} onChange={(v) => set({ whisperSound: v })} />
        {settings.whisperSound && (
          <div className="set-sub">
            <SoundSettings kind="whisper" />
          </div>
        )}
        <Toggle label={t('set.whisperNotify')} hint={t('hint.whisperNotify')} value={settings.whisperNotify} onChange={(v) => set({ whisperNotify: v })} />
      </div>
      <div className="set-group-title">{t('set.group.streamUp')}</div>
      <div className="set-block">
        <Toggle label={t('set.streamUpNotify')} hint={t('hint.streamUp')} value={settings.streamUpNotify} onChange={(v) => set({ streamUpNotify: v })} />
        <Toggle label={t('set.streamUpSound')} hint={t('hint.streamUp')} value={settings.streamUpSound} onChange={(v) => set({ streamUpSound: v })} />
        {settings.streamUpSound && (
          <div className="set-sub">
            <SoundSettings kind="streamUp" />
          </div>
        )}
      </div>
      <div className="set-group-title">{t('mod.raid')}</div>
      <Toggle label={t('set.raidPrompt')} hint={t('hint.raidPrompt')} value={settings.raidPrompt} onChange={(v) => set({ raidPrompt: v })} />
      <Toggle label={t('set.raidSound')} value={settings.raidSound} onChange={(v) => set({ raidSound: v })} />
      {settings.raidSound && <SoundSettings kind="raid" />}
      {settings.raidPrompt && (
        <>
          <div className="set-row">
            <label>{t('set.raidDest')}</label>
            <select value={settings.raidPromptDest} onChange={(e) => set({ raidPromptDest: e.target.value as 'tabs' | 'split' })}>
              <option value="split">{t('set.raidDest.split')}</option>
              <option value="tabs">{t('set.raidDest.tabs')}</option>
            </select>
          </div>
          <Toggle
            label={t('set.raidActiveOnly')}
            hint={t('hint.raidActiveOnly')}
            value={settings.raidPromptActiveOnly}
            onChange={(v) => set({ raidPromptActiveOnly: v })}
          />
        </>
      )}
      <div className="set-group-title">{t('hype.title')}</div>
      <div className="set-block">
        <Toggle label={t('set.hypeTrainLine')} hint={t('hint.hypeTrainLine')} value={settings.hypeTrainLine} onChange={(v) => set({ hypeTrainLine: v })} />
        <Toggle label={t('set.hypeTrainPopup')} hint={t('hint.hypeTrainPopup')} value={settings.hypeTrainPopup} onChange={(v) => set({ hypeTrainPopup: v })} />
        {settings.hypeTrainPopup && (
          <div className="set-sub">
            {/* trains are rare, and three of the four flavours are rarer still — without this
                you would have to wait for a real one to find out whether you want the popup,
                where it lands, and what each kind looks like */}
            <div className="set-sub-title">{t('set.hypeTrainPreviewKind')}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {HYPE_KINDS.map((k) => (
                <button key={k} className="ghost" onClick={() => showHypeTrainDemo(k)}>
                  {t(`hype.kind.${k}` as Parameters<typeof t>[0])}
                </button>
              ))}
            </div>
          </div>
        )}
        <Toggle label={t('set.hypeTrainSound')} value={settings.hypeTrainSound} onChange={(v) => set({ hypeTrainSound: v })} />
        {settings.hypeTrainSound && (
          <div className="set-sub">
            <div className="set-sub-title">{t('set.hypeTrainInactive')}</div>
            <p className="hint" style={{ marginTop: 0 }}>{t('hint.hypeTrainInactive')}</p>
            {HYPE_KINDS.map((k) => (
              <Toggle
                key={k}
                label={t(`hype.kind.${k}` as Parameters<typeof t>[0])}
                hint={t(`hype.kind.${k}.hint` as Parameters<typeof t>[0])}
                value={settings.hypeTrainInactiveKinds.includes(k)}
                onChange={(v) =>
                  set({
                    hypeTrainInactiveKinds: v
                      ? [...settings.hypeTrainInactiveKinds, k]
                      : settings.hypeTrainInactiveKinds.filter((x) => x !== k)
                  })
                }
              />
            ))}
            <div className="set-sub-title">{t('set.hypeTrainStartSound')}</div>
            <SoundSettings kind="hypeTrainStart" />
            <div className="set-sub-title">{t('set.hypeTrainLevelSound')}</div>
            <SoundSettings kind="hypeTrainLevel" />
          </div>
        )}
      </div>
      <div className="set-group-title">{t('set.group.errors')}</div>
      <Toggle label={t('set.errorSound')} hint={t('hint.errorSound')} value={settings.errorSound} onChange={(v) => set({ errorSound: v })} />
      {settings.errorSound && <SoundSettings kind="error" />}
    </Framed>
  )
}

function WindowsSection(): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  return (
    <Framed>
      <div className="set-group-title">{t('set.group.general')}</div>
      <Toggle
        label={t('set.alwaysOnTop')}
        hint={t('hint.alwaysOnTop')}
        value={settings.alwaysOnTop}
        onChange={(v) => set({ alwaysOnTop: v })}
      />
      <Toggle
        label={t('set.rememberWindowSize')}
        hint={t('hint.rememberWindowSize')}
        value={settings.rememberWindowSize}
        onChange={(v) => set({ rememberWindowSize: v })}
      />
      <Toggle
        label={t('set.rememberPin')}
        hint={t('hint.rememberPin')}
        value={settings.rememberPinState}
        onChange={(v) => set({ rememberPinState: v })}
      />
      <div className="set-group-title">{t('set.title')}</div>
      <Toggle
        label={t('set.settingsAsWindow')}
        hint={t('hint.settingsAsWindow')}
        value={settings.settingsAsWindow}
        onChange={(v) => set({ settingsAsWindow: v })}
      />
      <div className="set-group-title">{t('user.viewercard')}</div>
      <Toggle
        label={t('set.usercardAsWindow')}
        hint={t('hint.usercardAsWindow')}
        value={settings.usercardAsWindow}
        onChange={(v) => set({ usercardAsWindow: v })}
      />
      <div className="set-group-title">{t('whisper.title')}</div>
      <Toggle
        label={t('set.whispersAsWindow')}
        value={settings.whispersAsWindow}
        onChange={(v) => set({ whispersAsWindow: v })}
      />
      <div className="set-group-title">{t('highlights.title')}</div>
      <Toggle
        label={t('set.highlightsAsWindow')}
        value={settings.highlightsAsWindow}
        onChange={(v) => set({ highlightsAsWindow: v })}
      />
      <div className="set-group-title">{t('picker.open')}</div>
      <Toggle
        label={t('set.emotePickerAsWindow')}
        hint={t('hint.emotePickerAsWindow')}
        value={settings.emotePickerAsWindow}
        onChange={(v) => set({ emotePickerAsWindow: v })}
      />
      <div className="set-row">
        <label>{t('set.pickerDefaultTab')}</label>
        <select
          value={settings.emotePickerDefaultTab}
          onChange={(e) => set({ emotePickerDefaultTab: e.target.value as typeof settings.emotePickerDefaultTab })}
        >
          <option value="favorites">{t('picker.favorites')}</option>
          <option value="twitch">Twitch</option>
          <option value="thirdparty">7TV · BTTV · FFZ</option>
        </select>
      </div>
      <div className="set-row">
        <label>{t('set.previewSize')}</label>
        <input
          type="number"
          min={48}
          max={256}
          style={{ width: 70 }}
          value={settings.emotePreviewSize}
          onChange={(e) => set({ emotePreviewSize: parseInt(e.target.value, 10) || 112 })}
        />
      </div>
    </Framed>
  )
}

/**
 * A demo train for the preview button: it climbs a level, then rolls away.
 *
 * Deliberately drives the same store the real one does, so what you see here is exactly what a
 * real train looks like — including the sound, if it is switched on.
 */
const HYPE_KINDS = ['regular', 'shared', 'golden', 'community'] as const

function showHypeTrainDemo(flavour: (typeof HYPE_KINDS)[number] = 'regular'): void {
  const ui = useUiStore.getState()
  const settings = useSettingsStore.getState().settings
  const base = { channel: 'preview', flavour, goal: 1000, by: 'Bobik069' }
  ui.setHypeTrain({ ...base, level: 2, value: 350, expiresAt: Date.now() + 300_000 })
  if (settings.hypeTrainSound) playHypeTrainStartSound(settings, true)
  const steps = [
    { at: 1200, patch: { level: 2, value: 800 } },
    { at: 2600, patch: { level: 3, value: 200 }, levelUp: true },
    { at: 4200, patch: { level: 3, value: 700 } }
  ]
  for (const s of steps) {
    window.setTimeout(() => {
      const cur = useUiStore.getState().hypeTrain
      if (cur?.channel !== 'preview') return
      ui.setHypeTrain({ ...cur, ...s.patch })
      // so the preview also answers "what do I hear when it climbs a level?"
      if (s.levelUp && settings.hypeTrainSound) playHypeTrainLevelSound(settings, true)
    }, s.at)
  }
  /**
   * …and then it ends, because that is half of what the preview is for.
   *
   * The demo used to simply vanish, so the one part nobody sees until a real train finishes —
   * the wheelspin, the sparks and the departure — was the part you could not preview.
   */
  window.setTimeout(() => {
    const cur = useUiStore.getState().hypeTrain
    if (cur?.channel === 'preview') ui.setHypeTrain({ ...cur, ended: 'COMPLETED' })
  }, 5800)
  window.setTimeout(() => {
    const cur = useUiStore.getState().hypeTrain
    if (cur?.channel === 'preview') ui.setHypeTrain(null)
  }, 11500)
}

type SoundKind =
  | 'mention' | 'firstMessage' | 'keyword' | 'nickAlert' | 'streamUp' | 'whisper' | 'raid'
  | 'hypeTrainStart' | 'hypeTrainLevel' | 'error'

const SOUND_KEYS = {
  mention: { type: 'mentionSoundType', volume: 'mentionSoundVolume', customId: 'mentionSoundCustomId' },
  firstMessage: {
    type: 'firstMessageSoundType',
    volume: 'firstMessageSoundVolume',
    customId: 'firstMessageSoundCustomId'
  },
  keyword: { type: 'keywordSoundType', volume: 'keywordSoundVolume', customId: 'keywordSoundCustomId' },
  nickAlert: { type: 'nickAlertSoundType', volume: 'nickAlertSoundVolume', customId: 'nickAlertSoundCustomId' },
  streamUp: { type: 'streamUpSoundType', volume: 'streamUpSoundVolume', customId: 'streamUpSoundCustomId' },
  whisper: { type: 'whisperSoundType', volume: 'whisperSoundVolume', customId: 'whisperSoundCustomId' },
  raid: { type: 'raidSoundType', volume: 'raidSoundVolume', customId: 'raidSoundCustomId' },
  hypeTrainStart: {
    type: 'hypeTrainStartSoundType',
    volume: 'hypeTrainStartSoundVolume',
    customId: 'hypeTrainStartSoundCustomId'
  },
  hypeTrainLevel: {
    type: 'hypeTrainLevelSoundType',
    volume: 'hypeTrainLevelSoundVolume',
    customId: 'hypeTrainLevelSoundCustomId'
  },
  error: { type: 'errorSoundType', volume: 'errorSoundVolume', customId: 'errorSoundCustomId' }
} as const

const SOUND_PLAYERS: Record<SoundKind, (s: Settings, force?: boolean) => void> = {
  mention: playMentionSound,
  firstMessage: playFirstMessageSound,
  keyword: playKeywordSound,
  nickAlert: playNickAlertSound,
  streamUp: playStreamUpSound,
  whisper: playWhisperSound,
  raid: playRaidSound,
  hypeTrainStart: playHypeTrainStartSound,
  hypeTrainLevel: playHypeTrainLevelSound,
  error: (_s, force) => playErrorSound(force)
}

function SoundSettings({ kind }: { kind: SoundKind }): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const toast = useUiStore.getState().toast

  const typeKey = SOUND_KEYS[kind].type
  const volumeKey = SOUND_KEYS[kind].volume
  const customIdKey = SOUND_KEYS[kind].customId
  const type = settings[typeKey]
  const volume = settings[volumeKey]
  const customId = settings[customIdKey]
  const play = (force: boolean): void => SOUND_PLAYERS[kind](settings, force)

  // the <select> encodes built-in presets as-is, and custom sounds as "custom:{id}"
  const selectValue = type === 'custom' && customId ? `custom:${customId}` : type
  const onSelectChange = (value: string): void => {
    if (value.startsWith('custom:')) {
      set({ [typeKey]: 'custom', [customIdKey]: value.slice(7) } as Partial<Settings>)
    } else {
      set({ [typeKey]: value } as Partial<Settings>)
    }
  }

  const uploadSound = (file: File | undefined): void => {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      toast(t('set.sound.tooBig'), 'error')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const entry = { id: nextId('snd'), name: file.name.replace(/\.[a-z0-9]+$/i, ''), data: String(reader.result) }
      const fresh = useSettingsStore.getState().settings
      set({ customSounds: [...fresh.customSounds, entry], [typeKey]: 'custom', [customIdKey]: entry.id } as Partial<Settings>)
      SOUND_PLAYERS[kind](useSettingsStore.getState().settings, true)
    }
    reader.onerror = () => toast('Не вдалося прочитати файл', 'error')
    reader.readAsDataURL(file)
  }

  const removeCustomSound = (id: string): void => {
    set({ customSounds: settings.customSounds.filter((c) => c.id !== id) })
    if (customId === id) set({ [typeKey]: 'ping', [customIdKey]: undefined } as Partial<Settings>)
  }

  return (
    <div className="set-sub">
      <div className="set-row">
        <label>{t('set.sound.type')}</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select value={selectValue} onChange={(e) => onSelectChange(e.target.value)}>
            {SOUND_PRESETS.map((p) => (
              <option key={p} value={p}>
                {t(`set.sound.${p}`)}
              </option>
            ))}
            {settings.customSounds.map((c) => (
              <option key={c.id} value={`custom:${c.id}`}>
                {c.name}
              </option>
            ))}
          </select>
          <button onClick={() => play(true)} title={t('set.sound.preview')}>
            <PlayIcon />
          </button>
          {/* delete the currently-selected uploaded sound right here — no bulky bottom list */}
          {type === 'custom' && customId && (
            <button className="danger" title={t('set.sound.delete')} onClick={() => removeCustomSound(customId)}>
              <TrashIcon />
            </button>
          )}
        </div>
      </div>
      <div className="set-row">
        <label>{t('set.sound.volume')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(e) => set({ [volumeKey]: parseInt(e.target.value, 10) / 100 } as Partial<Settings>)}
            onMouseUp={() => play(true)}
          />
          <span style={{ width: 36, textAlign: 'right', color: 'var(--text-muted)' }}>
            {Math.round(volume * 100)}%
          </span>
        </div>
      </div>
      <div className="set-row">
        <label>{t('set.sound.upload')}</label>
        <input
          type="file"
          accept="audio/*"
          onChange={(e) => {
            uploadSound(e.target.files?.[0])
            e.target.value = ''
          }}
          style={{ maxWidth: 240 }}
        />
      </div>
    </div>
  )
}

/**
 * Splits a section's flat rows into framed cards, breaking at each `.set-group-title`.
 * Lets sections keep their simple flat markup while rendering as visually separated blocks —
 * a group title starts a new card; rows before the first title form an untitled leading card.
 */
function Framed({ children }: { children: React.ReactNode }): React.JSX.Element {
  const isTitle = (k: React.ReactNode): boolean =>
    isValidElement(k) &&
    String((k.props as { className?: string }).className ?? '')
      .split(' ')
      .includes('set-group-title')

  const cards: React.ReactNode[][] = []
  let cur: React.ReactNode[] = []
  for (const kid of Children.toArray(children)) {
    if (isTitle(kid) && cur.length) {
      cards.push(cur)
      cur = []
    }
    cur.push(kid)
  }
  if (cur.length) cards.push(cur)

  return (
    <>
      {cards.map((c, i) => (
        <div className="set-card" key={i}>
          {c}
        </div>
      ))}
    </>
  )
}

export function Toggle({
  label,
  value,
  onChange,
  hint
}: {
  /** plain text, or a fragment when the label embeds an icon (e.g. the translit glyph) */
  label: React.ReactNode
  value: boolean
  onChange: (v: boolean) => void
  hint?: string
}): React.JSX.Element {
  return (
    <div className="set-row" title={hint}>
      <label className={hint ? 'has-hint' : undefined}>{label}</label>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </div>
  )
}

/** multi-select dropdown for the channels a mod button is limited to (empty = everywhere) */
function ChannelMultiSelect({
  value,
  known,
  onChange
}: {
  value: string[]
  known: string[]
  onChange: (channels: string[]) => void
}): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [add, setAdd] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // known channels first, then any manually-added ones not currently open
  const options = [...new Set([...known, ...value])]
  const toggle = (ch: string): void =>
    onChange(value.includes(ch) ? value.filter((c) => c !== ch) : [...value, ch])
  const label = value.length === 0 ? t('set.modBtn.allChannels') : value.join(', ')

  return (
    <div className="chan-select" ref={ref}>
      <button className="chan-select-btn" title={t('set.modBtn.channels.hint')} onClick={() => setOpen((v) => !v)}>
        <span className="chan-select-label">{label}</span>
        <span className="chan-select-caret">▾</span>
      </button>
      {open && (
        <div className="chan-select-pop">
          {/* preventDefault on mousedown keeps focus off these buttons — otherwise the browser
              scrolls the focused option into view and the settings pane visibly jumps */}
          <button
            className={`chan-opt ${value.length === 0 ? 'active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange([])}
          >
            {t('set.modBtn.allChannels')}
          </button>
          {options.map((ch) => (
            <button
              key={ch}
              className={`chan-opt ${value.includes(ch) ? 'active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggle(ch)}
            >
              <input type="checkbox" readOnly checked={value.includes(ch)} /> {ch}
            </button>
          ))}
          <div className="chan-add">
            <input
              placeholder={t('pane.channelPlaceholder')}
              value={add}
              spellCheck={false}
              onChange={(e) => setAdd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const ch = add.trim().toLowerCase().replace(/^[#@]/, '')
                if (ch && !value.includes(ch)) onChange([...value, ch])
                setAdd('')
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** edit the swipe-to-moderate timeout tiers (seconds, shortest→longest) */
function SwipeTiersEditor(): React.JSX.Element {
  const t = useT()
  const tiers = useSettingsStore((s) => s.settings.swipeTimeouts)
  const set = useSettingsStore((s) => s.setSettings)
  const [raw, setRaw] = useState(tiers.join(', '))
  useEffect(() => setRaw(tiers.join(', ')), [tiers])
  const commit = (): void => {
    const parsed = raw
      .split(',')
      .map((x) => parseInt(x.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
    set({ swipeTimeouts: parsed.length ? parsed : [60, 300, 600, 1800, 3600, 86400] })
  }
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        style={{ flex: 1 }}
        value={raw}
        spellCheck={false}
        placeholder="60, 300, 600, 1800, 3600, 86400"
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      <span className="hint" style={{ color: 'var(--text-faint)' }}>
        {t('set.swipeTiers.unit')}
      </span>
    </div>
  )
}

function ModerationSection(): React.JSX.Element {
  const t = useT()
  const swipeModEnabled = useSettingsStore((s) => s.settings.swipeModEnabled)
  const setSettings = useSettingsStore((s) => s.setSettings)
  const modButtons = useSettingsStore((s) => s.modButtons)
  const setModButtons = useSettingsStore((s) => s.setModButtons)
  const raidFavorites = useSettingsStore((s) => s.raidFavorites)
  const setRaidFavorites = useSettingsStore((s) => s.setRaidFavorites)
  const tabs = useLayoutStore((s) => s.tabs)
  const [favInput, setFavInput] = useState('')
  const [iconPickerFor, setIconPickerFor] = useState<string | null>(null)
  const [draggingBtn, setDraggingBtn] = useState<string | null>(null)
  const [scopeFilter, setScopeFilter] = useState<'all' | 'message' | 'toolbar'>('all')
  const modListRef = useRef<HTMLDivElement>(null)
  const firstAccount = useAccountsStore((s) => s.accounts[0])

  // same glide animation the tab bar uses — cards flow around the dragged one
  useFlip(modListRef, '.modbtn-card', !!draggingBtn)

  const knownChannels = [...new Set(tabs.flatMap((tab) => tab.panes.map((p) => p.channel)))]

  const update = (id: string, patch: Partial<ModButton>): void => {
    setModButtons(modButtons.map((b) => (b.id === id ? { ...b, ...patch } : b)))
  }
  const reorder = (draggedId: string, targetId: string): void => {
    if (draggedId === targetId) return
    // always read fresh state: during a pointer drag this is called many times in a row
    const list = [...useSettingsStore.getState().modButtons]
    const from = list.findIndex((b) => b.id === draggedId)
    const to = list.findIndex((b) => b.id === targetId)
    if (from === -1 || to === -1) return
    const [item] = list.splice(from, 1)
    list.splice(to, 0, item)
    setModButtons(list)
  }
  const needsText = (type: ModActionType): boolean =>
    ['announce', 'snippet', 'link', 'warn', 'timeout', 'ban', 'fill'].includes(type)

  const visibleButtons =
    scopeFilter === 'all' ? modButtons : modButtons.filter((b) => b.scope === scopeFilter)

  const addFavorite = (): void => {
    const v = favInput.trim().replace(/^[#@]/, '').toLowerCase()
    if (!v || raidFavorites.includes(v)) return
    setRaidFavorites([...raidFavorites, v])
    setFavInput('')
  }

  return (
    <div ref={modListRef}>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {t('set.modBtn.hint')}
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <button
          className="primary"
          onClick={() =>
            setModButtons([
              { id: nextId('mb'), label: 'New', icon: '⭐', type: 'snippet', text: '', scope: 'toolbar' },
              ...modButtons
            ])
          }
        >
          + {t('set.modBtn.add')}
        </button>
        <div className="spacer" style={{ flex: 1 }} />
        <label className="hint" style={{ color: 'var(--text-faint)' }}>
          {t('set.modBtn.filter')}
        </label>
        <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value as typeof scopeFilter)}>
          <option value="all">{t('set.modBtn.filter.all')}</option>
          <option value="message">{t('set.modBtn.scope.message')}</option>
          <option value="toolbar">{t('set.modBtn.scope.toolbar')}</option>
        </select>
      </div>
      {visibleButtons.map((b, index) => (
        <div key={b.id} data-flipid={b.id} className={`modbtn-card ${draggingBtn === b.id ? 'dragging' : ''}`}>
          <div className="modbtn-line">
            <span
              className="modbtn-drag"
              title="⠿"
              onPointerDown={(e) => {
                if (!modListRef.current) return
                e.preventDefault()
                startPointerReorder({
                  e,
                  container: modListRef.current,
                  itemSelector: '.modbtn-card',
                  index,
                  axis: 'y',
                  threshold: 3,
                  onMove: (from, to) => {
                    // startPointerReorder reports indices into the *visible* rows; recompute the
                    // visible slice from live state each move (the list reflows after every swap)
                    // and map back to ids, so drag works even while a filter is active
                    const full = useSettingsStore.getState().modButtons
                    const vis = scopeFilter === 'all' ? full : full.filter((x) => x.scope === scopeFilter)
                    if (from < 0 || to < 0 || from >= vis.length || to >= vis.length) return
                    reorder(vis[from].id, vis[to].id)
                  },
                  onDragState: (d) => setDraggingBtn(d ? b.id : null)
                })
              }}
            >
              ⠿
            </span>
            <span className="modbtn-preview">
              <BtnIcon icon={b.icon} /> {b.label}
            </span>
            <span style={{ position: 'relative' }}>
              <input
                style={{ width: 120 }}
                placeholder={t('set.modBtn.icon')}
                value={b.icon ?? ''}
                spellCheck={false}
                onChange={(e) => update(b.id, { icon: e.target.value })}
              />
              <button
                type="button"
                title={t('picker.open')}
                onClick={() => setIconPickerFor((cur) => (cur === b.id ? null : b.id))}
              >
                😊
              </button>
              {iconPickerFor === b.id && (
                <EmotePicker
                  channel=""
                  channelId=""
                  account={firstAccount}
                  fixed
                  onPick={(emote) => {
                    update(b.id, { icon: emote.provider === 'emoji' ? emote.code : emote.url })
                    setIconPickerFor(null)
                  }}
                  onClose={() => setIconPickerFor(null)}
                />
              )}
            </span>
            <input
              style={{ width: 100 }}
              placeholder={t('set.modBtn.label')}
              value={b.label}
              onChange={(e) => update(b.id, { label: e.target.value })}
            />
            <div className="modbtn-actions">
              <button
                className="ghost"
                title={t('set.modBtn.duplicate')}
                onClick={() => {
                  const list = useSettingsStore.getState().modButtons
                  const i = list.findIndex((x) => x.id === b.id)
                  const copy = { ...b, id: nextId('mb') }
                  setModButtons([...list.slice(0, i + 1), copy, ...list.slice(i + 1)])
                }}
              >
                ⧉
              </button>
              <button
                className="danger"
                title={t('set.modBtn.delete')}
                onClick={() => setModButtons(modButtons.filter((x) => x.id !== b.id))}
              >
                ✕
              </button>
            </div>
          </div>
          <div className="modbtn-line">
            <select
              value={b.type}
              onChange={(e) => {
                const type = e.target.value as ModActionType
                // an action that needs a clicked message cannot live on the toolbar, so
                // switching to one moves the button rather than leaving it somewhere it
                // could only ever fail
                update(b.id, MESSAGE_ONLY_TYPES.has(type) ? { type, scope: 'message' } : { type })
              }}
            >
              {BUTTON_TYPES.map((bt) => (
                <option key={bt} value={bt}>
                  {t(`btn.type.${bt}` as Parameters<typeof t>[0])}
                </option>
              ))}
            </select>
            {/* the placement choice is only a choice for actions that have one: these work on
                the message you clicked, and the bar above the chat has no clicked message */}
            {MESSAGE_ONLY_TYPES.has(b.type) ? (
              <span className="hint modbtn-fixed-scope" title={t('set.modBtn.messageOnly')}>
                {t('set.modBtn.scope.message')}
              </span>
            ) : (
              <select value={b.scope} onChange={(e) => update(b.id, { scope: e.target.value as 'message' | 'toolbar' })}>
                <option value="message">{t('set.modBtn.scope.message')}</option>
                <option value="toolbar">{t('set.modBtn.scope.toolbar')}</option>
              </select>
            )}
            <ChannelMultiSelect
              value={b.channels ?? []}
              known={knownChannels}
              onChange={(channels) => update(b.id, { channels })}
            />
          </div>
          {(b.type === 'timeout' || needsText(b.type)) && (
            <div className="modbtn-line">
              {b.type === 'timeout' && (
                <input
                  type="number"
                  style={{ width: 110 }}
                  placeholder={t('set.modBtn.seconds')}
                  value={b.seconds ?? ''}
                  onChange={(e) => update(b.id, { seconds: parseInt(e.target.value, 10) || undefined })}
                />
              )}
              {b.type === 'announce' && (
                <select
                  value={b.color ?? 'primary'}
                  onChange={(e) => update(b.id, { color: e.target.value as ModButton['color'] })}
                >
                  {['primary', 'blue', 'green', 'orange', 'purple'].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
              {needsText(b.type) && (
                <input
                  style={{ flex: 1 }}
                  placeholder={
                    b.type === 'timeout' || b.type === 'ban' ? t('mod.reason') : t('set.modBtn.text')
                  }
                  value={b.text ?? ''}
                  spellCheck={false}
                  onChange={(e) => update(b.id, { text: e.target.value })}
                />
              )}
            </div>
          )}
        </div>
      ))}
      <h4 style={{ marginTop: 22, marginBottom: 6 }}>{t('set.swipeTiers')}</h4>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {t('set.swipeTiers.hint')}
      </p>
      <Toggle
        label={t('set.swipeMod')}
        hint={t('set.swipeMod.hint')}
        value={swipeModEnabled !== false}
        onChange={(v) => setSettings({ swipeModEnabled: v })}
      />
      {swipeModEnabled !== false && <SwipeTiersEditor />}

      <h4 style={{ marginTop: 22, marginBottom: 6 }}>{t('set.raidFavorites')}</h4>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          placeholder={t('pane.channelPlaceholder')}
          value={favInput}
          spellCheck={false}
          onChange={(e) => setFavInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addFavorite()
          }}
        />
        <button onClick={addFavorite}>{t('set.raidFav.add')}</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {raidFavorites.map((f) => (
          <span key={f} className="chip">
            {f}
            <button className="ghost" onClick={() => setRaidFavorites(raidFavorites.filter((x) => x !== f))}>
              ✕
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}

// real Twitch badge set ids — note lead_moderator uses an underscore, not a hyphen
const BADGE_OPTIONS: { id: string; labelKey: string }[] = [
  { id: 'broadcaster', labelKey: 'badge.broadcaster' },
  { id: 'moderator', labelKey: 'badge.moderator' },
  { id: 'lead_moderator', labelKey: 'badge.leadModerator' },
  { id: 'vip', labelKey: 'badge.vip' },
  { id: 'subscriber', labelKey: 'badge.subscriber' },
  { id: 'founder', labelKey: 'badge.founder' },
  { id: 'artist-badge', labelKey: 'badge.artist' },
  { id: 'staff', labelKey: 'badge.staff' },
  { id: 'partner', labelKey: 'badge.partner' },
  { id: 'turbo', labelKey: 'badge.turbo' },
  { id: 'premium', labelKey: 'badge.premium' }
]

/* 'raider' is deliberately absent: the category never actually matched anything, so offering
   it was offering a rule that silently does nothing. The kind stays in the type so old saved
   rules still parse — they're dropped on load below. */
const HL_KINDS: HighlightKind[] = ['badge', 'nick', 'own', 'redeem', 'bits', 'subEvent', 'follow', 'firstMsg', 'firstStream', 'watchStreak', 'sharedChat']

function HighlightsSection(): React.JSX.Element {
  const t = useT()
  const rules = useSettingsStore((s) => s.highlightRules)
  const setRules = useSettingsStore((s) => s.setHighlightRules)
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const [mutedInput, setMutedInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  useFlip(listRef, '.hl-card', !!dragging)

  const update = (id: string, patch: Partial<HighlightRule>): void => {
    setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  /** rules are evaluated top-down and the first match wins, so their order IS the priority */
  // one-time cleanup: a saved 'raider' rule can only sit in the list looking functional
  useEffect(() => {
    const live = useSettingsStore.getState().highlightRules
    if (live.some((r) => r.kind === 'raider')) setRules(live.filter((r) => r.kind !== 'raider'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const reorderRules = (from: number, to: number): void => {
    const next = [...useSettingsStore.getState().highlightRules]
    if (from < 0 || to < 0 || from >= next.length || to >= next.length) return
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setRules(next)
  }

  const addMuted = (): void => {
    const login = mutedInput.trim().replace(/^@/, '').toLowerCase()
    if (!login || settings.mutedUsers.some((u) => u.login === login)) return
    set({ mutedUsers: [...settings.mutedUsers, { login, mode: 'dim', opacity: 0.3 }] })
    setMutedInput('')
  }

  return (
    <div>
      <div className="set-group-title">{t('set.group.msgColors')}</div>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {t('hl.hint')}
      </p>
      <div className="set-row" title={t('hint.flashColor')}>
        <label className="has-hint">{t('set.flashColor')}</label>
        <ColorField value={settings.flashColor} defaultValue="#a970ff" onChange={(v) => set({ flashColor: v })} />
      </div>
      {/* shared chat (co-streams): the partner channel's viewers get their own tint */}
      <div className="set-group-title">{t('set.group.sharedChat')}</div>
      <div className="set-row" title={t('hint.sharedChatTagMode')}>
        <label className="has-hint">{t('set.sharedChatTagMode')}</label>
        <select
          value={settings.sharedChatTagMode}
          onChange={(e) => set({ sharedChatTagMode: e.target.value as Settings['sharedChatTagMode'] })}
        >
          <option value="full">{t('set.sharedChatTagMode.full')}</option>
          <option value="avatar">{t('set.sharedChatTagMode.avatar')}</option>
        </select>
      </div>
      {/* mentions are a built-in category: no drag handle and no delete, but the same column
          grid as the rules below so every control lines up down the page */}
      <div className="hl-card hl-card-fixed">
        <div className="hl-row" title={t('hint.mentionBg')}>
          <span className="hl-drag-spacer" />
          <input
            type="checkbox"
            title={t('hl.enabled')}
            checked={settings.showMentionBg}
            onChange={(e) => set({ showMentionBg: e.target.checked })}
          />
          <span className="hl-kind-label" style={{ gridColumn: 'span 2' }}>
            @ {t('hl.mention')}
          </span>
          <ColorField
            value={settings.mentionBgColor}
            defaultValue="#8b5cf6"
            onChange={(v) => set({ mentionBgColor: v })}
          />
          <span />
          <input
            type="range"
            title={`${t('hl.opacity')}: ${Math.round(settings.mentionBgOpacity * 100)}%`}
            min={5}
            max={100}
            value={Math.round(settings.mentionBgOpacity * 100)}
            onChange={(e) => set({ mentionBgOpacity: parseInt(e.target.value, 10) / 100 })}
          />
          <span className="hl-preview" style={{ background: hexToRgba(settings.mentionBgColor, settings.mentionBgOpacity) }}>
            {t('hl.sample')}
          </span>
          <span />
        </div>
      </div>
      <div ref={listRef}>
      {rules.map((r, index) => (
        <div key={r.id} data-flipid={r.id} className={`hl-card ${dragging === r.id ? 'dragging' : ''}`}>
        <div className="hl-row">
          <span
            className="hl-drag"
            title={t('hl.reorder')}
            onPointerDown={(e) => {
              if (!listRef.current) return
              e.preventDefault()
              startPointerReorder({
                e,
                container: listRef.current,
                itemSelector: '.hl-card',
                index,
                axis: 'y',
                threshold: 3,
                onMove: reorderRules,
                onDragState: (d) => setDragging(d ? r.id : null)
              })
            }}
          >
            ⠿
          </span>
          <input
            type="checkbox"
            title={t('hl.enabled')}
            checked={r.enabled}
            onChange={(e) => update(r.id, { enabled: e.target.checked })}
          />
          <select
            value={r.kind}
            onChange={(e) => {
              const kind = e.target.value as HighlightKind
              update(r.id, { kind, value: kind === 'badge' ? 'moderator' : '' })
            }}
          >
            {HL_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`hl.kind.${k}` as Parameters<typeof t>[0])}
              </option>
            ))}
          </select>
          {/* the value cell is always rendered, empty for the categories that don't take one.
              Skipping it was why every row had a different shape and nothing lined up. */}
          {r.kind === 'badge' ? (
            <select value={r.value} onChange={(e) => update(r.id, { value: e.target.value })}>
              <option value="" disabled>
                {t('hl.value')}
              </option>
              {BADGE_OPTIONS.map((b) => (
                <option key={b.id} value={b.id}>
                  {t(b.labelKey as Parameters<typeof t>[0])}
                </option>
              ))}
            </select>
          ) : r.kind === 'nick' ? (
            <input
              placeholder={t('hl.nickPlaceholder')}
              value={r.value}
              spellCheck={false}
              onChange={(e) => update(r.id, { value: e.target.value.trim() })}
            />
          ) : (
            <span />
          )}
          {r.adaptColor ? (
            <span className="hl-adapt-tag" title={t('hl.adapt.hint')}>
              <PaletteIcon size={13} /> {t('hl.adaptShort')}
            </span>
          ) : (
            <ColorField value={r.color} defaultValue="#9147ff" onChange={(v) => update(r.id, { color: v })} />
          )}
          <button
            className={`icon-btn ${r.adaptColor ? 'active' : ''}`}
            title={t('hl.adapt.hint')}
            onClick={() => update(r.id, { adaptColor: !r.adaptColor })}
          >
            <PaletteIcon size={15} />
          </button>
          <input
            type="range"
            title={`${t('hl.opacity')}: ${Math.round(r.opacity * 100)}%`}
            min={5}
            max={100}
            value={Math.round(r.opacity * 100)}
            onChange={(e) => update(r.id, { opacity: parseInt(e.target.value, 10) / 100 })}
          />
          <span
            className="hl-preview"
            style={{ background: hexToRgba(r.adaptColor ? '#888888' : r.color, r.opacity) }}
          >
            {t('hl.sample')}
          </span>
          <button
            className="danger icon-btn"
            title={t('hl.remove')}
            onClick={() => setRules(rules.filter((x) => x.id !== r.id))}
          >
            <CloseIcon size={13} />
          </button>
        </div>
        </div>
      ))}
      </div>
      <button
        style={{ marginTop: 10 }}
        onClick={() =>
          setRules([
            ...rules,
            { id: nextId('hl'), kind: 'badge', value: 'moderator', color: '#00c853', opacity: 0.18, enabled: true }
          ])
        }
      >
        + {t('hl.add')}
      </button>

      <div className="set-group-title" style={{ marginTop: 24 }}>
        {t('muted.title')}
      </div>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {t('muted.hint')}
      </p>
      {settings.mutedUsers.map((u) => (
        <div key={u.login} className="hl-card">
        {/* muted users have their own column set — nick, mode, opacity — so they get their
            own grid rather than borrowing the rule grid and leaving holes in it */}
        <div className="muted-row">
          <b style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.login}</b>
          <select
            value={u.mode}
            onChange={(e) =>
              set({
                mutedUsers: settings.mutedUsers.map((x) =>
                  x.login === u.login ? { ...x, mode: e.target.value as 'hide' | 'dim' } : x
                )
              })
            }
          >
            <option value="dim">{t('muted.mode.dim')}</option>
            <option value="hide">{t('muted.mode.hide')}</option>
          </select>
          <input
            type="range"
            title={`${t('hl.opacity')}: ${Math.round(u.opacity * 100)}%`}
            min={5}
            max={90}
            disabled={u.mode === 'hide'}
            value={Math.round(u.opacity * 100)}
            onChange={(e) =>
              set({
                mutedUsers: settings.mutedUsers.map((x) =>
                  x.login === u.login ? { ...x, opacity: parseInt(e.target.value, 10) / 100 } : x
                )
              })
            }
          />
          <span className="hl-preview" style={{ opacity: u.mode === 'hide' ? 0.15 : u.opacity }}>
            {t('hl.sample')}
          </span>
          <button
            className="danger icon-btn"
            title={t('hl.remove')}
            onClick={() => set({ mutedUsers: settings.mutedUsers.filter((x) => x.login !== u.login) })}
          >
            <CloseIcon size={13} />
          </button>
        </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          placeholder={t('muted.placeholder')}
          value={mutedInput}
          spellCheck={false}
          onChange={(e) => setMutedInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addMuted()
          }}
        />
        <button onClick={addMuted}>{t('muted.add')}</button>
      </div>
    </div>
  )
}

const EDITABLE_HOTKEYS: HotkeyAction[] = ['reconnect', 'scrollLock', 'pauseHold', 'translit', 'sendKeep', 'resendLast']

function HotkeyInput({ action }: { action: HotkeyAction }): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const [capturing, setCapturing] = useState(false)
  const current = hotkeyFor(settings, action)
  const isDefault = current === DEFAULT_HOTKEYS[action]

  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <button
        className={`hotkey-btn ${capturing ? 'capturing' : ''}`}
        onClick={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={(e) => {
          if (!capturing) return
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'Escape') {
            setCapturing(false)
            return
          }
          if (e.key === 'Backspace') {
            // reset to default
            const { [action]: _, ...rest } = settings.hotkeys
            set({ hotkeys: rest })
            setCapturing(false)
            return
          }
          const accel = eventToAccel(e)
          if (accel) {
            set({ hotkeys: { ...settings.hotkeys, [action]: accel } })
            setCapturing(false)
          }
        }}
      >
        {capturing ? t('hk.press') : current}
      </button>
      {!isDefault && !capturing && (
        <button
          className="ghost"
          title={`${t('hk.reset')}: ${DEFAULT_HOTKEYS[action]}`}
          onClick={() => {
            const { [action]: _, ...rest } = settings.hotkeys
            set({ hotkeys: rest })
          }}
        >
          ⟲
        </button>
      )}
    </span>
  )
}

function HotkeysSection(): React.JSX.Element {
  const t = useT()
  const labels: Record<HotkeyAction, string> = {
    reconnect: t('hk.reconnect'),
    scrollLock: t('hk.scrollLock'),
    pauseHold: t('hk.pauseHold'),
    translit: t('hk.translit'),
    sendKeep: t('hk.sendKeep'),
    resendLast: t('hk.resendLast')
  }
  const builtin: [string, string][] = [
    ['Enter', t('hk.fixed.send')],
    ['Shift+Enter', t('hk.fixed.newline')],
    ['Tab', t('hk.fixed.autocomplete')],
    ['↑ / ↓', t('hk.fixed.history')],
    ['Ctrl + колесо', t('hk.fixed.zoom')],
    ['Ctrl+Z / Ctrl+Shift+Z / Ctrl+C / Ctrl+V', t('hk.fixed.native')]
  ]
  return (
    <Framed>
      <div className="set-group-title">{t('hk.editable')}</div>
      <p className="hint" style={{ color: 'var(--text-faint)', margin: '0 0 6px' }}>
        {t('hk.hint')}
      </p>
      {EDITABLE_HOTKEYS.map((a) => (
        <div key={a} className="set-row">
          <label>{labels[a]}</label>
          <HotkeyInput action={a} />
        </div>
      ))}
      <div className="set-group-title">{t('hk.builtin')}</div>
      {builtin.map(([keys, desc]) => (
        <div key={keys} className="set-row">
          <label>{desc}</label>
          <span className="hotkey-fixed">{keys}</span>
        </div>
      ))}
    </Framed>
  )
}

const DEFAULT_FONTS = ['Inter', 'Verdana', 'Tahoma', 'Arial', 'Calibri', 'Georgia', 'Consolas', 'Comic Sans MS']

/**
 * Shared font picker: type-to-filter combobox with a dropdown chevron, an upload icon, uploaded
 * fonts listed (and deletable) above the system fonts. `queryLocalFonts` is deduped by family
 * so a font with several styles shows once. Used for the UI font and each overlay profile.
 */
export function FontPicker({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  const t = useT()
  const customFonts = useSettingsStore((s) => s.settings.customFonts)
  const set = useSettingsStore((s) => s.setSettings)
  const [systemFonts, setSystemFonts] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Re-query on every open so fonts installed while the app is running show up live
  // (no restart needed). queryLocalFonts is cheap and returns the current OS font set.
  const loadSystemFonts = async (): Promise<void> => {
    try {
      const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
      if (!q) return
      const fonts = await q()
      const next = [...new Set(fonts.map((f) => f.family))].sort()
      // only touch state when the list actually changed, to avoid needless re-renders
      setSystemFonts((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next))
    } catch {
      /* permission denied / unsupported — keep the built-in list */
    }
  }
  const q = query.toLowerCase()
  const uploaded = customFonts.map((f) => f.name).filter((n) => !q || n.toLowerCase().includes(q))
  const system = (systemFonts.length ? systemFonts : DEFAULT_FONTS).filter(
    (n) => !q || n.toLowerCase().includes(q)
  )
  const deleteFont = (name: string): void => {
    const fresh = useSettingsStore.getState().settings
    set({ customFonts: fresh.customFonts.filter((f) => f.name !== name) })
    if (value === name) onChange('')
  }
  const uploadFont = (file: File | undefined): void => {
    if (!file || file.size > 5 * 1024 * 1024) return
    const reader = new FileReader()
    reader.onload = () => {
      const name = file.name.replace(/\.[a-z0-9]+$/i, '')
      const fresh = useSettingsStore.getState().settings
      set({ customFonts: [...fresh.customFonts.filter((f) => f.name !== name), { name, data: String(reader.result) }] })
      onChange(name)
    }
    reader.readAsDataURL(file)
  }
  return (
    <div className="font-combo">
      <input
        placeholder={t('set.fontFamily.placeholder')}
        value={value}
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value)
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          loadSystemFonts()
          setQuery('')
          setOpen(true)
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Enter') setOpen(false)
        }}
      />
      {/* chevron: reopen the list without having to blur+refocus the input */}
      <button
        className="font-combo-caret"
        title={t('set.fontFamily')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          loadSystemFonts()
          setQuery('')
          setOpen((o) => !o)
        }}
      >
        ▾
      </button>
      <label className="font-upload-icon" title={t('set.fontUpload')}>
        <input
          type="file"
          accept=".ttf,.otf,.woff,.woff2"
          style={{ display: 'none' }}
          onChange={(e) => {
            uploadFont(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        📁
      </label>
      {open && (uploaded.length > 0 || system.length > 0) && (
        <div className="font-combo-list">
          {uploaded.length > 0 && <div className="font-combo-group">{t('set.fontsUploaded')}</div>}
          {uploaded.map((f) => (
            <div
              key={`u:${f}`}
              className={`font-combo-item ${f === value ? 'selected' : ''}`}
              style={{ fontFamily: `'${f}'` }}
              onMouseDown={(e) => {
                e.preventDefault()
                onChange(f)
                setOpen(false)
              }}
            >
              <span className="font-combo-name">{f}</span>
              <span
                className="font-combo-del"
                title={t('set.fontDelete')}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  deleteFont(f)
                }}
              >
                ✕
              </span>
            </div>
          ))}
          {uploaded.length > 0 && system.length > 0 && <div className="font-combo-divider" />}
          {system.map((f) => (
            <div
              key={`s:${f}`}
              className={`font-combo-item ${f === value ? 'selected' : ''}`}
              style={{ fontFamily: `'${f}'` }}
              onMouseDown={(e) => {
                e.preventDefault()
                onChange(f)
                setOpen(false)
              }}
            >
              {f}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** OBS overlays v2 — the settings tab is a thin manager: server controls + overlay cards.
 *  All styling happens in the dedicated editor window (openOverlayEditor). */
function OverlaySection(): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const tabs = useLayoutStore((s) => s.tabs)
  const [copiedId, setCopiedId] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [ioMsg, setIoMsg] = useState('')
  const importRef = useRef<HTMLInputElement>(null)

  const downloadJson = (json: string, name: string): void => {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const safeName = (s2: string): string => s2.replace(/[^\w\-. ]+/g, '_').trim() || 'overlay'
  // pictures and fonts live as files now; a shared overlay has to carry the bytes, so expand the
  // asset references on the way out (see main/assets.ts)
  const exportOne = async (o: OverlayConfig): Promise<void> => {
    const full = (await window.sticki.inlineAssets(o)) as OverlayConfig
    downloadJson(exportOverlayJson(full), `${safeName(o.name)}.stickichat-overlay.json`)
  }
  const exportAll = async (): Promise<void> => {
    if (!settings.chatOverlays.length) return
    const full = (await window.sticki.inlineAssets(settings.chatOverlays)) as OverlayConfig[]
    downloadJson(exportOverlayJson(full), `stickichat-overlays-${new Date().toISOString().slice(0, 10)}.json`)
  }
  const importFile = (file: File | undefined): void => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const imported = parseOverlayImport(String(reader.result))
      if (!imported) {
        setIoMsg(t('oe.io.importErr'))
        return
      }
      set({ chatOverlays: [...useSettingsStore.getState().settings.chatOverlays, ...imported] })
      setIoMsg(t('oe.io.imported', { n: String(imported.length) }))
    }
    reader.readAsText(file)
  }

  /**
   * How many OBS sources are actually on each overlay right now.
   *
   * Polled rather than pushed: it is only looked at while this tab is open, and a source coming
   * and going is not worth a channel of its own. It answers the question that otherwise takes a
   * round trip through OBS — is the browser source even running, or is it the overlay that is
   * quiet.
   */
  const [sources, setSources] = useState<Record<string, number>>({})
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      void window.sticki.overlayClients().then((m) => {
        if (alive) setSources(m || {})
      })
    }
    tick()
    const t = window.setInterval(tick, 2000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])

  /**
   * The channel an overlay belongs to unless told otherwise: the owner's own.
   *
   * It used to be whichever pane happened to be first, which is somebody else's chat as often as
   * not — and an alert pointed at somebody else's channel is silent in a way that takes a while to
   * notice. The main account (the first one in the list) is the one whose stream these overlays
   * are for.
   */
  const ownChannel = useAccountsStore.getState().accounts[0]?.login?.toLowerCase() ?? ''
  const firstChannel = ownChannel || tabs.flatMap((tb) => tb.panes)[0]?.channel || ''
  const openChannels = [
    ...new Set([ownChannel, ...tabs.flatMap((tb) => tb.panes).map((pn) => pn.channel)].filter(Boolean))
  ]
  const urlFor = (o: OverlayConfig): string =>
    `http://127.0.0.1:${settings.overlayPort}/overlay?channel=${encodeURIComponent(o.channel || firstChannel || 'КАНАЛ')}&profile=${encodeURIComponent(o.id)}`
  const patchOverlay = (id: string, patch: Partial<OverlayBase>): void =>
    set({ chatOverlays: useSettingsStore.getState().settings.chatOverlays.map((o) => (o.id === id ? { ...o, ...patch } : o)) })

  /** what each kind is called and how it is drawn in the list */
  const KINDS: { kind: OverlayKind; icon: string; label: string; hint: string }[] = [
    { kind: 'chat', icon: '💬', label: t('oe.chatOverlay'), hint: 'Повідомлення чату на екрані.' },
    { kind: 'emotes', icon: '🎉', label: 'Святкування', hint: 'Емоути з чату розсипаються по всьому екрану.' },
    { kind: 'goal', icon: '🎯', label: 'Ціль', hint: 'Смуга прогресу: фоловери, підписки, бітси.' },
    { kind: 'follow', icon: '💜', label: 'Алерт фолова', hint: 'Спливає на екрані, коли хтось зафоловився.' },
    { kind: 'roulette', icon: '🎡', label: 'Рулетка', hint: 'Колесо фортуни: секції з вагою, картинками й звуком.' }
  ]

  const addOverlay = (kind: OverlayKind): void => {
    const id = nextId('ov')
    const meta = KINDS.find((k) => k.kind === kind)!
    const base =
      kind === 'emotes'
        ? DEFAULT_EMOTE_OVERLAY
        : kind === 'goal'
          ? DEFAULT_GOAL_OVERLAY
          : kind === 'follow'
            ? DEFAULT_FOLLOW_OVERLAY
            : kind === 'roulette'
              ? DEFAULT_ROULETTE_OVERLAY
              : DEFAULT_CHAT_OVERLAY
    set({
      chatOverlays: [
        ...settings.chatOverlays,
        { ...base, id, name: `${meta.label} ${settings.chatOverlays.length + 1}`, channel: ownChannel } as OverlayConfig
      ]
    })
    setPickerOpen(false)
    window.sticki.openOverlayEditor(id)
  }

  return (
    <div>
      <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
        {t('overlay.hint')}
      </p>
      <Framed>
        <Toggle label={t('overlay.enabled')} value={settings.overlayEnabled} onChange={(v) => set({ overlayEnabled: v })} />
        <div className="set-row">
          <label>{t('overlay.port')}</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <NumberField value={settings.overlayPort} min={1024} max={65535} onChange={(n) => set({ overlayPort: n })} />
            <button title={t('overlay.restart.hint')} onClick={() => window.sticki.overlayRestart()}>
              ⟳ {t('overlay.restart')}
            </button>
          </div>
        </div>
        <div className="set-row" style={{ alignItems: 'flex-start' }} title={t('overlay.hiddenUsers.hint')}>
          <label className="has-hint">{t('overlay.hiddenUsers')}</label>
          <NickListArea value={settings.overlayHiddenUsers} onCommit={(v) => set({ overlayHiddenUsers: v })} />
        </div>
      </Framed>

      <div className="set-group-title">{t('oe.myOverlays')}</div>
      {settings.chatOverlays.length === 0 && (
        <p className="hint" style={{ color: 'var(--text-faint)' }}>{t('oe.empty')}</p>
      )}
      {settings.chatOverlays.map((o) => (
        <div key={o.id} className="ov-card">
          <div className="ov-card-main">
            <span className="ov-type" title={KINDS.find((k) => k.kind === o.type)?.hint}>
              {KINDS.find((k) => k.kind === o.type)?.icon ?? '💬'} {KINDS.find((k) => k.kind === o.type)?.label ?? t('oe.chatOverlay')}
            </span>
            <b>{o.name}</b>
            <select
              className="ov-chan"
              title={t('oe.channel')}
              value={o.channel ?? ''}
              onChange={(e) => patchOverlay(o.id, { channel: e.target.value })}
            >
              <option value="">{t('pane.auto')}</option>
              {o.channel && !openChannels.includes(o.channel) && <option value={o.channel}>{o.channel}</option>}
              {openChannels.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="ov-url" title={urlFor(o)}>{urlFor(o)}</span>
            <span
              className="hint"
              style={{ whiteSpace: 'nowrap', color: sources[o.id] ? 'var(--ok, #12b886)' : 'var(--text-faint)' }}
              title={
                sources[o.id]
                  ? 'Стільки джерел OBS зараз відкрили цю сторінку.'
                  : 'Жодне джерело OBS не підключене. Якщо воно додане — онови кеш сторінки в його властивостях.'
              }
            >
              {sources[o.id] ? `● ${sources[o.id]}` : '○ 0'}
            </span>
          </div>
          <div className="ov-card-actions">
            <button
              title={t('oe.copyUrl')}
              onClick={() => {
                window.sticki.copyText(urlFor(o))
                setCopiedId(o.id)
                window.setTimeout(() => setCopiedId(''), 1500)
              }}
            >
              {copiedId === o.id ? '✔' : '📋'}
            </button>
            <button title={t('oe.io.exportOne')} onClick={() => exportOne(o)}>
              ⤓
            </button>
            <button className="primary" onClick={() => window.sticki.openOverlayEditor(o.id)}>
              ✏️ {t('oe.edit')}
            </button>
            <button
              className="danger"
              title={t('oe.delete')}
              onClick={() => set({ chatOverlays: settings.chatOverlays.filter((x) => x.id !== o.id) })}
            >
              ✕
            </button>
          </div>
        </div>
      ))}

      {!pickerOpen ? (
        <button className="primary" style={{ marginTop: 10 }} onClick={() => setPickerOpen(true)}>
          + {t('oe.add')}
        </button>
      ) : (
        <div className="ov-picker">
          <p className="hint" style={{ marginTop: 0 }}>{t('oe.pickType')}</p>
          {KINDS.map((k) => (
            <button key={k.kind} className="ov-type-btn" onClick={() => addOverlay(k.kind)}>
              {k.icon} {k.label}
              <span className="hint">{k.kind === 'chat' ? t('oe.chatOverlay.desc') : k.hint}</span>
            </button>
          ))}
          <button className="ghost" onClick={() => setPickerOpen(false)}>{t('oe.cancel')}</button>
        </div>
      )}

      <div className="ov-io" title={t('oe.io.hint')}>
        <button onClick={() => importRef.current?.click()}>
          <TrayArrowIcon dir="in" /> {t('oe.io.import')}
        </button>
        <button disabled={!settings.chatOverlays.length} onClick={exportAll}>
          <TrayArrowIcon dir="out" /> {t('oe.io.exportAll')}
        </button>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            importFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {ioMsg && <span className="hint" style={{ color: 'var(--text-faint)' }}>{ioMsg}</span>}
      </div>
    </div>
  )
}

/**
 * Local diagnostics. Everything the app knows about its own failures, in a form a person can
 * paste into an issue: environment, then the tail of the rolling log. Nothing is uploaded —
 * the crash reporter is deliberately started without an upload URL, so dumps stay on disk.
 */
function DiagnosticsBlock(): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')

  // one button, two directions: opening the log was a dead end — there was no way back and
  // the wall of text stayed under everything else for the rest of the visit
  const toggle = (): void => {
    if (text) {
      setText('')
      return
    }
    void window.sticki.diagTail(300).then((v) => setText(v || t('diag.empty')))
  }

  return (
    <div className="set-block">
      <p className="hint" style={{ color: 'var(--text-faint)', margin: '0 0 8px' }}>
        {t('diag.hint')}
      </p>
      <div className="row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <button onClick={toggle}>{text ? t('diag.hide') : t('diag.show')}</button>
        <button
          className="primary"
          onClick={() => {
            void window.sticki.diagReport().then((r) => {
              void navigator.clipboard.writeText(r)
              setMsg(t('diag.copied'))
            })
          }}
        >
          {t('diag.copy')}
        </button>
        <button
          onClick={() => {
            void window.sticki.diagReport().then((r) => {
              const url = URL.createObjectURL(new Blob([r], { type: 'text/plain' }))
              const a = document.createElement('a')
              a.href = url
              a.download = `stickichat-report-${new Date().toISOString().slice(0, 10)}.txt`
              a.click()
              setTimeout(() => URL.revokeObjectURL(url), 1000)
            })
          }}
        >
          <TrayArrowIcon dir="out" /> {t('diag.save')}
        </button>
        <button className="ghost" onClick={() => void window.sticki.diagOpenFolder()}>
          {t('diag.openFolder')}
        </button>
        {msg && <span className="hint" style={{ color: 'var(--text-faint)' }}>{msg}</span>}
      </div>
      {text && (
        <textarea
          className="diag-log"
          readOnly
          value={text}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
    </div>
  )
}

function AdvancedSection(): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const importRef = useRef<HTMLInputElement>(null)
  const [ioMsg, setIoMsg] = useState('')
  // everything selected is the old behaviour; unticking is the new part
  const [parts, setParts] = useState<ConfigPart[]>(CONFIG_PARTS)

  const doExport = async (): Promise<void> => {
    const json = exportConfigJson(parts)
    // same reason as the overlay export: send the files, not references into this machine
    const full = JSON.stringify(await window.sticki.inlineAssets(JSON.parse(json)), null, 2)
    const blob = new Blob([full], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `stickichat-settings-${stamp}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setIoMsg(t('set.io.exported'))
  }

  /** name the parts a file carries, so an import isn't a leap of faith */
  const describe = (text: string): string => {
    const found = describeImport(text)
    if (!found) return ''
    return found.map((p) => t(CONFIG_PART_LABELS[p])).join(', ')
  }

  const doImport = (file: File | undefined): void => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result)
      const what = describe(text)
      const ok = importConfigJson(text)
      // name what actually landed — a partial file only touches the parts it carries, and
      // silently applying "something" is how people lose settings they meant to keep
      setIoMsg(ok ? `${t('set.io.imported')} — ${what}` : t('set.io.importErr'))
    }
    reader.readAsText(file)
  }

  return (
    <Framed>
      <div className="set-group-title">{t('set.group.performance')}</div>
      <Toggle
        label={t('set.pauseEmotesUnfocused')}
        hint={t('hint.pauseEmotesUnfocused')}
        value={settings.pauseEmotesUnfocused}
        onChange={(v) => set({ pauseEmotesUnfocused: v })}
      />
      <div className="set-row" title={t('hint.msgLimit')}>
        <label>{t('set.msgLimit')}</label>
        <NumberField value={settings.messageLimit} min={100} max={5000} onChange={(n) => set({ messageLimit: n })} />
      </div>
      {/* Diagnostics moved to "About": a person looking for it is on their way to filing a
          bug, and that is where the GitHub link lives. Burying it under Advanced meant the
          report and the place to send it were two tabs apart. */}
      {/* a backup is not a performance setting; it was only next to one because both ended
          up in the same catch-all section */}
      <div className="set-group-title">{t('set.group.backup')}</div>
      <div className="set-row" title={t('hint.io')} style={{ alignItems: 'flex-start' }}>
        <label className="has-hint">{t('set.io')}</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          {/* a whole-config export is the wrong unit most of the time: people want to hand
              over their mod buttons or their highlight rules, not overwrite the other side */}
          <div className="io-parts">
            {CONFIG_PARTS.map((part) => (
              <label key={part} className="io-part">
                <input
                  type="checkbox"
                  checked={parts.includes(part)}
                  onChange={(e) =>
                    setParts((prev) =>
                      e.target.checked ? [...prev, part] : prev.filter((p) => p !== part)
                    )
                  }
                />
                {t(CONFIG_PART_LABELS[part])}
              </label>
            ))}
          </div>
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <button disabled={!parts.length} onClick={doExport}>
              <TrayArrowIcon dir="out" /> {t('set.io.export')}
            </button>
            <button onClick={() => importRef.current?.click()}>
              <TrayArrowIcon dir="in" /> {t('set.io.import')}
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                doImport(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </span>
          <span className="hint" style={{ color: 'var(--text-faint)' }}>
            {ioMsg || t('set.io.note')}
          </span>
        </div>
      </div>
    </Framed>
  )
}

function AboutSection(): React.JSX.Element {
  const t = useT()
  const [version, setVersion] = useState('')
  const [logOpen, setLogOpen] = useState(false)

  useEffect(() => {
    window.sticki.getVersion().then(setVersion)
  }, [])

  return (
    <Framed>
      <div className="set-row">
        <label>
          <b>StickiChat</b> · {t('set.version')} v{version}
        </label>
        <button onClick={() => window.sticki.checkForUpdates()}>{t('set.checkUpdates')}</button>
      </div>
      <div className="set-row">
        <label>
          {t('about.developer')}: <b>{DEVELOPER}</b>
        </label>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <button onClick={() => window.sticki.openExternal(TWITCH_PROFILE)}>💜 {t('about.twitch')}</button>
        </span>
      </div>
      <div className="set-row">
        <label>{t('about.feedbackHint')}</label>
        <button onClick={() => window.sticki.openExternal(GITHUB_ISSUES)}>🐞 {t('about.github')}</button>
      </div>
      {/* directly under the GitHub button on purpose: filing a useful bug report means
          attaching this, and the two used to live in different tabs */}
      <div className="set-group-title" style={{ marginTop: 20 }}>{t('set.group.diag')}</div>
      <DiagnosticsBlock />
      <div className="set-group-title" style={{ marginTop: 20 }}>
        {t('about.changelog')}
      </div>
      <button className="ghost" onClick={() => setLogOpen((v) => !v)}>
        {logOpen ? '▲' : '▼'} {t('about.changelog')}
      </button>
      {logOpen && (
        <div className="changelog">
          {CHANGELOG.map((entry) => (
            <div key={entry.version} className="changelog-entry">
              <div className="changelog-version">
                v{entry.version} <span className="hint">· {entry.date}</span>
              </div>
              <ul>
                {entry.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Framed>
  )
}
