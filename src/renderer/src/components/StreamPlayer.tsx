import { useRef } from 'react'
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
  const boxRef = useRef<HTMLDivElement>(null)

  /*
   * Drag the bottom edge to resize.
   *
   * The listeners go on in the pointerdown handler, not in an effect keyed on a "dragging" state.
   * An effect runs after the render, so a pointerup that arrives in the same tick as the
   * pointerdown is never seen — and the drag then stays live, quietly resizing the player under
   * every later mouse movement until something else releases it.
   *
   * Position, not delta: the edge follows the cursor exactly, so it cannot drift over a long drag.
   */
  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const onMove = (ev: PointerEvent): void => {
      const top = boxRef.current?.getBoundingClientRect().top ?? 0
      const next = Math.max(120, Math.min(720, Math.round(ev.clientY - top)))
      useSettingsStore.getState().setSettings({ playerHeight: next })
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

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
              onClick={() => {
                // "move to its own window" has to MOVE it: leaving the pane copy behind means two
                // players, two audio streams and twice the CPU, which is not what the button says
                void window.sticki.openStreamWindow(`stream=${encodeURIComponent(channel)}`)
                onClose?.()
              }}
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
            onPointerDown={startResize}
          />
        </>
      )}
    </div>
  )
}
