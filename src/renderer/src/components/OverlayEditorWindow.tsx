import { useEffect, useMemo, useRef, useState } from 'react'
import { useSettingsStore } from '../store/settings'
import { useLayoutStore } from '../store/layout'
import { useT } from '../i18n'
import { ChatOverlayConfig, DEFAULT_CHAT_OVERLAY, OverlayDecor, OverlayFill, OverlayTrigger } from '../types'
import { OVERLAY_PRESETS, randomizeOverlay } from '../lib/overlayPresets'
import { ColorField, FontPicker, NickListArea, Toggle } from './settings/SettingsModal'
import { nextId } from '../store/layout'

/**
 * The OBS overlay editor — a big standalone window: control sections on the left, a live
 * preview in the center. The preview iframe IS the real overlay page (with ?preview=1 it
 * also generates demo messages), so what you see is exactly what OBS renders. Every change
 * is pushed to the overlay server immediately, on top of the normal debounced settings save.
 */

function readFile(file: File | undefined, maxMb: number, cb: (dataUrl: string) => void): void {
  if (!file || file.size > maxMb * 1024 * 1024) return
  const reader = new FileReader()
  reader.onload = () => cb(String(reader.result))
  reader.readAsDataURL(file)
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }): React.JSX.Element {
  return (
    <div className="set-row" title={hint}>
      <label className={hint ? 'has-hint' : undefined}>{label}</label>
      {children}
    </div>
  )
}

type AnimInKind = ChatOverlayConfig['animIn']
type AnimOutKind = ChatOverlayConfig['animOut']

const ANIM_IN: AnimInKind[] = [
  'fade', 'slide', 'pop', 'bounce', 'zoom', 'flip', 'blur', 'elastic', 'swing', 'drop', 'roll',
  'spin', 'stretch', 'glitch', 'flash', 'rise', 'slam', 'rubber', 'wobble', 'fold', 'skew', 'neon',
  'tilt', 'typewriter', 'hinge'
]
const ANIM_OUT: AnimOutKind[] = [
  'fade', 'shrink', 'slide', 'zoom', 'blur', 'flip', 'spin', 'drop', 'roll', 'rise', 'slam',
  'wobble', 'fold', 'skew', 'tilt', 'hinge', 'glitch'
]
const ANIM_LABEL: Record<string, string> = {
  fade: 'Fade', slide: 'Slide', pop: 'Pop', bounce: 'Bounce', zoom: 'Zoom', flip: 'Flip', blur: 'Blur',
  elastic: 'Elastic', swing: 'Swing', drop: 'Drop', roll: 'Roll', spin: 'Spin', stretch: 'Stretch',
  glitch: 'Glitch', flash: 'Flash', rise: 'Rise', slam: 'Slam', rubber: 'Rubber', wobble: 'Wobble',
  fold: 'Fold', skew: 'Skew', neon: 'Neon', tilt: 'Tilt', typewriter: 'Typewriter', hinge: 'Hinge',
  shrink: 'Shrink'
}
// animations whose look depends on the from/to direction (they consume the --ax/--ay vars)
const DIRECTIONAL_IN = new Set<string>(['slide', 'bounce', 'elastic', 'flip', 'roll', 'rise', 'wobble', 'skew'])
const DIRECTIONAL_OUT = new Set<string>(['slide', 'roll', 'rise', 'wobble', 'skew', 'flip'])

function Num({
  v,
  on,
  min = 0,
  max = 999,
  w = 64,
  step = 1,
  def
}: {
  v: number
  on: (n: number) => void
  min?: number
  max?: number
  w?: number
  step?: number
  /** right-click resets to this value (defaults to the value at mount) */
  def?: number
}): React.JSX.Element {
  const clamp = (n: number): number => Math.max(min, Math.min(max, n))
  // a local text buffer: typing is NEVER clamped mid-way (entering "500" used to snap to the
  // minimum the moment you typed "5") — the value applies live only when valid, and commits
  // clamped on blur/Enter
  const [buf, setBuf] = useState(String(v))
  const focused = useRef(false)
  const defRef = useRef(def ?? v)
  const vRef = useRef(v)
  vRef.current = v
  useEffect(() => {
    if (!focused.current) setBuf(String(v))
  }, [v])
  const commit = (): void => {
    const n = parseFloat(buf)
    const next = clamp(Number.isFinite(n) ? n : defRef.current)
    on(next)
    setBuf(String(next))
  }
  const inputRef = useRef<HTMLInputElement>(null)
  // native non-passive wheel listener: React's onWheel is passive, so preventDefault was
  // ignored and the PAGE scrolled along with the value
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const next = clamp(Math.round((vRef.current + (e.deltaY < 0 ? step : -step)) * 100) / 100)
      on(next)
      setBuf(String(next))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, min, max])
  return (
    <input
      ref={inputRef}
      type="number"
      min={min}
      max={max}
      step={step}
      style={{ width: w }}
      value={buf}
      title="Колесо міняє значення · ПКМ скидає"
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => {
        setBuf(e.target.value)
        const n = parseFloat(e.target.value)
        // apply live only when the typed value is already valid and in range
        if (Number.isFinite(n) && n >= min && n <= max) on(n)
      }}
      onBlur={() => {
        focused.current = false
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        on(clamp(defRef.current))
        setBuf(String(clamp(defRef.current)))
      }}
    />
  )
}

function Sec({ title, children, defaultOpen }: { title: string; children: React.ReactNode; defaultOpen?: boolean }): React.JSX.Element {
  return (
    <details className="oe-sec" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="oe-sec-body">{children}</div>
    </details>
  )
}

const ANGLE_PRESETS = [0, 45, 90, 135, 180, 225, 270, 315]

/** current stops of a fill: explicit multi-stop list, or the legacy 2-color pair */
function fillStops(f: OverlayFill): { color: string; at: number }[] {
  if (f.stops && f.stops.length >= 2) return f.stops
  return [
    { color: f.color, at: 0 },
    { color: f.color2, at: 100 }
  ]
}

