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
        <div
          key={toast.id}
          className={`toast ${toast.kind === 'error' ? 'error' : ''}`}
          title={t('toast.close')}
          style={{ cursor: 'pointer' }}
          onClick={() => dismiss(toast.id)}
        >
          {toast.text}
          {/* errors can be silenced for good — the same wording never shows again */}
          {toast.muteKey && (
            <button
              className="toast-mute"
              title={t('toast.muteHint')}
              onClick={(e) => {
                e.stopPropagation()
                const st = useSettingsStore.getState()
                st.setSettings({ mutedErrors: [...st.settings.mutedErrors, toast.muteKey!] })
                dismiss(toast.id)
              }}
            >
              {t('toast.mute')}
            </button>
          )}
          <span style={{ marginLeft: 8, opacity: 0.6 }}>✕</span>
        </div>
      ))}
    </div>
  )
}
