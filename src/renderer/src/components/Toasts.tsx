import { useUiStore } from '../store/ui'

export default function Toasts(): React.JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
