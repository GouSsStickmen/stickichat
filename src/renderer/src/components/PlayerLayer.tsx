import { useRef } from 'react'
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
