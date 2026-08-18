import React, { useEffect, useRef, useState } from 'react'
import { registerPlugin } from '@capacitor/core'
import { useSettingsStore } from '@renderer/store/settings'

const Pip = registerPlugin<{
  enter(o: { width: number; height: number }): Promise<void>
  setAuto(o: { enabled: boolean }): Promise<void>
  openTwitchLogin(): Promise<void>
  hasTwitchSession(): Promise<{ value: boolean }>
}>('Pip')

/**
 * Whether the player is watching as a logged-in viewer.
 *
 * Exported because the menu offers the login and the player is what the answer is about: the app's own
 * OAuth token says nothing here — ads are decided by a twitch.tv web session, which lives in the
 * WebView cookie jar and nowhere else.
 */
export async function twitchSessionActive(): Promise<boolean> {
  try {
    return (await Pip.hasTwitchSession()).value
  } catch {
    return false
  }
}

export async function openTwitchLogin(): Promise<void> {
  await Pip.openTwitchLogin().catch(() => undefined)
}

/**
 * The stream, above the chat.
 *
 * Twitch's own embed in an iframe rather than a native player: it is the only way to play a Twitch
 * stream without reimplementing their HLS signing, and it carries the ads that the stream is supposed
 * to carry. The parent parameter has to be the host the page is served from, which in this WebView is
 * `localhost` — get that wrong and Twitch refuses to play rather than failing loudly.
 *
 * Height is a drag, not a preset. A 16:9 player on a 411px screen is 231px, which on a chat that had
 * 69% of the screen leaves about ten lines — whether that trade is worth it depends entirely on what
 * is happening in the stream, so it is the viewer's to make, minute to minute.
 */
export default function MobilePlayer({
  channel,
  onClose
}: {
  channel: string
  onClose: () => void
}): React.JSX.Element {
  const stored = useSettingsStore((s) => s.settings.playerHeight)
  const [height, setHeight] = useState(stored || 220)
  const [inPip, setInPip] = useState(false)
  /*
   * The two buttons are over the video, so they cannot live there permanently — they were covering a
   * corner of whatever was being watched. They come up on a tap and go again on their own, the way
   * every video player on the phone behaves.
   */
  const [barShown, setBarShown] = useState(true)
  const hideAt = useRef<number | undefined>(undefined)
  const dragRef = useRef<{ y: number; h: number } | null>(null)

  const showBar = (): void => {
    setBarShown(true)
    window.clearTimeout(hideAt.current)
    hideAt.current = window.setTimeout(() => setBarShown(false), 2600)
  }
  useEffect(() => {
    showBar()
    return () => window.clearTimeout(hideAt.current)
  }, [])

  /*
   * Leaving the app keeps the stream, in the little window. The flag is set while a player exists and
   * cleared when it goes, because the request is made natively from onUserLeaveHint and that code has
   * no other way to know whether anything is playing.
   */
  useEffect(() => {
    void Pip.setAuto({ enabled: true }).catch(() => undefined)
    return () => {
      void Pip.setAuto({ enabled: false }).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    const onPip = (e: Event): void => {
      setInPip(!!(e as CustomEvent<{ inPip: boolean }>).detail?.inPip)
    }
    /*
     * Two ways of knowing, because the first one alone was not enough: the native callback fires on
     * the activity and posts this event into the page, and it did not arrive — the tab strip stayed
     * in the little window along with the video.
     *
     * The size test needs nothing from the native side at all. A picture-in-picture window is a few
     * hundred pixels across, far smaller than any phone held any way up, so the window's own
     * dimensions are already the answer.
     */
    const onResize = (): void => {
      setInPip(window.innerWidth < 400 && window.innerHeight < 320)
    }
    onResize()
    window.addEventListener('sticki:pip', onPip)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('sticki:pip', onPip)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  /*
   * In the small window the page is the player. The class is on the root rather than here so the tab
   * strip and the panes — which know nothing about any of this — can be hidden by one rule.
   */
  useEffect(() => {
    document.querySelector('.m-app')?.classList.toggle('in-pip', inPip)
    return () => document.querySelector('.m-app')?.classList.remove('in-pip')
  }, [inPip])

  const onDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    dragRef.current = { y: e.clientY, h: height }
    const move = (ev: PointerEvent): void => {
      const start = dragRef.current
      if (!start) return
      // 120px is about a readable line of chat; the cap leaves the chat at least a third of the screen
      const next = Math.max(120, Math.min(start.h + (ev.clientY - start.y), window.innerHeight * 0.66))
      setHeight(Math.round(next))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      dragRef.current = null
      // remembered, because nobody wants to set this again on every launch
      useSettingsStore.getState().setSettings({ playerHeight: height })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  /*
   * Coming back from the login window, the iframe has to be told to look again — it was created as an
   * anonymous viewer and will stay one until it reloads. The key is bumped when the session appears.
   */
  const [sessionKey, setSessionKey] = useState(0)
  useEffect(() => {
    const onResume = (): void => {
      void twitchSessionActive().then((live) => {
        if (live) setSessionKey((k) => k + 1)
      })
    }
    window.addEventListener('sticki:twitchlogin', onResume)
    document.addEventListener('visibilitychange', onResume)
    return () => {
      window.removeEventListener('sticki:twitchlogin', onResume)
      document.removeEventListener('visibilitychange', onResume)
    }
  }, [])

  const src =
    `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}` +
    `&parent=localhost&autoplay=true&muted=false`

  return (
    <div
      className={`m-player ${barShown ? 'bar-shown' : ''}`}
      style={{ height: inPip ? '100%' : height }}
      onPointerDown={showBar}
    >
      <iframe
        key={sessionKey}
        title={channel}
        src={src}
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        allowFullScreen
      />
      {/* the only thing that can hear a tap on the video — see .m-player-tap */}
      {!inPip && !barShown && <div className="m-player-tap" onPointerDown={showBar} />}
      {!inPip && (
        <>
          <div className="m-player-bar">
            <span className="m-player-who">{channel}</span>
            <button
              title="Картинка в картинці"
              onClick={() => void Pip.enter({ width: 16, height: 9 }).catch(() => undefined)}
            >
              ⧉
            </button>
            <button title="Закрити плеєр" onClick={onClose}>
              ✕
            </button>
          </div>
          {/* the whole strip is the handle: a thin line is a mis-grab on a phone */}
          <div className="m-player-grip" onPointerDown={onDrag}>
            ⌄⌃
          </div>
        </>
      )}
    </div>
  )
}
