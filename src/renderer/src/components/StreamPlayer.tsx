import { useRef } from 'react'
import { useSettingsStore } from '../store/settings'
import { useT } from '../i18n'

interface Props {
  channel: string
  /** the pane variant can be resized, detached and closed; the window variant fills its window */
  standalone?: boolean
  onClose?: () => void
}

/**
 * The stream, in Twitch's own embedded player.
 *
 * A <webview> rather than an <iframe> on purpose. The embed insists the `parent` parameter matches
 * the page holding it, and a packaged build is served from file://, which has no host to match. A
 * webview loads the player as its own top-level page, so the question does not arise.
 *
 * It also gets its own cookie jar, which is what makes signing in useful: a logged-in player knows
 * the viewer is subscribed and stops showing ads on that channel, exactly as the site would. The
 * app never reads anything out of that jar; the player uses it the way a browser tab does.
 *
 * Twitch's player is the only honest option here. The alternative is taking the playback token and
 * feeding the HLS to a player of our own, which exists mainly to skip ads; this app does not do
 * that, and Twitch stitches ads into the stream anyway, so it would not even work.
 */
export default function StreamPlayer({ channel, standalone, onClose }: Props): React.JSX.Element {
  const t = useT()
  const height = useSettingsStore((s) => s.settings.playerHeight)
  const side = useSettingsStore((s) => s.settings.playerSideBySide)
  const boxRef = useRef<HTMLDivElement>(null)

  /*
   * Drag to resize: the bottom edge when the player sits above the chat, the left edge when it
   * sits beside it.
   *
   * The listeners go on in the pointerdown handler, not in an effect keyed on a "dragging" state.
   * An effect runs after the render, so a pointerup arriving in the same tick as the pointerdown
   * is never seen, and the drag then stays live under every later mouse movement.
   *
   * Position, not delta: the edge follows the cursor exactly, so it cannot drift over a long drag.
   */
  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const vertical = !side
    const onMove = (ev: PointerEvent): void => {
      const r = boxRef.current?.getBoundingClientRect()
      if (!r) return
      if (vertical) {
        const next = Math.max(120, Math.min(900, Math.round(ev.clientY - r.top)))
        useSettingsStore.getState().setSettings({ playerHeight: next })
      } else {
        // side by side, the chat is what gets sized: the player simply takes what is left
        const next = Math.max(220, Math.min(900, Math.round(r.right - ev.clientX)))
        useSettingsStore.getState().setSettings({ chatWidth: next })
      }
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
      className={`stream-player ${standalone ? 'stream-player-standalone' : ''} ${
        side && !standalone ? 'stream-player-side' : ''
      }`}
      ref={boxRef}
      style={standalone || side ? undefined : { height }}
    >
      <webview src={src} className="stream-webview" partition="persist:twitch-player" />
      <div className="stream-bar">
        <button
          className="icon-btn"
          title={t('player.signIn')}
          onClick={() => void window.sticki.twitchSignIn()}
        >
          👤
        </button>
        {standalone ? (
          <button
            className="icon-btn"
            title={t('player.attach')}
            onClick={() => void window.sticki.returnStream(channel)}
          >
            ⇤
          </button>
        ) : (
          <>
            <button
              className="icon-btn"
              title={t('player.layout')}
              onClick={() => useSettingsStore.getState().setSettings({ playerSideBySide: !side })}
            >
              {side ? '▤' : '▥'}
            </button>
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
          </>
        )}
      </div>
      {!standalone && (
        // the whole edge, not a corner grip: it is one boundary, horizontal or vertical
        <div className={side ? 'stream-resize-x' : 'stream-resize'} onPointerDown={startResize} />
      )}
    </div>
  )
}
