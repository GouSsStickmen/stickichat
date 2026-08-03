import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { useT } from '../i18n'
import { AlertIcon, InfoIcon, CloseIcon } from './Icons'

export default function Toasts(): React.JSX.Element {
  const t = useT()
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind === 'error' ? 'error' : ''}`}>
          {/* The header row exists so the ✕ has a fixed home — trailing the message it moved
              with every wording change. But with nothing beside it the row was a ✕ floating
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
      ))}
    </div>
  )
}
