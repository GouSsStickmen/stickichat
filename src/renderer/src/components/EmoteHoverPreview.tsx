import { useLayoutEffect, useRef, useState } from 'react'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'

export default function EmoteHoverPreview(): React.JSX.Element | null {
  const preview = useUiStore((s) => s.emotePreview)
  const emoteSize = useSettingsStore((s) => s.settings.chatEmoteHoverSize)
  const boxRef = useRef<HTMLDivElement>(null)
  // measured height of the box; until it's known the box is rendered invisibly so it can't
  // flash in the wrong place
  const [boxH, setBoxH] = useState(0)

  // A link picture's height is only known once it has decoded. Reserving the CSS maximum
  // (78vh) instead made a short image sit as if it were tall — the box ended up far ABOVE
  // the cursor whenever the message was near the bottom of the chat. Measure the real box.
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = (): void => setBoxH(el.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [preview?.url, preview?.wide, preview?.wideSize, emoteSize])

  if (!preview) return null
  // link artwork is wide: cap it to a comfortable share of the window instead of the (square)
  // emote hover size, which would shrink a 16:9 thumbnail to a stamp
  const size = preview.wide
    ? Math.min(preview.wideSize ?? 560, Math.round(window.innerWidth * 0.9))
    : emoteSize

  const GAP = 14
  const h = boxH || 0
  // sit just above the cursor by default; drop below only when there genuinely isn't room
  let y = preview.y - GAP - h
  if (y < 8) y = preview.y + GAP + 6
  // and clamp so the box never leaves the window (no cropping at either edge)
  y = Math.max(8, Math.min(y, window.innerHeight - 8 - h))
  const x = Math.max(8, Math.min(preview.x + GAP, window.innerWidth - size - 24))

  return (
    <div
      ref={boxRef}
      className={`emote-hover-preview ${preview.wide ? 'wide' : ''}`}
      style={{ left: x, top: y, visibility: h ? 'visible' : 'hidden' }}
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
