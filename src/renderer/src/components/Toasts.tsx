import { useUiStore } from '../store/ui'

export default function Toasts(): React.JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind === 'error' ? 'error' : ''}`}
          title="Клік — закрити"
          style={{ cursor: 'pointer' }}
          onClick={() => dismiss(t.id)}
        >
          {t.text}
          <span style={{ marginLeft: 8, opacity: 0.6 }}>✕</span>
        </div>
      ))}
    </div>
  )
}
