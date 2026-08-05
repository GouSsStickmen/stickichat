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
      <svg className="hype-loco-svg" viewBox="0 0 52 44" width="38" height="32" aria-hidden="true">
        <g strokeLinejoin="round" strokeLinecap="round" strokeWidth="2.6" stroke="var(--loco-line)">
          {/* cowcatcher — the wedge at the front, bottom right */}
          <path d="M42 30l8 8h-8z" fill="var(--loco-dark)" />
          {/* cab roof, overhanging on both sides */}
          <path d="M1 14h22v3H1z" fill="var(--loco-dark)" />
          {/* cab */}
          <path d="M4 17h16v17H4z" fill="var(--loco-body)" />
          {/* boiler: the long body, rounded at the front */}
          <path d="M20 24h20a5 5 0 0 1 0 10H20z" fill="var(--loco-dark)" />
          {/* funnel, flaring upward, with its cap */}
          <path d="M31 17h8l-2.5-9h-3z" fill="var(--loco-dark)" />
          <path d="M32.5 5h9v3h-9z" fill="var(--loco-body)" />
          {/* steam dome between cab and funnel */}
          <path d="M24 24v-5a2.5 2.5 0 0 1 5 0v5z" fill="var(--loco-body)" />
          {/* running board under the boiler */}
          <path d="M4 34h40v3H4z" fill="var(--loco-dark)" />
          {/* cab window */}
          <path d="M8 21h8v6H8z" fill="var(--loco-glass)" />
        </g>
        {/* big driving wheel under the cab, with a hub — the spokes make the spin readable */}
        <g className="hype-wheel hype-wheel-back">
          <circle cx="14" cy="35" r="7.5" fill="var(--loco-wheel)" stroke="var(--loco-line)" strokeWidth="2.6" />
          <circle cx="14" cy="35" r="2.5" fill="var(--loco-hub)" stroke="var(--loco-line)" strokeWidth="1.6" />
          <path
            d="M14 28v14M7 35h14M9.2 30.2l9.6 9.6M18.8 30.2l-9.6 9.6"
            stroke="var(--loco-line)"
            strokeWidth="1.3"
          />
        </g>
        {/* two carrying wheels under the boiler */}
        <g className="hype-wheel hype-wheel-mid">
          <circle cx="28" cy="38" r="4.5" fill="var(--loco-hub)" stroke="var(--loco-line)" strokeWidth="2.4" />
          <path d="M28 34v8M24 38h8" stroke="var(--loco-line)" strokeWidth="1.1" />
        </g>
        <g className="hype-wheel hype-wheel-front">
          <circle cx="38" cy="38" r="4.5" fill="var(--loco-hub)" stroke="var(--loco-line)" strokeWidth="2.4" />
          <path d="M38 34v8M34 38h8" stroke="var(--loco-line)" strokeWidth="1.1" />
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
