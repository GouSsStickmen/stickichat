import { useEffect, useState } from 'react'
import { useT } from '../i18n'

type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string; notes: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

export default function UpdateBanner(): React.JSX.Element | null {
  const t = useT()
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)

  useEffect(() => {
    return window.sticki.onUpdateStatus((s) => {
      setStatus(s as UpdateStatus)
      setDismissed(false)
    })
  }, [])

  if (!status || dismissed) return null
  if (status.state === 'checking' || status.state === 'not-available' || status.state === 'error') return null

  return (
    <div className="update-banner-wrap">
      <div className="update-banner">
        {status.state === 'available' && (
          <>
            <span>⬇ {t('update.found', { version: status.version })}</span>
            {status.notes && (
              <button className="ghost" onClick={() => setNotesOpen((v) => !v)}>
                {notesOpen ? t('update.hideNotes') : t('update.showNotes')}
              </button>
            )}
            <button className="primary" onClick={() => window.sticki.downloadUpdate()}>
              {t('update.download')}
            </button>
            <button className="ghost" onClick={() => setDismissed(true)}>
              {t('update.later')}
            </button>
          </>
        )}
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
      {notesOpen && status.state === 'available' && status.notes && (
        <div className="update-notes">{status.notes}</div>
      )}
    </div>
  )
}