/** solid/gradient fill editor: kind toggle, multi-stop colors, opacity, angle presets + swatch */
function FillEditor({ value, onChange }: { value: OverlayFill; onChange: (f: OverlayFill) => void }): React.JSX.Element {
  const t = useT()
  const f = value
  const stops = fillStops(f)
  const sorted = [...stops].sort((a, b) => a.at - b.at)
  const css =
    f.kind === 'gradient'
      ? `linear-gradient(${f.angle}deg, ${sorted.map((s) => `${s.color} ${s.at}%`).join(', ')})`
      : f.color
  // keep color/color2 mirrored to the outer stops so anything still reading them stays sane
  const setStops = (next: { color: string; at: number }[]): void => {
    const srt = [...next].sort((a, b) => a.at - b.at)
    onChange({ ...f, stops: next, color: srt[0]?.color ?? f.color, color2: srt[srt.length - 1]?.color ?? f.color2 })
  }
  return (
    <div className="oe-fill">
      <div className="oe-fill-row">
        <button className={f.kind === 'solid' ? 'active' : ''} onClick={() => onChange({ ...f, kind: 'solid' })}>
          {t('oe.fill.solid')}
        </button>
        <button className={f.kind === 'gradient' ? 'active' : ''} onClick={() => onChange({ ...f, kind: 'gradient' })}>
          {t('oe.fill.gradient')}
        </button>
        <span className="oe-fill-swatch" style={{ background: css, opacity: f.opacity }} />
        {f.kind === 'solid' && (
          <ColorField value={f.color} defaultValue="#000000" onChange={(v) => onChange({ ...f, color: v })} />
        )}
      </div>
      {f.kind === 'gradient' && (
        <>
          {/* one row per stop: color + position 0..100% + remove */}
          {stops.map((s, i) => (
            <div className="oe-fill-row" key={i}>
              <ColorField
                value={s.color}
                defaultValue={s.color}
                onChange={(v) => setStops(stops.map((x, j) => (j === i ? { ...x, color: v } : x)))}
              />
              <input
                type="range"
                min={0}
                max={100}
                value={s.at}
                onChange={(e) =>
                  setStops(stops.map((x, j) => (j === i ? { ...x, at: parseInt(e.target.value, 10) } : x)))
                }
              />
              <span style={{ width: 34, textAlign: 'right', color: 'var(--text-muted)' }}>{s.at}%</span>
              <button
                className="ghost"
                disabled={stops.length <= 2}
                onClick={() => setStops(stops.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="oe-fill-row">
            <button
              onClick={() => {
                // insert a mid stop between the two widest-apart neighbours
                const srt = [...stops].sort((a, b) => a.at - b.at)
                let gapAt = 50
                let best = -1
                for (let i = 0; i < srt.length - 1; i++) {
                  const gap = srt[i + 1].at - srt[i].at
                  if (gap > best) {
                    best = gap
                    gapAt = Math.round((srt[i].at + srt[i + 1].at) / 2)
                  }
                }
                setStops([...stops, { color: '#ffffff', at: gapAt }])
              }}
            >
              + {t('oe.fill.addStop')}
            </button>
          </div>
          <div className="oe-fill-row oe-angles">
            {ANGLE_PRESETS.map((a) => (
              <button key={a} className={f.angle === a ? 'active' : ''} onClick={() => onChange({ ...f, angle: a })}>
                {a}°
              </button>
            ))}
            <Num v={f.angle} on={(n) => onChange({ ...f, angle: n })} min={0} max={360} w={56} />
          </div>
        </>
      )}
      <div className="oe-fill-row">
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(f.opacity * 100)}
          onChange={(e) => onChange({ ...f, opacity: parseInt(e.target.value, 10) / 100 })}
        />
        <span style={{ width: 38, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round(f.opacity * 100)}%</span>
      </div>
    </div>
  )
}

export default function OverlayEditorWindow({ overlayId }: { overlayId: string }): React.JSX.Element {
  const t = useT()
  const settings = useSettingsStore((s) => s.settings)
  const set = useSettingsStore((s) => s.setSettings)
  const tabs = useLayoutStore((s) => s.tabs)
  const ov = settings.chatOverlays.find((o) => o.id === overlayId)

  const channels = useMemo(() => {
    const out: string[] = []
    for (const tb of tabs) for (const p of tb.panes) if (!out.includes(p.channel)) out.push(p.channel)
    return out
  }, [tabs])
  const [channel, setChannel] = useState(() => ov?.channel || channels[0] || '')
  // preview background: judge readability on checkerboard / a color / your own screenshot
  const [pvMode, setPvMode] = useState<'checker' | 'color' | 'image'>('checker')
  const [pvColor, setPvColor] = useState('#3f4652')
  const [pvImage, setPvImage] = useState<string | undefined>(() => localStorage.getItem('sticki:oePvImage') ?? undefined)
  const [presetName, setPresetName] = useState('')
  const [demo, setDemo] = useState(true)
  // preview zoom/pan + the single-message visual edit mode
  const [editMode, setEditMode] = useState(false)
  const [pvZoom, setPvZoom] = useState(1)
  const [pvPan, setPvPan] = useState({ x: 0, y: 0 })
  const capRef = useRef<HTMLDivElement>(null)
  const panDrag = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null)
  const zoomRef = useRef(1)
  zoomRef.current = pvZoom
  const panPosRef = useRef({ x: 0, y: 0 })
  panPosRef.current = pvPan
  const pushTimer = useRef<number | null>(null)
  const cssRef = useRef<HTMLTextAreaElement>(null)
  // Ctrl+Z: undo stack of config snapshots (grouped — at most one snapshot per 500ms burst)
  const undoStack = useRef<ChatOverlayConfig[]>([])
  const undoing = useRef(false)
  const lastSnap = useRef(0)
  const updateRef = useRef<(patch: Partial<ChatOverlayConfig>) => void>(() => {})
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.code !== 'KeyZ') return
      const el = e.target as HTMLElement | null
      // let text fields keep their native text undo
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      const prev = undoStack.current.pop()
      if (!prev) return
      e.preventDefault()
      undoing.current = true
      try {
        updateRef.current(prev)
      } finally {
        undoing.current = false
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // edit-mode patches arrive from the preview iframe (dragging/scaling elements)
  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      const d = e.data as { __oeEdit?: boolean; patch?: Partial<ChatOverlayConfig> } | null
      if (d && d.__oeEdit && d.patch) updateRef.current(d.patch)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // wheel-zoom around the cursor on the preview capture layer (regular mode only)
  useEffect(() => {
    const el = capRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const oldZ = zoomRef.current
      const z = Math.min(4, Math.max(0.4, oldZ * Math.pow(1.15, -e.deltaY / 100)))
      const pp = panPosRef.current
      setPvPan({ x: cx - ((cx - pp.x) * z) / oldZ, y: cy - ((cy - pp.y) * z) / oldZ })
      setPvZoom(z)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [editMode])

  if (!ov) {
    return (
      <div className="app oe-root">
        <div className="modal-header">
          {t('oe.title')}
          <div className="spacer" />
          <button className="ghost" onClick={() => window.close()}>✕</button>
        </div>
        <p style={{ padding: 20 }}>{t('oe.missing')}</p>
      </div>
    )
  }

  const update = (patch: Partial<ChatOverlayConfig>): void => {
    const fresh = useSettingsStore.getState().settings
    const cur = fresh.chatOverlays.find((o) => o.id === overlayId)
    if (cur && !undoing.current && Date.now() - lastSnap.current > 500) {
      undoStack.current.push(JSON.parse(JSON.stringify(cur)) as ChatOverlayConfig)
      if (undoStack.current.length > 60) undoStack.current.shift()
      lastSnap.current = Date.now()
    }
    const next = fresh.chatOverlays.map((o) => (o.id === overlayId ? { ...o, ...patch } : o))
    set({ chatOverlays: next })
    // push to the overlay server slightly debounced: every cfg event makes the page rebuild
    // all visible lines, and doing that on EVERY keystroke/slider tick froze the preview
    // (especially with GIF plate backgrounds re-decoding on each rebuild)
    if (pushTimer.current !== null) window.clearTimeout(pushTimer.current)
    pushTimer.current = window.setTimeout(() => {
      pushTimer.current = null
      const s2 = useSettingsStore.getState().settings
      const styles: Record<string, unknown> = {}
      for (const o of s2.chatOverlays) {
        const custom = s2.customFonts.find((f) => f.name === o.font)
        styles[o.id] = { ...o, fontData: custom?.data }
      }
      window.sticki.overlayConfigure(true, s2.overlayPort, styles)
    }, 200)
  }

  updateRef.current = update

  const applyPreset = (patch: Partial<ChatOverlayConfig>): void => {
    // a preset is a full restart from defaults + its own overrides — predictable results
    update({ ...DEFAULT_CHAT_OVERLAY, ...patch, id: ov.id, name: ov.name, channel: ov.channel, type: 'chat' })
  }

  const previewUrl = `http://127.0.0.1:${settings.overlayPort}/overlay?channel=${encodeURIComponent(channel)}&profile=${encodeURIComponent(ov.id)}${editMode ? '&edit=1' : demo ? '&preview=1' : ''}`
  const obsUrl = `http://127.0.0.1:${settings.overlayPort}/overlay?channel=${encodeURIComponent(channel)}&profile=${encodeURIComponent(ov.id)}`

  const pvStyle: React.CSSProperties =
    pvMode === 'color'
      ? { background: pvColor }
      : pvMode === 'image' && pvImage
        ? { backgroundImage: `url('${pvImage}')`, backgroundSize: 'cover', backgroundPosition: 'center' }
        : {}

  const updDecor = (id: string, patch: Partial<OverlayDecor>): void =>
    update({ decors: ov.decors.map((d) => (d.id === id ? { ...d, ...patch } : d)) })

  const updTrigger = (id: string, patch: Partial<OverlayTrigger>): void =>
    update({ triggers: ov.triggers.map((x) => (x.id === id ? { ...x, ...patch } : x)) })

  return (
    <div className="app oe-root">
      <div className="modal-header">
        {t('oe.title')}
        <input
          className="oe-name"
          value={ov.name}
          spellCheck={false}
          onChange={(e) => update({ name: e.target.value })}
        />
        <div className="spacer" />
        <button
          onClick={() => navigator.clipboard?.writeText(obsUrl)}
          title={obsUrl}
        >
          📋 {t('oe.copyUrl')}
        </button>
        <button className="ghost" onClick={() => window.close()}>✕</button>
      </div>

      <div className="oe-body">
        {/* ---------------- left: control sections ---------------- */}
        <div className="oe-side">
          <Sec title={`✨ ${t('oe.sec.presets')}`} defaultOpen>
            <div className="oe-presets">
              {OVERLAY_PRESETS.map((p) => (
                <button key={p.id} onClick={() => applyPreset(p.patch)}>
                  {p.name}
                </button>
              ))}
              <button className="oe-random" onClick={() => applyPreset(randomizeOverlay())}>
                🎲 {t('oe.random')}
              </button>
            </div>
            {settings.overlayUserPresets.length > 0 && (
              <>
                <div className="set-group-title" style={{ marginTop: 10 }}>{t('oe.userPresets')}</div>
                <div className="oe-presets">
                  {settings.overlayUserPresets.map((p) => (
                    <span key={p.id} className="oe-user-preset">
                      <button onClick={() => applyPreset(p.patch)}>{p.name}</button>
                      <button
                        className="danger"
                        title={t('oe.presetDelete')}
                        onClick={() =>
                          set({ overlayUserPresets: settings.overlayUserPresets.filter((x) => x.id !== p.id) })
                        }
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              </>
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}>
              <input
                placeholder={t('oe.presetName')}
                value={presetName}
                spellCheck={false}
                style={{ flex: 1, minWidth: 0 }}
                onChange={(e) => setPresetName(e.target.value)}
              />
              <button
                disabled={!presetName.trim()}
                title={t('oe.presetSave.hint')}
                onClick={() => {
                  const { id: _i, name: _n, type: _t2, ...patch } = ov
                  set({
                    overlayUserPresets: [
                      ...settings.overlayUserPresets,
                      { id: nextId('ovp'), name: presetName.trim(), patch }
                    ]
                  })
                  setPresetName('')
                }}
              >
                💾 {t('oe.presetSave')}
              </button>
            </div>
          </Sec>

          <Sec title={`🧩 ${t('oe.sec.layout')}`} defaultOpen>
            <Row label={t('oe.layout')}>
              <select value={ov.layout} onChange={(e) => update({ layout: e.target.value as ChatOverlayConfig['layout'] })}>
                <option value="list">{t('oe.layout.list')}</option>
                <option value="bubble">{t('oe.layout.bubble')}</option>
                <option value="compact">{t('oe.layout.compact')}</option>
                <option value="horizontal">{t('oe.layout.horizontal')}</option>
              </select>
            </Row>
            <Row label={t('oe.direction')}>
              <select value={ov.direction} onChange={(e) => update({ direction: e.target.value as 'up' | 'down' })}>
                <option value="up">{t('oe.direction.up')}</option>
                <option value="down">{t('oe.direction.down')}</option>
              </select>
            </Row>
            {ov.layout === 'horizontal' && (
              <Row label={t('oe.anchor')}>
                <select value={ov.anchor} onChange={(e) => update({ anchor: e.target.value as 'top' | 'bottom' })}>
                  <option value="bottom">{t('oe.anchor.bottom')}</option>
                  <option value="top">{t('oe.anchor.top')}</option>
                </select>
              </Row>
            )}
            <Row label={t('oe.align')}>
              <select value={ov.align} onChange={(e) => update({ align: e.target.value as ChatOverlayConfig['align'] })}>
                <option value="left">{t('overlay.align.left')}</option>
                <option value="center">{t('overlay.align.center')}</option>
                <option value="right">{t('overlay.align.right')}</option>
              </select>
            </Row>
            <Row label={t('oe.max')}>
              <Num v={ov.maxMessages} on={(n) => update({ maxMessages: n })} min={1} max={60} />
            </Row>
            <Row label={t('oe.fadeAfter')} hint={t('oe.fadeAfter.hint')}>
              <Num v={ov.fadeAfter} on={(n) => update({ fadeAfter: n })} min={0} max={600} />
            </Row>
            <Row label={t('oe.lineGap')}>
              <Num v={ov.lineGap} on={(n) => update({ lineGap: n })} min={0} max={40} />
            </Row>
            <Toggle label={t('oe.smoothScroll')} value={ov.smoothScroll} onChange={(v) => update({ smoothScroll: v })} />
            {ov.smoothScroll && (
              <Row label={t('oe.smoothScrollMs')} hint={t('oe.smoothScroll.hint')}>
                <Num v={ov.smoothScrollMs} on={(n) => update({ smoothScrollMs: n })} min={100} max={2000} step={50} />
              </Row>
            )}
            <Row label={t('oe.zonePad')}>
              <Num v={ov.zonePad} on={(n) => update({ zonePad: n })} min={0} max={80} />
            </Row>
            <Row label={t('oe.edgeFade')} hint={t('oe.edgeFade.hint')}>
              <Num v={ov.edgeFade} on={(n) => update({ edgeFade: n })} min={0} max={400} />
            </Row>
            <div className="oe-block-label">{t('oe.persp')}</div>
            <Row label={t('oe.persp.tiltX')} hint={t('oe.persp.hint')}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="range"
                  min={-60}
                  max={60}
                  value={ov.tiltX}
                  title={t('oe.rmbReset')}
                  onChange={(e) => update({ tiltX: parseInt(e.target.value, 10) })}
                  onContextMenu={(e) => { e.preventDefault(); update({ tiltX: 0 }) }}
                />
                <Num v={ov.tiltX} on={(n) => update({ tiltX: n })} min={-60} max={60} w={56} def={0} />
                <span className="hint">°</span>
              </div>
            </Row>
            <Row label={t('oe.persp.tiltY')}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="range"
                  min={-60}
                  max={60}
                  value={ov.tiltY}
                  title={t('oe.rmbReset')}
                  onChange={(e) => update({ tiltY: parseInt(e.target.value, 10) })}
                  onContextMenu={(e) => { e.preventDefault(); update({ tiltY: 0 }) }}
                />
                <Num v={ov.tiltY} on={(n) => update({ tiltY: n })} min={-60} max={60} w={56} def={0} />
                <span className="hint">°</span>
              </div>
            </Row>
            <Row label={t('oe.persp.rotate')}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="range"
                  min={-45}
                  max={45}
                  value={ov.rotate}
                  title={t('oe.rmbReset')}
                  onChange={(e) => update({ rotate: parseInt(e.target.value, 10) })}
                  onContextMenu={(e) => { e.preventDefault(); update({ rotate: 0 }) }}
                />
                <Num v={ov.rotate} on={(n) => update({ rotate: n })} min={-45} max={45} w={56} def={0} />
                <span className="hint">°</span>
              </div>
            </Row>
            {(ov.tiltX !== 0 || ov.tiltY !== 0) && (
              <Row label={t('oe.persp.depth')} hint={t('oe.persp.depth.hint')}>
                <Num v={ov.perspDepth} on={(n) => update({ perspDepth: n })} min={100} max={3000} w={72} def={800} />
              </Row>
            )}
            <Row label={t('oe.zoneOffset')} hint={t('oe.zoneOffset.hint')}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Num v={ov.zoneOffsetX} on={(n) => update({ zoneOffsetX: n })} min={-2000} max={2000} w={62} def={0} />
                <Num v={ov.zoneOffsetY} on={(n) => update({ zoneOffsetY: n })} min={-2000} max={2000} w={62} def={0} />
                <span className="hint">px</span>
              </div>
            </Row>
          </Sec>

          <Sec title={`🎬 ${t('oe.sec.anim')}`}>
            <div className="oe-block-label">{t('oe.animIn')}</div>
            <Row label={t('oe.animType')}>
              <select value={ov.animIn} onChange={(e) => update({ animIn: e.target.value as AnimInKind })}>
                <option value="none">{t('oe.anim.none')}</option>
                {ANIM_IN.map((a) => (
                  <option key={a} value={a}>
                    {ANIM_LABEL[a] ?? a}
                  </option>
                ))}
              </select>
            </Row>
            {DIRECTIONAL_IN.has(ov.animIn) && (
              <Row label={t('oe.animDir')} hint={t('oe.animDir.hint')}>
                <select value={ov.animDir} onChange={(e) => update({ animDir: e.target.value as ChatOverlayConfig['animDir'] })}>
                  <option value="down">↑ {t('oe.animDir.down')}</option>
                  <option value="up">↓ {t('oe.animDir.up')}</option>
                  <option value="left">→ {t('oe.animDir.left')}</option>
                  <option value="right">← {t('oe.animDir.right')}</option>
                </select>
              </Row>
            )}
            {ov.animIn !== 'none' && (
              <Row label={t('oe.animInMs')}>
                <Num
                  v={Math.round((ov.animInMs ?? ov.animMs) / 100) / 10}
                  on={(n) => update({ animInMs: Math.round(n * 1000) })}
                  min={0.05}
                  max={4}
                  w={72}
                  step={0.05}
                  def={0.3}
                />
              </Row>
            )}
            <div className="oe-block-label">{t('oe.animOut')}</div>
            <Row label={t('oe.animType')}>
              <select value={ov.animOut} onChange={(e) => update({ animOut: e.target.value as AnimOutKind })}>
                <option value="none">{t('oe.anim.none')}</option>
                {ANIM_OUT.map((a) => (
                  <option key={a} value={a}>
                    {ANIM_LABEL[a] ?? a}
                  </option>
                ))}
              </select>
            </Row>
            {DIRECTIONAL_OUT.has(ov.animOut) && (
              <Row label={t('oe.animOutDir')} hint={t('oe.animOutDir.hint')}>
                <select
                  value={ov.animOutDir ?? 'left'}
                  onChange={(e) => update({ animOutDir: e.target.value as ChatOverlayConfig['animOutDir'] })}
                >
                  <option value="left">← {t('oe.animDir.left')}</option>
                  <option value="right">→ {t('oe.animDir.right')}</option>
                  <option value="up">↑ {t('oe.animDir.up')}</option>
                  <option value="down">↓ {t('oe.animDir.down')}</option>
                </select>
              </Row>
            )}
            {ov.animOut !== 'none' && (
              <Row label={t('oe.animOutMs')}>
                <Num
                  v={Math.round((ov.animOutMs ?? ov.animMs) / 100) / 10}
                  on={(n) => update({ animOutMs: Math.round(n * 1000) })}
                  min={0.05}
                  max={4}
                  w={72}
                  step={0.05}
                  def={0.3}
                />
              </Row>
            )}
          </Sec>

          <Sec title={`🔤 ${t('oe.sec.text')}`}>
            <Row label={t('set.fontFamily')}>
              <FontPicker value={ov.font} onChange={(v) => update({ font: v })} />
            </Row>
            <Row label={t('set.fontSize')}>
              <Num v={ov.fontSize} on={(n) => update({ fontSize: n })} min={8} max={64} />
            </Row>
            <Toggle label={t('overlay.bold')} value={ov.bold} onChange={(v) => update({ bold: v })} />
            <Toggle label={t('oe.italic')} value={ov.italic} onChange={(v) => update({ italic: v })} />
            <Row label={t('oe.meStyle')} hint={t('oe.meStyle.hint')}>
              <select value={ov.meStyle} onChange={(e) => update({ meStyle: e.target.value as ChatOverlayConfig['meStyle'] })}>
                <option value="colored">{t('oe.meStyle.colored')}</option>
                <option value="plain">{t('oe.meStyle.plain')}</option>
              </select>
            </Row>
            <Row label={t('oe.textTransform')}>
              <select
                value={ov.textTransform}
                onChange={(e) => update({ textTransform: e.target.value as ChatOverlayConfig['textTransform'] })}
              >
                <option value="none">{t('oe.nickTransform.none')}</option>
                <option value="upper">ABCD</option>
                <option value="lower">abcd</option>
              </select>
            </Row>
            <Row label={t('overlay.textColor')}>
              <ColorField value={ov.textColor} defaultValue="#ffffff" onChange={(v) => update({ textColor: v })} />
            </Row>
            <Row label={t('overlay.outline')}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Num v={ov.outlineWidth} on={(n) => update({ outlineWidth: n })} min={0} max={6} w={54} />
                <ColorField value={ov.outlineColor} defaultValue="#000000" onChange={(v) => update({ outlineColor: v })} />
              </div>
            </Row>
            <Row label={t('overlay.textShadow')}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Num v={ov.shadowBlur} on={(n) => update({ shadowBlur: n })} min={0} max={40} w={54} />
                <ColorField value={ov.shadowColor} defaultValue="#000000" onChange={(v) => update({ shadowColor: v })} />
              </div>
            </Row>
            <Row label={t('overlay.glow')}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Num v={ov.glowSize} on={(n) => update({ glowSize: n })} min={0} max={30} w={54} />
                <ColorField value={ov.glowColor} defaultValue="#a970ff" onChange={(v) => update({ glowColor: v })} />
              </div>
            </Row>
            <Row label={t('oe.emoteScale')}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="range"
                  min={10}
                  max={30}
                  value={Math.round(ov.emoteScale * 10)}
                  onChange={(e) => update({ emoteScale: parseInt(e.target.value, 10) / 10 })}
                />
                <span style={{ width: 38, textAlign: 'right', color: 'var(--text-muted)' }}>{ov.emoteScale.toFixed(1)}×</span>
              </div>
            </Row>
          </Sec>

          <Sec title={`🧱 ${t('oe.sec.plate')}`}>
            <Row label={t('overlay.bgMode')}>
              <select value={ov.plateMode} onChange={(e) => update({ plateMode: e.target.value as ChatOverlayConfig['plateMode'] })}>
                <option value="none">{t('overlay.bgMode.none')}</option>
                <option value="fit">{t('overlay.bgMode.fit')}</option>
                <option value="line">{t('overlay.bgMode.line')}</option>
                <option value="panel">{t('overlay.bgMode.panel')}</option>
              </select>
            </Row>
            {ov.plateMode !== 'none' && (
              <>
                <div className="oe-block-label">{t('overlay.bg')}</div>
                <FillEditor value={ov.plateBg} onChange={(f) => update({ plateBg: f })} />
                <Row label={t('oe.shape')}>
                  <select value={ov.plateShape} onChange={(e) => update({ plateShape: e.target.value as ChatOverlayConfig['plateShape'] })}>
                    <option value="rect">{t('oe.shape.rect')}</option>
                    <option value="pill">{t('oe.shape.pill')}</option>
                    <option value="slant">{t('oe.shape.slant')}</option>
                    <option value="notch">{t('oe.shape.notch')}</option>
                  </select>
                </Row>
                {(ov.plateShape === 'slant' || ov.plateShape === 'notch') && (
                  <Row label={t('oe.shapeSize')} hint={t('oe.shapeSize.hint')}>
                    <Num v={ov.plateShapeSize} on={(n) => update({ plateShapeSize: n })} min={2} max={60} w={56} def={12} />
                  </Row>
                )}
                <Row label={t('oe.plateDepth')} hint={t('oe.plateDepth.hint')}>
                  <Num v={ov.plateDepth} on={(n) => update({ plateDepth: n })} min={0} max={20} w={56} def={0} />
                </Row>
                <Row label={t('oe.plateAnim')} hint={t('oe.plateAnim.hint')}>
                  <select value={ov.plateAnim} onChange={(e) => update({ plateAnim: e.target.value as ChatOverlayConfig['plateAnim'] })}>
                    <option value="none">{t('oe.anim.none')}</option>
                    <option value="blink">{t('oe.plateAnim.blink')}</option>
                    <option value="flow">{t('oe.plateAnim.flow')}</option>
                    <option value="candle">{t('oe.plateAnim.candle')}</option>
                  </select>
                </Row>
                {ov.plateAnim !== 'none' && (
                  <>
                    <Row label={t('oe.plateAnim.colors')}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {ov.plateAnimColors.map((c, i) => (
                          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                            <ColorField
                              value={c}
                              defaultValue={c}
                              onChange={(v) => update({ plateAnimColors: ov.plateAnimColors.map((x, j) => (j === i ? v : x)) })}
                            />
                            <button
                              className="ghost"
                              disabled={ov.plateAnimColors.length <= 1}
                              onClick={() => update({ plateAnimColors: ov.plateAnimColors.filter((_, j) => j !== i) })}
                            >
                              ✕
                            </button>
                          </span>
                        ))}
                        <button onClick={() => update({ plateAnimColors: [...ov.plateAnimColors, '#ffffff'] })}>+</button>
                      </div>
                    </Row>
                    <Row label={t('oe.plateAnim.speed')}>
                      <Num v={ov.plateAnimSpeed} on={(n) => update({ plateAnimSpeed: n })} min={0.2} max={20} w={62} step={0.1} def={2} />
                    </Row>
                    <Toggle label={t('oe.plateAnim.sync')} hint={t('oe.plateAnim.sync.hint')} value={ov.plateAnimSync} onChange={(v) => update({ plateAnimSync: v })} />
                  </>
                )}
                {ov.plateShape === 'rect' && (
                  <Row label={t('overlay.bgRadius')} hint={t('oe.radius.hint')}>
                    {(() => {
                      const setRad = (i: number) => (n: number) => {
                        const next = [...ov.plateRadius] as ChatOverlayConfig['plateRadius']
                        next[i] = n
                        update({ plateRadius: next })
                      }
                      // layout mirrors the plate: top row = top corners, bottom row = bottom
                      return (
                        <div className="oe-radius-grid">
                          <label title={t('oe.radius.tl')}>⌜<Num v={ov.plateRadius[0]} w={46} max={80} on={setRad(0)} /></label>
                          <label title={t('oe.radius.tr')}><Num v={ov.plateRadius[1]} w={46} max={80} on={setRad(1)} />⌝</label>
                          <label title={t('oe.radius.bl')}>⌞<Num v={ov.plateRadius[3]} w={46} max={80} on={setRad(3)} /></label>
                          <label title={t('oe.radius.br')}><Num v={ov.plateRadius[2]} w={46} max={80} on={setRad(2)} />⌟</label>
                        </div>
                      )
                    })()}
                  </Row>
                )}
                <Row label={t('oe.border')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Num v={ov.plateBorderWidth} on={(n) => update({ plateBorderWidth: n })} min={0} max={8} w={50} />
                    <select value={ov.plateBorderStyle} onChange={(e) => update({ plateBorderStyle: e.target.value as ChatOverlayConfig['plateBorderStyle'] })}>
                      <option value="solid">solid</option>
                      <option value="dashed">dashed</option>
                      <option value="dotted">dotted</option>
                      <option value="double">double</option>
                    </select>
                    <ColorField value={ov.plateBorderColor} defaultValue="#ffffff" onChange={(v) => update({ plateBorderColor: v })} />
                  </div>
                </Row>
                {ov.plateBorderWidth > 0 && (
                  <Row label={t('oe.borderFx')} hint={t('oe.borderFx.hint')}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round((ov.plateBorderOpacity ?? 1) * 100)}
                        onChange={(e) => update({ plateBorderOpacity: parseInt(e.target.value, 10) / 100 })}
                      />
                      <span style={{ width: 34, textAlign: 'right', color: 'var(--text-muted)' }}>
                        {Math.round((ov.plateBorderOpacity ?? 1) * 100)}%
                      </span>
                      <Num v={ov.plateBorderBlur} on={(n) => update({ plateBorderBlur: n })} min={0} max={40} w={50} />
                    </div>
                  </Row>
                )}
                <Row label={t('oe.plateShadow')} hint={t('oe.plateShadow.hint')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Num v={ov.plateShadowX} on={(n) => update({ plateShadowX: n })} min={-40} max={40} w={50} />
                    <Num v={ov.plateShadowY} on={(n) => update({ plateShadowY: n })} min={-40} max={40} w={50} />
                    <Num v={ov.plateShadowBlur} on={(n) => update({ plateShadowBlur: n })} min={0} max={60} w={50} />
                    <ColorField value={ov.plateShadowColor} defaultValue="#000000" onChange={(v) => update({ plateShadowColor: v })} />
                  </div>
                </Row>
                <Row label={t('oe.plateGlow')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Num v={ov.plateGlowSize} on={(n) => update({ plateGlowSize: n })} min={0} max={40} w={50} />
                    <ColorField value={ov.plateGlowColor} defaultValue="#a970ff" onChange={(v) => update({ plateGlowColor: v })} />
                  </div>
                </Row>
                <Row label={t('oe.plateBlur')} hint={t('oe.plateBlur.hint')}>
                  <Num v={ov.plateBlur} on={(n) => update({ plateBlur: n })} min={0} max={40} w={54} />
                </Row>
                <Row label={t('oe.plateEdgeBlur')} hint={t('oe.plateEdgeBlur.hint')}>
                  <Num v={ov.plateEdgeBlur} on={(n) => update({ plateEdgeBlur: n })} min={0} max={60} w={54} />
                </Row>
                <Row label={t('overlay.plateSize')} hint={t('overlay.plateSize.hint')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Num v={ov.plateWidth} on={(n) => update({ plateWidth: n })} max={2000} w={64} />
                    <span className="hint">×</span>
                    <Num v={ov.plateHeight} on={(n) => update({ plateHeight: n })} max={2000} w={64} />
                    <span className="hint">px</span>
                  </div>
                </Row>
                <Row label={t('oe.platePad')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Num v={ov.platePadX} on={(n) => update({ platePadX: n })} max={60} w={54} />
                    <Num v={ov.platePadY} on={(n) => update({ platePadY: n })} max={60} w={54} />
                  </div>
                </Row>
                <Row label={t('overlay.bgImage')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label className="ghost" style={{ cursor: 'pointer' }}>
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          readFile(e.target.files?.[0], 4, (url) => update({ plateImage: url }))
                          e.target.value = ''
                        }}
                      />
                      <span className="hint">📁 {t('overlay.bgImage.upload')}</span>
                    </label>
                    {ov.plateImage && (
                      <>
                        <select value={ov.plateImageFit} onChange={(e) => update({ plateImageFit: e.target.value as ChatOverlayConfig['plateImageFit'] })}>
                          <option value="cover">cover</option>
                          <option value="contain">contain</option>
                          <option value="stretch">stretch</option>
                        </select>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          style={{ width: 80 }}
                          value={Math.round(ov.plateImageOpacity * 100)}
                          onChange={(e) => update({ plateImageOpacity: parseInt(e.target.value, 10) / 100 })}
                        />
                        <button className="danger" onClick={() => update({ plateImage: '' })}>✕</button>
                      </>
                    )}
                  </div>
                </Row>
                <Row label={t('oe.mask')} hint={t('oe.mask.hint')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <label className="ghost" style={{ cursor: 'pointer' }}>
                      <input
                        type="file"
                        accept="image/png,image/webp"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          readFile(e.target.files?.[0], 2, (url) => update({ plateMask: url }))
                          e.target.value = ''
                        }}
                      />
                      <span className="hint">📁 PNG</span>
                    </label>
                    {ov.plateMask && (
                      <button className="danger" onClick={() => update({ plateMask: '' })}>✕</button>
                    )}
                  </div>
                </Row>
              </>
            )}
          </Sec>

          <Sec title={`🏷 ${t('oe.sec.nick')}`}>
            <Row label={t('oe.nickPos')}>
              <select value={ov.nickPos} onChange={(e) => update({ nickPos: e.target.value as ChatOverlayConfig['nickPos'] })}>
                <option value="inline">{t('oe.nickPos.inline')}</option>
                <option value="above">{t('oe.nickPos.above')}</option>
              </select>
            </Row>
            <Toggle label={t('oe.nickFloat')} hint={t('oe.nickFloat.hint')} value={ov.nickFloat} onChange={(v) => update({ nickFloat: v, ...(v ? { nickPos: 'above' as const } : {}) })} />
            <Row label={t('oe.nickAlign')} hint={t('oe.nickAlign.hint')}>
              <select value={ov.nickAlign} onChange={(e) => update({ nickAlign: e.target.value as ChatOverlayConfig['nickAlign'] })}>
                <option value="left">{t('overlay.align.left')}</option>
                <option value="center">{t('overlay.align.center')}</option>
                <option value="right">{t('overlay.align.right')}</option>
              </select>
            </Row>
            <Row label={t('oe.nickOffset')} hint={t('oe.nickOffset.hint')}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Num v={ov.nickOffsetX} on={(n) => update({ nickOffsetX: n })} min={-100} max={100} w={56} />
                <Num v={ov.nickOffsetY} on={(n) => update({ nickOffsetY: n })} min={-100} max={100} w={56} />
                <span className="hint">px</span>
              </div>
            </Row>
            <Row label={t('oe.msgAlign')} hint={t('oe.msgAlign.hint')}>
              <select value={ov.msgAlign} onChange={(e) => update({ msgAlign: e.target.value as ChatOverlayConfig['msgAlign'] })}>
                <option value="left">{t('overlay.align.left')}</option>
                <option value="center">{t('overlay.align.center')}</option>
                <option value="right">{t('overlay.align.right')}</option>
              </select>
            </Row>
            <Row label={t('oe.nickColor')}>
              <select value={ov.nickColorMode} onChange={(e) => update({ nickColorMode: e.target.value as ChatOverlayConfig['nickColorMode'] })}>
                <option value="twitch">{t('oe.nickColor.twitch')}</option>
                <option value="fixed">{t('oe.nickColor.fixed')}</option>
                <option value="palette">{t('oe.nickColor.palette')}</option>
              </select>
            </Row>
            {ov.nickColorMode === 'fixed' && (
              <Row label={t('oe.nickFixed')}>
                <ColorField value={ov.nickFixedColor} defaultValue="#a970ff" onChange={(v) => update({ nickFixedColor: v })} />
              </Row>
            )}
            {ov.nickColorMode === 'palette' && (
              <Row label={t('oe.nickPalette')} hint={t('oe.nickPalette.hint')}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {ov.nickPalette.map((c, i) => (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <ColorField
                        value={c}
                        defaultValue={c}
                        onChange={(v) => update({ nickPalette: ov.nickPalette.map((x, j) => (j === i ? v : x)) })}
                      />
                      <button
                        className="ghost"
                        onClick={() => update({ nickPalette: ov.nickPalette.filter((_, j) => j !== i) })}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  <button onClick={() => update({ nickPalette: [...ov.nickPalette, '#ffffff'] })}>+</button>
                </div>
              </Row>
            )}
            <Toggle label={t('oe.nickBold')} value={ov.nickBold} onChange={(v) => update({ nickBold: v })} />
            <Toggle label={t('oe.nickItalic')} value={ov.nickItalic} onChange={(v) => update({ nickItalic: v })} />
            <Row label={t('oe.nickScale')}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="range"
                  min={60}
                  max={160}
                  value={ov.nickScale}
                  onChange={(e) => update({ nickScale: parseInt(e.target.value, 10) })}
                />
                <span style={{ width: 42, textAlign: 'right', color: 'var(--text-muted)' }}>{ov.nickScale}%</span>
              </div>
            </Row>
            <Row label={t('oe.nickTransform')}>
              <select value={ov.nickTransform} onChange={(e) => update({ nickTransform: e.target.value as ChatOverlayConfig['nickTransform'] })}>
                <option value="none">{t('oe.nickTransform.none')}</option>
                <option value="upper">ABCD</option>
                <option value="lower">abcd</option>
              </select>
            </Row>
            <Toggle label={t('oe.nickChip')} hint={t('oe.nickChip.hint')} value={ov.nickBgEnabled} onChange={(v) => update({ nickBgEnabled: v })} />
            {ov.nickBgEnabled && (
              <>
                <div className="oe-block-label">{t('oe.nickBg')}</div>
                <FillEditor value={ov.nickBg} onChange={(f) => update({ nickBg: f })} />
                <Row label={t('overlay.bgRadius')}>
                  <Num v={ov.nickBgRadius} on={(n) => update({ nickBgRadius: n })} max={999} w={64} />
                </Row>
                <Row label={t('oe.platePad')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Num v={ov.nickPadX} on={(n) => update({ nickPadX: n })} max={40} w={54} />
                    <Num v={ov.nickPadY} on={(n) => update({ nickPadY: n })} max={40} w={54} />
                  </div>
                </Row>
                <Row label={t('oe.border')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Num v={ov.nickBorderWidth} on={(n) => update({ nickBorderWidth: n })} min={0} max={8} w={50} />
                    <ColorField value={ov.nickBorderColor} defaultValue="#ffffff" onChange={(v) => update({ nickBorderColor: v })} />
                  </div>
                </Row>
                <Row label={t('overlay.bgShadow')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Num v={ov.nickShadowBlur} on={(n) => update({ nickShadowBlur: n })} min={0} max={40} w={50} />
                    <ColorField value={ov.nickShadowColor} defaultValue="#000000" onChange={(v) => update({ nickShadowColor: v })} />
                  </div>
                </Row>
                <Row label={t('oe.plateGlow')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Num v={ov.nickGlowSize} on={(n) => update({ nickGlowSize: n })} min={0} max={40} w={50} />
                    <ColorField value={ov.nickGlowColor} defaultValue="#a970ff" onChange={(v) => update({ nickGlowColor: v })} />
                  </div>
                </Row>
                <Row label={t('oe.plateBlur')} hint={t('oe.plateBlur.hint')}>
                  <Num v={ov.nickBlur} on={(n) => update({ nickBlur: n })} min={0} max={40} w={54} />
                </Row>
                <Row label={t('overlay.bgImage')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label className="ghost" style={{ cursor: 'pointer' }}>
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          readFile(e.target.files?.[0], 2, (url) => update({ nickImage: url }))
                          e.target.value = ''
                        }}
                      />
                      <span className="hint">📁 {t('overlay.bgImage.upload')}</span>
                    </label>
                    {ov.nickImage && (
                      <>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          style={{ width: 80 }}
                          value={Math.round(ov.nickImageOpacity * 100)}
                          onChange={(e) => update({ nickImageOpacity: parseInt(e.target.value, 10) / 100 })}
                        />
                        <button className="danger" onClick={() => update({ nickImage: '' })}>✕</button>
                      </>
                    )}
                  </div>
                </Row>
              </>
            )}
          </Sec>

          <Sec title={`👤 ${t('oe.sec.avatar')}`}>
            <Toggle label={t('oe.avatarShow')} hint={t('oe.avatarShow.hint')} value={ov.avatarShow} onChange={(v) => update({ avatarShow: v })} />
            {ov.avatarShow && (
              <>
                <Row label={t('oe.avatarPos')}>
                  <select value={ov.avatarPos} onChange={(e) => update({ avatarPos: e.target.value as 'left' | 'right' })}>
                    <option value="left">{t('overlay.align.left')}</option>
                    <option value="right">{t('overlay.align.right')}</option>
                  </select>
                </Row>
                <Row label={t('oe.avatarSize')}>
                  <Num v={ov.avatarSize} on={(n) => update({ avatarSize: n })} min={12} max={96} />
                </Row>
                <Row label={t('oe.avatarRadius')} hint={t('oe.avatarRadius.hint')}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="range"
                      min={0}
                      max={50}
                      value={ov.avatarRadius}
                      onChange={(e) => update({ avatarRadius: parseInt(e.target.value, 10) })}
                    />
                    <span style={{ width: 38, textAlign: 'right', color: 'var(--text-muted)' }}>{ov.avatarRadius}%</span>
                  </div>
                </Row>
              </>
            )}
            <Toggle label={t('overlay.badges')} value={ov.badgesShow} onChange={(v) => update({ badgesShow: v })} />
            {ov.badgesShow && (
              <>
                <Row label={t('oe.badgesPos')}>
                  <select value={ov.badgesPos} onChange={(e) => update({ badgesPos: e.target.value as 'before' | 'after' })}>
                    <option value="before">{t('oe.badgesPos.before')}</option>
                    <option value="after">{t('oe.badgesPos.after')}</option>
                  </select>
                </Row>
                <Row label={t('oe.badgeSize')}>
                  <Num v={ov.badgeSize} on={(n) => update({ badgeSize: n })} min={10} max={40} />
                </Row>
              </>
            )}
            <Toggle label={t('oe.tsShow')} value={ov.tsShow} onChange={(v) => update({ tsShow: v })} />
            {ov.tsShow && (
              <>
                <Toggle label={t('oe.tsSeconds')} value={ov.tsSeconds} onChange={(v) => update({ tsSeconds: v })} />
                <Row label={t('oe.tsPos')}>
                  <select value={ov.tsPos} onChange={(e) => update({ tsPos: e.target.value as ChatOverlayConfig['tsPos'] })}>
                    <option value="before">{t('oe.tsPos.before')}</option>
                    <option value="after">{t('oe.tsPos.after')}</option>
                  </select>
                </Row>
                <Row label={t('oe.tsColor')}>
                  <ColorField value={ov.tsColor} defaultValue="#b8b8c0" onChange={(v) => update({ tsColor: v })} />
                </Row>
              </>
            )}
          </Sec>

          <Sec title={`🎀 ${t('oe.sec.decor')}`}>
            <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>{t('oe.decor.hint')}</p>
            {ov.decors.map((d) => (
              <div key={d.id} className="oe-decor">
                <img src={d.image} alt="" />
                <div className="oe-decor-ctl">
                  <select value={d.anchor} onChange={(e) => updDecor(d.id, { anchor: e.target.value as OverlayDecor['anchor'] })}>
                    <option value="tl">↖</option>
                    <option value="tr">↗</option>
                    <option value="bl">↙</option>
                    <option value="br">↘</option>
                    <option value="top">↑</option>
                    <option value="bottom">↓</option>
                  </select>
                  <Num v={d.dx} on={(n) => updDecor(d.id, { dx: n })} min={-200} max={200} w={54} />
                  <Num v={d.dy} on={(n) => updDecor(d.id, { dy: n })} min={-200} max={200} w={54} />
                  <Num v={d.size} on={(n) => updDecor(d.id, { size: n })} min={8} max={400} w={54} />
                  <select value={d.scope} onChange={(e) => updDecor(d.id, { scope: e.target.value as 'message' | 'zone' })}>
                    <option value="message">{t('oe.decor.message')}</option>
                    <option value="zone">{t('oe.decor.zone')}</option>
                  </select>
                  <label className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <input type="checkbox" checked={d.above} onChange={(e) => updDecor(d.id, { above: e.target.checked })} />
                    {t('oe.decor.above')}
                  </label>
                  <button
                    title={t('oe.decor.up')}
                    disabled={ov.decors.indexOf(d) === 0}
                    onClick={() => {
                      const i = ov.decors.indexOf(d)
                      const next = [...ov.decors]
                      ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                      update({ decors: next })
                    }}
                  >
                    ↑
                  </button>
                  <button
                    title={t('oe.decor.down')}
                    disabled={ov.decors.indexOf(d) === ov.decors.length - 1}
                    onClick={() => {
                      const i = ov.decors.indexOf(d)
                      const next = [...ov.decors]
                      ;[next[i], next[i + 1]] = [next[i + 1], next[i]]
                      update({ decors: next })
                    }}
                  >
                    ↓
                  </button>
                  <button className="danger" onClick={() => update({ decors: ov.decors.filter((x) => x.id !== d.id) })}>✕</button>
                </div>
              </div>
            ))}
            <label className="ghost" style={{ cursor: 'pointer' }}>
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  readFile(e.target.files?.[0], 2, (url) =>
                    update({
                      decors: [
                        ...ov.decors,
                        { id: nextId('dec'), image: url, anchor: 'tr', dx: -8, dy: -8, size: 48, opacity: 1, above: true, scope: 'message' }
                      ]
                    })
                  )
                  e.target.value = ''
                }}
              />
              <span className="hint">📁 {t('oe.decor.add')}</span>
            </label>
          </Sec>

          <Sec title={`🎉 ${t('oe.sec.triggers')}`}>
            <p className="hint" style={{ color: 'var(--text-faint)', marginTop: 0 }}>{t('oe.triggers.hint')}</p>
            {ov.triggers.map((tr) => (
              <div key={tr.id} className="oe-decor">
                <img src={tr.image} alt="" />
                <div className="oe-decor-ctl">
                  <textarea
                    placeholder={t('oe.triggers.word')}
                    title={t('oe.triggers.word.hint')}
                    value={tr.word}
                    spellCheck={false}
                    rows={2}
                    style={{ width: 130, resize: 'vertical', minHeight: 34 }}
                    onChange={(e) => updTrigger(tr.id, { word: e.target.value })}
                  />
                  <select
                    title={t('oe.triggers.attach')}
                    value={tr.attach ?? 'screen'}
                    onChange={(e) => updTrigger(tr.id, { attach: e.target.value as OverlayTrigger['attach'] })}
                  >
                    <option value="screen">{t('oe.triggers.attach.screen')}</option>
                    <option value="message">{t('oe.triggers.attach.message')}</option>
                  </select>
                  <select value={tr.pos} onChange={(e) => updTrigger(tr.id, { pos: e.target.value as OverlayTrigger['pos'] })}>
                    <option value="tl">↖</option>
                    <option value="top">↑</option>
                    <option value="tr">↗</option>
                    <option value="left">←</option>
                    <option value="right">→</option>
                    <option value="bl">↙</option>
                    <option value="bottom">↓</option>
                    <option value="br">↘</option>
                  </select>
                  <Num v={tr.dx} on={(n) => updTrigger(tr.id, { dx: n })} min={-500} max={500} w={54} def={0} />
                  <Num v={tr.dy} on={(n) => updTrigger(tr.id, { dy: n })} min={-500} max={500} w={54} def={0} />
                  <Num v={tr.size} on={(n) => updTrigger(tr.id, { size: n })} min={16} max={600} w={54} def={96} />
                  <select value={tr.anim} onChange={(e) => updTrigger(tr.id, { anim: e.target.value as OverlayTrigger['anim'] })}>
                    <option value="pop">Pop</option>
                    <option value="bounce">Bounce</option>
                    <option value="fade">Fade</option>
                    <option value="slide">Slide</option>
                    <option value="wiggle">Wiggle</option>
                  </select>
                  <Num v={tr.durationS} on={(n) => updTrigger(tr.id, { durationS: n })} min={0} max={600} w={50} def={5} />
                  <span className="hint" title={t('oe.triggers.forever')}>{t('oe.triggers.sec')}</span>
                  <button className="danger" onClick={() => update({ triggers: ov.triggers.filter((x) => x.id !== tr.id) })}>✕</button>
                </div>
              </div>
            ))}
            <label className="ghost" style={{ cursor: 'pointer' }}>
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  readFile(e.target.files?.[0], 3, (url) =>
                    update({
                      triggers: [
                        ...ov.triggers,
                        { id: nextId('trg'), word: '', image: url, pos: 'br', dx: 16, dy: 16, size: 120, anim: 'pop', durationS: 5 }
                      ]
                    })
                  )
                  e.target.value = ''
                }}
              />
              <span className="hint">📁 {t('oe.triggers.add')}</span>
            </label>
          </Sec>

          <Sec title={`🫥 ${t('oe.sec.content')}`}>
            <Toggle label={t('overlay.hideCmd')} value={ov.hideCommands} onChange={(v) => update({ hideCommands: v })} />
            <Toggle label={t('overlay.showRedeems')} value={ov.showRedeems} onChange={(v) => update({ showRedeems: v })} />
            <Toggle label={t('overlay.showBits')} value={ov.showBits} onChange={(v) => update({ showBits: v })} />
            <Toggle label={t('overlay.showSubs')} value={ov.showSubs} onChange={(v) => update({ showSubs: v })} />
            <Toggle label={t('overlay.showModActions')} value={ov.showModActions} onChange={(v) => update({ showModActions: v })} />
            <Toggle label={t('oe.sound')} hint={t('oe.sound.hint')} value={ov.msgSoundEnabled} onChange={(v) => update({ msgSoundEnabled: v })} />
            {ov.msgSoundEnabled && (
              <Row label={t('oe.sound.file')}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label className="ghost" style={{ cursor: 'pointer' }}>
                    <input
                      type="file"
                      accept="audio/*"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        readFile(e.target.files?.[0], 1, (url) => update({ msgSoundData: url }))
                        e.target.value = ''
                      }}
                    />
                    <span className="hint">📁 {t('oe.sound.upload')}</span>
                  </label>
                  {ov.msgSoundData && (
                    <>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        style={{ width: 80 }}
                        value={Math.round(ov.msgSoundVolume * 100)}
                        onChange={(e) => update({ msgSoundVolume: parseInt(e.target.value, 10) / 100 })}
                      />
                      <button
                        title={t('oe.sound.test')}
                        onClick={() => {
                          const au = new Audio(ov.msgSoundData)
                          au.volume = ov.msgSoundVolume
                          au.play().catch(() => {})
                        }}
                      >
                        ▶
                      </button>
                      <button className="danger" onClick={() => update({ msgSoundData: '' })}>✕</button>
                    </>
                  )}
                </div>
              </Row>
            )}
            <Row label={t('overlay.profileHidden')}>
              <NickListArea value={ov.hiddenUsers} onCommit={(v) => update({ hiddenUsers: v })} />
            </Row>
          </Sec>

          <Sec title={`🧪 ${t('oe.sec.css')}`}>
            <p className="hint oe-selectable" style={{ color: 'var(--text-faint)', marginTop: 0 }}>
              {t('oe.css.hint')}{' '}
              <button
                className="ghost"
                style={{ padding: '0 6px' }}
                title={t('oe.copyHint')}
                onClick={() => navigator.clipboard?.writeText(t('oe.css.hint'))}
              >
                📋
              </button>
            </p>
            <textarea
              ref={cssRef}
              className="oe-css"
              rows={10}
              spellCheck={false}
              defaultValue={ov.customCss}
              placeholder={'.line { }\n.content { }\n.nick { }\n.body { }\n.avatar { }\n.meta { }'}
              onBlur={() => update({ customCss: cssRef.current?.value ?? '' })}
            />
            <button style={{ marginTop: 6 }} onClick={() => update({ customCss: cssRef.current?.value ?? '' })}>
              {t('oe.css.apply')}
            </button>
          </Sec>
        </div>

        {/* ---------------- center: live preview ---------------- */}
        <div className="oe-main">
          <div className="oe-toolbar">
            <label className="hint">{t('oe.channel')}</label>
            <select
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value)
                update({ channel: e.target.value })
              }}
            >
              {!channels.length && <option value="">—</option>}
              {channels.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }} title={t('oe.editMode.hint')}>
              <input type="checkbox" checked={editMode} onChange={(e) => setEditMode(e.target.checked)} />
              🖱 {t('oe.editMode')}
            </label>
            <label className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
              <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
              {t('oe.demo')}
            </label>
            <div className="spacer" />
            <label className="hint">{t('oe.pvBg')}</label>
            <button className={pvMode === 'checker' ? 'active' : ''} title={t('oe.pvBg.checker')} onClick={() => setPvMode('checker')}>
              ▦
            </button>
            <button className={pvMode === 'color' ? 'active' : ''} title={t('oe.pvBg.color')} onClick={() => setPvMode('color')}>
              🎨
            </button>
            {pvMode === 'color' && (
              <input type="color" value={pvColor} onChange={(e) => setPvColor(e.target.value)} />
            )}
            <label className={`ghost ${pvMode === 'image' ? 'active' : ''}`} style={{ cursor: 'pointer' }} title={t('oe.pvBg.image')}>
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  readFile(e.target.files?.[0], 8, (url) => {
                    setPvImage(url)
                    setPvMode('image')
                    try {
                      localStorage.setItem('sticki:oePvImage', url)
                    } catch {
                      /* quota */
                    }
                  })
                  e.target.value = ''
                }}
              />
              🖼
            </label>
          </div>
          <div className={`oe-preview ${pvMode === 'checker' ? 'checker' : ''}`} style={pvStyle}>
            <div
              className="oe-pv-inner"
              style={{ transform: `translate(${pvPan.x}px, ${pvPan.y}px) scale(${pvZoom})` }}
            >
              <iframe
                key={`${channel}:${settings.overlayPort}:${editMode ? 'e' : demo ? 1 : 0}`}
                src={previewUrl}
                title="overlay preview"
              />
            </div>
            {!editMode && (
              <div
                ref={capRef}
                className="oe-pv-capture"
                title={t('oe.pv.panHint')}
                onPointerDown={(e) => {
                  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
                  panDrag.current = { sx: e.clientX, sy: e.clientY, bx: pvPan.x, by: pvPan.y }
                }}
                onPointerMove={(e) => {
                  const d = panDrag.current
                  if (d) setPvPan({ x: d.bx + e.clientX - d.sx, y: d.by + e.clientY - d.sy })
                }}
                onPointerUp={() => {
                  panDrag.current = null
                }}
                onDoubleClick={() => {
                  setPvZoom(1)
                  setPvPan({ x: 0, y: 0 })
                }}
              />
            )}
            <div className="oe-pv-zoom">
              <button onClick={() => setPvZoom((z) => Math.max(0.4, z / 1.25))}>−</button>
              <button
                title={t('oe.pv.zoomReset')}
                onClick={() => {
                  setPvZoom(1)
                  setPvPan({ x: 0, y: 0 })
                }}
              >
                {Math.round(pvZoom * 100)}%
              </button>
              <button onClick={() => setPvZoom((z) => Math.min(4, z * 1.25))}>+</button>
            </div>
          </div>
          <p className="hint oe-note">{t('oe.note')}</p>
        </div>
      </div>
    </div>
  )
}
