import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'

export default function EmoteHoverPreview(): React.JSX.Element | null {
  const preview = useUiStore((s) => s.emotePreview)
  const emoteSize = useSettingsStore((s) => s.settings.chatEmoteHoverSize)
  if (!preview) return null
  // link artwork is wide: cap it to a comfortable share of the window instead of the (square)
  // emote hover size, which would shrink a 16:9 thumbnail to a stamp
  const size = preview.wide ? Math.min(560, Math.round(window.innerWidth * 0.45)) : emoteSize

  // anchor next to the cursor. The box grows UPWARD from a point just above the cursor via
  // translateY(-100%), so it stays glued to the cursor no matter how large `size` is. Near the
  // top of the screen we flip it below the cursor instead.
  const flipBelow = preview.y - size - 40 < 8
  const x = Math.min(preview.x + 14, window.innerWidth - size - 24)
  const y = flipBelow ? preview.y + 20 : preview.y - 12

  return (
    <div
      className="emote-hover-preview"
      style={{ left: x, top: y, transform: flipBelow ? undefined : 'translateY(-100%)' }}
    >
      {/* scale the emote UP to the chosen size (contain keeps aspect) so the setting actually
          changes how big it looks, instead of capping at the image's native resolution */}
      <img
        src={preview.url}
        alt={preview.code}
        style={{ width: size, height: preview.wide ? 'auto' : size, objectFit: 'contain' }}
      />
      <div className="emote-hover-name">{preview.code}</div>
    </div>
  )
}
