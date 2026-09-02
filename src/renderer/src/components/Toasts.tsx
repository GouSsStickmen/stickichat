import { useEffect, useRef, useState } from 'react'
import { useUiStore, type Toast } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { useT } from '../i18n'
import { AlertIcon, InfoIcon, CloseIcon } from './Icons'

/**
 * One toast, holding its own clock.
 *
 * The countdown used to live in the store, started the moment the toast was created and unable to
 * hear about anything afterwards. So a message you were still reading vanished mid-sentence, and
 * the longer the explanation the more likely that was. The clock lives here now: pointing at a
 * toast stops it, and it only resumes with what was left when the pointer leaves. Nothing
 * disappears while somebody is looking at it.
 */
function ToastRow({ toast }: { toast: Toast }): React.JSX.Element {
  const t = useT()
  const dismiss = useUiStore((s) => s.dismissToast)
  const [paused, setPaused] = useState(false)
  /** ms still owed when the timer was last stopped */
  const leftRef = useRef(toast.ms)
  const startedRef = useRef(0)

  useEffect(() => {
    if (paused) return
    startedRef.current = Date.now()
    const id = window.setTimeout(() => dismiss(toast.id), leftRef.current)
    return () => {
      window.clearTimeout(id)
      // spend only what actually elapsed, so a second hover does not restart the whole wait
      leftRef.current = Math.max(400, leftRef.current - (Date.now() - startedRef.current))
    }
  }, [paused, toast.id, dismiss])

  return (
    <div
      className={`toast ${toast.kind === 'error' ? 'error' : ''} ${paused ? 'held' : ''}`}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      {/* The header row exists so the close button has a fixed home; trailing the message it moved
          with every wording change. But with nothing beside it the row was a button floating
          in empty space, so it carries the kind of message it is: an icon and a word. */}
      <div className="toast-actions">
        <span className="toast-kind">
          {toast.kind === 'error' ? <AlertIcon size={14} /> : <InfoIcon size={14} />}
          {toast.kind === 'error' ? t('toast.kind.error') : t('toast.kind.info')}
        </span>
        {toast.muteKey && (
          <button
            className="toast-mute"
            title={t('toast.muteHint')}
            onClick={() => {
              const st = useSettingsStore.getState()
              st.setSettings({ mutedErrors: [...st.settings.mutedErrors, toast.muteKey!] })
              dismiss(toast.id)
            }}
          >
            {t('toast.mute')}
          </button>
        )}
        <button className="toast-close" title={t('toast.close')} onClick={() => dismiss(toast.id)}>
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="toast-text">{toast.text}</div>
    </div>
  )
}

export default function Toasts(): React.JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
