import { useEffect, useState } from 'react'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { useT } from '../i18n'

/**
 * The locomotive, drawn rather than borrowed from the emoji font.
 *
 * 🚂 points left in most fonts and looks like whatever the OS decided that year. This one faces
 * the direction it travels, has big driving wheels that actually turn (spokes, so the rotation
 * reads), and the smoke is emitted behind it — the puffs drift backwards and fade, which is what
 * sells the speed. Wheels and smoke are pure CSS animation, so it costs nothing per frame.
 */
function Locomotive(): React.JSX.Element {
  return (
    <span className="hype-loco-wrap">
      {/* speed lines: they are emitted at the boiler and rush backwards past the engine */}
      <span className="hype-speed">
        <i style={{ top: '6px', animationDelay: '0s' }} />
        <i style={{ top: '12px', animationDelay: '0.25s' }} />
        <i style={{ top: '18px', animationDelay: '0.5s' }} />
      </span>
      <span className="hype-smoke">
        <i style={{ animationDelay: '0s' }} />
        <i style={{ animationDelay: '0.3s' }} />
        <i style={{ animationDelay: '0.6s' }} />
        <i style={{ animationDelay: '0.9s' }} />
      </span>
      {/* One flat colour, no outline: at this size an outline only muddies the silhouette.
          The window, the wheel rims and the spoke gaps are cut out in the panel colour, so the
          shape still reads and the spin is still visible. */}
      <svg className="hype-loco-svg" viewBox="0 0 52 46" width="38" height="34" aria-hidden="true">
        <g fill="var(--loco-body)">
          {/* cowcatcher — the wedge at the front */}
          <path d="M41 30l9 9h-9z" />
          {/* cab roof, overhanging on both sides */}
          <path d="M2 14h22v3.5H2z" />
          {/* cab */}
          <path d="M5 17h15v18H5z" />
          {/* boiler, rounded at the nose */}
          <path d="M19 24h21a5 5 0 0 1 0 11H19z" />
          {/* funnel: sits ON the boiler and flares upward, with its cap on top */}
          <path d="M32 24h5l2 -12h-9z" />
          <path d="M29 9h11v3.5H29z" />
          {/* steam dome between cab and funnel */}
          <path d="M23 24v-4.5a2.5 2.5 0 0 1 5 0V24z" />
          {/* running board */}
          <path d="M4 35h38v3.5H4z" />
        </g>
        {/* cab window, punched out */}
        <path d="M8 20.5h9v6.5H8z" fill="var(--loco-cut)" />
        {/* big driving wheel — rim, hollow centre, spokes and hub */}
        <g className="hype-wheel hype-wheel-back">
          <circle cx="14" cy="36" r="8" fill="var(--loco-body)" />
          <circle cx="14" cy="36" r="5.4" fill="var(--loco-cut)" />
          <path
            d="M14 30v12M8 36h12M10 32l8 8M18 32l-8 8"
            stroke="var(--loco-body)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <circle cx="14" cy="36" r="2" fill="var(--loco-body)" />
        </g>
        {/* two carrying wheels under the boiler */}
        <g className="hype-wheel hype-wheel-mid">
          <circle cx="28" cy="39" r="5" fill="var(--loco-body)" />
          <circle cx="28" cy="39" r="3" fill="var(--loco-cut)" />
          <path d="M28 36v6M25 39h6" stroke="var(--loco-body)" strokeWidth="1.4" strokeLinecap="round" />
        </g>
        <g className="hype-wheel hype-wheel-front">
          <circle cx="38" cy="39" r="5" fill="var(--loco-body)" />
          <circle cx="38" cy="39" r="3" fill="var(--loco-cut)" />
          <path d="M38 36v6M35 39h6" stroke="var(--loco-body)" strokeWidth="1.4" strokeLinecap="round" />
        </g>
      </svg>
    </span>
  )
}

/**
 * The hype train, live: a little train that rides along the track as the level fills.
 *
 * The train's position IS the progress bar — no separate bar to read, you see how far along the
 * level is by where the engine is. The countdown ticks locally off `expiresAt`, because PubSub
 * only tells us the deadline once per contribution and a frozen clock looks broken.
 */
export default function HypeTrainPopup(): React.JSX.Element | null {
  const train = useUiStore((s) => s.hypeTrain)
  const enabled = useSettingsStore((s) => s.settings.hypeTrainPopup)
  const t = useT()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!train) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [train])

  // a train nobody feeds simply expires; if the end event never arrives (socket died, channel
  // closed) the popup would sit there forever — so it also clears itself once the clock runs out
  useEffect(() => {
    if (!train || train.ended) return
    if (now < train.expiresAt + 30_000) return
    useUiStore.getState().setHypeTrain(null)
  }, [now, train])

  if (!train || !enabled) return null

  const pct = Math.max(0, Math.min(100, (train.value / Math.max(1, train.goal)) * 100))
  const left = Math.max(0, Math.round((train.expiresAt - now) / 1000))
  const mm = String(Math.floor(left / 60))
  const ss = String(left % 60).padStart(2, '0')

  return (
    <div className={`hype-train ${train.ended ? 'ended' : ''}`}>
      <div className="hype-head">
        <b className="hype-title">{t('hype.title')}</b>
        <span className="hype-level">{t('hype.level', { level: String(train.level) })}</span>
        <div className="spacer" />
        {!train.ended && <span className="hype-clock">{`${mm}:${ss}`}</span>}
        <button className="ghost" onClick={() => useUiStore.getState().setHypeTrain(null)}>
          ✕
        </button>
      </div>
      <div className="hype-track">
        <div className="hype-rail" />
        <div className="hype-fill" style={{ width: `${pct}%` }} />
        {/* the engine sits at the head of the filled section, nose forward */}
        <span className="hype-loco" style={{ left: `${pct}%` }}>
          <Locomotive />
        </span>
      </div>
      <div className="hype-foot">
        <span className="hype-channel">#{train.channel}</span>
        {train.ended ? (
          <span>{train.ended === 'COMPLETED' ? t('hype.completed') : t('hype.expired')}</span>
        ) : (
          train.by && <span className="hype-by">{t('hype.by', { user: train.by })}</span>
        )}
      </div>
    </div>
  )
}
