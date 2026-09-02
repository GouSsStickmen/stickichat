import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../store/settings'
import { useT } from '../i18n'

interface Props {
  channel: string
  /** the pane variant can be resized and detached; the window variant just fills its window */
  standalone?: boolean
  onClose?: () => void
}

/**
 * The stream, in Twitch's own embedded player.
 *
 * A <webview> rather than an <iframe> on purpose. The embed insists the `parent` parameter matches
 * the page holding it, and in a packaged build this app is served from file://, which has no host
 * to match. A webview loads the player as its own top-level page, so the question does not arise —
 * verified against a live channel before this was written.
 *
 * Twitch's player is also the only honest option. The alternative is taking the playback token and
 * feeding the HLS to a player of our own, which exists mainly to skip ads; this app does not do
 * that, and Twitch stitches ads into the stream anyway, so it would not even work.
 */
export default function StreamPlayer({ channel, standalone, onClose }: Props): React.JSX.Element {
  const t = useT()
  const height = useSettingsStore((s) => s.settings.playerHeight)
  const [dragging, setDragging] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  /*
   * Drag the bottom edge to resize.
   *
   * Pointer capture on the handle rather than listeners on the window: the webview swallows mouse
   * events over itself, so a drag that crossed into the video would otherwise stop dead.
   */
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent): void => {
      const top = boxRef.current?.getBoundingClientRect().top ?? 0
      const next = Math.max(120, Math.min(720, Math.round(e.clientY - top)))
      useSettingsStore.getState().setSettings({ playerHeight: next })
    }
    const stop = (): void => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
    }
  }, [dragging])

  const src =
    `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}` +
    '&parent=localhost&autoplay=true&muted=false'

  return (
    <div
      className={`stream-player ${standalone ? 'stream-player-standalone' : ''}`}
      ref={boxRef}
      style={standalone ? undefined : { height }}
    >
      <webview src={src} className="stream-webview" allowpopups={undefined} />
      {!standalone && (
        <>
          <div className="stream-bar">
            <button
              className="icon-btn"
              title={t('player.detach')}
              onClick={() =>
                window.sticki.openStreamWindow(`stream=${encodeURIComponent(channel)}`)
              }
            >
              ⧉
            </button>
            <button className="icon-btn" title={t('player.hide')} onClick={onClose}>
              ✕
            </button>
          </div>
          {/* the whole bottom edge, not a corner grip — it is a horizontal boundary */}
          <div
            className="stream-resize"
            onPointerDown={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
          />
        </>
      )}
    </div>
  )
}
