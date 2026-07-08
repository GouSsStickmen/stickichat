import { useEffect, useState } from 'react'
import { useT } from '../i18n'

type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

export default function UpdateBanner(): React.JSX.Element | null {
  const t = useT()
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    return window.sticki.onUpdateStatus((s) => {
      setStatus(s as UpdateStatus)
      setDismissed(false)
    })
  }, [])

  if (!status || dismissed) return null
  if (status.state === 'checking' || status.state === 'not-available' || status.state === 'error') return null

  return (
    <div className="update-banner">
      {status.state === 'available' && <span>⬇ {t('update.available', { version: status.version })}</span>}
      {status.state === 'downloading' && (
        <span>
          ⬇ {t('update.downloading')} — {Math.round(status.percent)}%
        </span>
      )}
      {status.state === 'downloaded' && (
        <>
          <span>✅ {t('update.ready', { version: status.version })}</span>
          <button className="primary" onClick={() => window.sticki.installUpdate()}>
            {t('update.restart')}
          </button>
        </>
      )}
      <div className="spacer" />
      <button className="ghost" onClick={() => setDismissed(true)}>
        ✕
      </button>
    </div>
  )
}
