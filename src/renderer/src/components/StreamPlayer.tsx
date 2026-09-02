import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../store/settings'
import { useUiStore, type PlayerSlot } from '../store/ui'
import { useT } from '../i18n'
import { PersonIcon, LayoutIcon, CloseIcon, TrayArrowIcon } from './Icons'

interface Props {
  channel: string
  /** the pane variant can be resized, detached and closed; the window variant fills its window */
  standalone?: boolean
  onClose?: () => void
  /**
   * Where the pane wants this player, and the pane box to resize against.
   *
   * A width drag has to measure against something that does not move. The player's own right edge
   * IS the thing being moved, so measuring from it fed every step back into the next one and the
   * column jumped around instead of following the cursor. Null when no pane is showing it, which
   * is also when there is nothing to drag.
   */
  slot?: PlayerSlot | null
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
export default function StreamPlayer({ channel, standalone, onClose, slot }: Props): React.JSX.Element {
  const t = useT()
  const side = useSettingsStore((s) => s.settings.playerSideBySide)
  const boxRef = useRef<HTMLDivElement>(null)
  const wvRef = useRef<{ executeJavaScript: (code: string) => Promise<unknown> } | null>(null)

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
    // captured once, before anything moves
    const right = slot?.boxRight ?? window.innerWidth
    // the webview eats pointer events, so a drag crossing the video would otherwise stop dead
    document.body.classList.add('dragging-split')
    const onMove = (ev: PointerEvent): void => {
      const r = boxRef.current?.getBoundingClientRect()
      if (!r) return
      if (vertical) {
        // never past three quarters of the pane: the chat has to stay a chat
        const ceiling = Math.max(160, Math.round((slot?.boxHeight ?? 900) * 0.75))
        const next = Math.max(120, Math.min(ceiling, Math.round(ev.clientY - r.top)))
        useSettingsStore.getState().setSettings({ playerHeight: next })
      } else {
        // side by side, the chat is what gets sized: the player simply takes what is left
        const next = Math.max(220, Math.min(Math.round(right - 240), Math.round(right - ev.clientX)))
        useSettingsStore.getState().setSettings({ chatWidth: next })
      }
    }
    const stop = (): void => {
      document.body.classList.remove('dragging-split')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  /*
   * The player lives on a one-page local server rather than at player.twitch.tv directly, because
   * that is the only way to reach Twitch's embed SDK, and the SDK is the only thing that will say
   * how far behind live the video is. Until the port is known there is nothing to load.
   */
  const [port, setPort] = useState(0)
  useEffect(() => {
    void window.sticki.playerPort().then(setPort)
  }, [])

  useEffect(() => {
    if (!port) return
    const wv = wvRef.current
    if (!wv) return
    const id = window.setInterval(() => {
      wv.executeJavaScript('window.__stickiStats')
        .then((raw) => {
          const s = raw as { latency?: number } | null
          useUiStore
            .getState()
            .setStreamLatency(channel, typeof s?.latency === 'number' ? s.latency : null)
        })
        .catch(() => useUiStore.getState().setStreamLatency(channel, null))
    }, 3000)
    return () => {
      window.clearInterval(id)
      // the pane header must not keep showing a number for a player that is gone
      useUiStore.getState().setStreamLatency(channel, null)
    }
  }, [port, channel])

  const src = port ? `http://localhost:${port}/?channel=${encodeURIComponent(channel)}` : ''

  return (
    <div
      className={`stream-player ${standalone ? 'stream-player-standalone' : ''} ${
        side && !standalone ? 'stream-player-side' : ''
      }`}
      ref={boxRef}
    >
      {src && (
        <webview
          ref={wvRef as never}
          src={src}
          className="stream-webview"
          partition="persist:twitch-player"
        />
      )}
      <div className="stream-bar">
        <button
          className="icon-btn"
          title={t('player.signInWhy')}
          onClick={() => void window.sticki.twitchSignIn()}
        >
          <PersonIcon size={15} />
        </button>
        {standalone ? (
          <button
            className="icon-btn"
            title={t('player.attach')}
            onClick={() => void window.sticki.returnStream(channel)}
          >
            <TrayArrowIcon dir="in" size={14} />
          </button>
        ) : (
          <>
            <button
              className="icon-btn"
              title={t('player.layout')}
              onClick={() => useSettingsStore.getState().setSettings({ playerSideBySide: !side })}
            >
              {/* the icon shows what you would GET, which is the arrangement you are not in */}
              <LayoutIcon side={!side} size={15} />
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
              <CloseIcon size={13} />
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
