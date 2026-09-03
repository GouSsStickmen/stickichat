import { useEffect, useRef } from 'react'
import { useUiStore, type PlayerSlot } from '../store/ui'
import StreamPlayer from './StreamPlayer'

/**
 * Every running player, rendered once, above the app rather than inside a pane.
 *
 * A pane is unmounted the second you look at another tab, and a player inside it went with it:
 * the stream stopped, and coming back started a fresh one with a fresh advert. So the players live
 * out here for as long as they are on, and each one is simply positioned over the empty slot its
 * pane leaves for it.
 *
 * Fixed positioning rather than moving the element into the pane: re-parenting a webview in the
 * DOM detaches its guest, which is the very restart this exists to avoid.
 */
export default function PlayerLayer(): React.JSX.Element {
  const open = useUiStore((s) => s.openPlayers)
  const slots = useUiStore((s) => s.playerSlots)
  /**
   * Where each player was last wanted.
   *
   * Parking it off the side of the viewport was the obvious way to hide it and the wrong one:
   * Twitch pauses a player it believes nobody can see, and a box at left:-100000 intersects
   * nothing. Measured, it paused within 400ms of every first tab switch. So a parked player stays
   * exactly where it was and goes transparent instead. Geometry is what the visibility check
   * looks at, and that has not changed; opacity is not part of it.
   */
  const lastSlot = useRef<Record<string, PlayerSlot>>({})

  /*
   * A nudge whenever the box moves or resizes.
   *
   * Chromium hit-tests a webview's guest against a region it updates on its own schedule, and a
   * box that is moved by script can be left routing real pointer input against where it used to
   * be. Everything measurable looks right when that happens: the element and the guest agree on
   * their size, nothing of ours is on top, and injected input reaches the controls perfectly. Only
   * the actual mouse misses, which is why the far side of the video would stop responding and
   * Twitch would hide its controls as you reached for the gear.
   *
   * Resizing the window by hand clears it, which is the workaround the user found. This is the
   * same thing, one pixel for one frame, done automatically whenever the geometry changes.
   */
  const lastSize = useRef<Record<string, string>>({})
  const nudged = useRef<Record<string, number>>({})
  useEffect(() => {
    for (const channel of open) {
      const slot = slots[channel]
      if (!slot) continue
      // position counts too: a pane that shifts down when the tab bar wraps moves the box
      const size = `${slot.x},${slot.y} ${slot.w}x${slot.h}`
      if (lastSize.current[channel] === size) continue
      lastSize.current[channel] = size
      window.clearTimeout(nudged.current[channel])
      nudged.current[channel] = window.setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`[data-player="${CSS.escape(channel)}"]`)
        if (!el) return
        const w = el.style.width
        el.style.width = `${slot.w - 1}px`
        requestAnimationFrame(() => {
          el.style.width = w
        })
      }, 250)
    }
  }, [open, slots])

  return (
    <>
      {open.map((channel) => {
        const slot = slots[channel]
        if (slot) lastSlot.current[channel] = slot
        const at = slot ?? lastSlot.current[channel]
        const style: React.CSSProperties = at
          ? { left: at.x, top: at.y, width: at.w, height: at.h }
          : // never shown yet: a real size in the corner, still inside the viewport
            { left: 0, top: 0, width: 480, height: 270 }
        return (
          <div
            key={channel}
            data-player={channel}
            className={`player-layer-box ${slot ? '' : 'parked'}`}
            style={style}
          >
            <StreamPlayer
              channel={channel}
              slot={slot ?? null}
              onClose={() => useUiStore.getState().togglePlayer(channel, false)}
            />
          </div>
        )
      })}
    </>
  )
}
