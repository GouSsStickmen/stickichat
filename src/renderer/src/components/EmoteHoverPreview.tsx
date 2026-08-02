import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'

export default function EmoteHoverPreview(): React.JSX.Element | null {
  const preview = useUiStore((s) => s.emotePreview)
  const emoteSize = useSettingsStore((s) => s.settings.chatEmoteHoverSize)
  if (!preview) return null
  // link artwork is wide: cap it to a comfortable share of the window instead of the (square)
  // emote hover size, which would shrink a 16:9 thumbnail to a stamp
  // wide previews use the user's chosen width, still capped so they can't exceed the window
  const size = preview.wide
    ? Math.min(preview.wideSize ?? 560, Math.round(window.innerWidth * 0.9))
    : emoteSize

  // Height isn't known until the image decodes, so budget for the CSS cap and place the box
  // on whichever side of the cursor has room. It always stays NEXT TO the cursor — an earlier
  // attempt pinned wide previews to the middle of the window, which read as "flying away".
  const budgetH = preview.wide ? Math.round(window.innerHeight * 0.78) : size + 34
  const roomAbove = preview.y - 12
  const roomBelow = window.innerHeight - preview.y - 20
  const below = roomAbove < budgetH && roomBelow > roomAbove
  const x = Math.max(8, Math.min(preview.x + 14, window.innerWidth - size - 24))
  // anchor to the cursor, then clamp so neither edge leaves the window (no cropping)
  let y = below ? preview.y + 20 : preview.y - 12 - budgetH
  y = Math.max(8, Math.min(y, window.innerHeight - 8 - budgetH))

  return (
    <div
      className={`emote-hover-preview ${preview.wide ? 'wide' : ''}`}
      style={{ left: x, top: y }}
    >
      {/* scale the emote UP to the chosen size (contain keeps aspect) so the setting actually
          changes how big it looks, instead of capping at the image's native resolution */}
      {/* a combined emote previews as the finished stack, exactly how it reads in chat */}
      <span className="ehp-stack" style={{ width: size, height: preview.wide ? 'auto' : size }}>
        <img
          src={preview.url}
          alt={preview.code}
          style={{ width: size, height: preview.wide ? 'auto' : size, objectFit: 'contain' }}
        />
        {(preview.overlayUrls ?? []).map((u, i) => (
          <img
            key={i}
            src={u}
            alt=""
            className="ehp-overlay"
            style={{ width: size, height: size, objectFit: 'contain' }}
          />
        ))}
      </span>
      {/* the link preview is JUST the picture — a caption strip under it only adds empty space */}
      {!preview.wide && (
        <>
          <div className="emote-hover-name">{preview.code}</div>
          {(preview.subtitle ?? []).map((line, i) => (
            <div key={i} className="emote-hover-sub">
              {line}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
