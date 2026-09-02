import { useUiStore } from '../store/ui'
import StreamPlayer from './StreamPlayer'

/**
 * Every running player, rendered once, above the app rather than inside a pane.
 *
 * A pane is unmounted the second you look at another tab, and a player inside it went with it:
 * the stream stopped, and coming back started a fresh one with a fresh advert. So the players live
 * out here for as long as they are on, and each one is simply positioned over the empty slot its
 * pane leaves for it. When that pane is not on screen the player is parked to the left of the
 * viewport, still playing, still holding its volume, waiting to be put back.
 *
 * Fixed positioning rather than moving the element into the pane: re-parenting a webview in the
 * DOM detaches its guest, which is the very restart this exists to avoid.
 */
export default function PlayerLayer(): React.JSX.Element {
  const open = useUiStore((s) => s.openPlayers)
  const slots = useUiStore((s) => s.playerSlots)

  return (
    <>
      {open.map((channel) => {
        const slot = slots[channel]
        const style: React.CSSProperties = slot
          ? { left: slot.x, top: slot.y, width: slot.w, height: slot.h }
          : // parked: off to the left, at a real size so Twitch keeps sending real video
            { left: -100000, top: 0, width: 640, height: 360 }
        return (
          <div key={channel} className="player-layer-box" style={style}>
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
