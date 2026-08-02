import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { useT } from '../i18n'

export default function Toasts(): React.JSX.Element {
  const t = useT()
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind === 'error' ? 'error' : ''}`}>
          {/* actions sit in a header row above the text. Trailing the message they shifted
              around with every wording change, so the ✕ had to be hunted for each time. */}
          <div className="toast-actions">
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
              ✕
            </button>
          </div>
          <div className="toast-text">{toast.text}</div>
        </div>
      ))}
    </div>
  )
}
