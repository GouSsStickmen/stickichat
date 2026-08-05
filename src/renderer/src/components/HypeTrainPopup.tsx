import { useEffect, useState } from 'react'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { useT } from '../i18n'

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
        <b className="hype-title">🚂 {t('hype.title')}</b>
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
          🚂
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
