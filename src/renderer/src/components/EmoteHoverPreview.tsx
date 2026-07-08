import { useUiStore } from '../store/ui'

export default function EmoteHoverPreview(): React.JSX.Element | null {
  const preview = useUiStore((s) => s.emotePreview)
  if (!preview) return null

  const size = 128
  const x = Math.min(preview.x + 16, window.innerWidth - size - 16)
  const y = Math.max(8, preview.y - size - 16)

  return (
    <div className="emote-hover-preview" style={{ left: x, top: y }}>
      <img src={preview.url} alt={preview.code} />
      <div className="emote-hover-name">{preview.code}</div>
    </div>
  )
}
