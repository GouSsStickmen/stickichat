import { useEffect } from 'react'
import { useAccountsStore } from '../store/accounts'
import {
  loadGlobalBadges,
  loadGlobalEmotes,
  loadChannelBadges,
  loadChannelEmotes,
  loadTwitchUserEmotes,
  loadTwitchChannelEmotes
} from '../services/emoteService'
import EmotePicker, { emoteInsertText } from './EmotePicker'
import { pickGif } from '../lib/gifPick'
import Toasts from './Toasts'
import type { EmotePickerWindowPayload } from '../App'
import type { InsertEventDetail } from './InputBox'

export default function EmotePickerWindow({
  payload
}: {
  payload: EmotePickerWindowPayload
}): React.JSX.Element {
  const account = useAccountsStore((s) => s.accounts.find((a) => a.id === payload.accountId))

  useEffect(() => {
    document.title = `StickiChat — ${payload.channel}`
  }, [payload.channel])

  // this standalone window never runs chatService, so nobody else preloads emotes for it
  useEffect(() => {
    loadGlobalEmotes()
    loadGlobalBadges()
    if (payload.channelId) {
      loadChannelEmotes(payload.channel, payload.channelId)
      loadChannelBadges(payload.channel, payload.channelId)
    }
  }, [payload.channel, payload.channelId])

  // load this account's Twitch emotes + owner names/avatars (the Twitch tab's rail) — without
  // this the standalone window's Twitch tab had emotes but no streamer avatars
  useEffect(() => {
    if (!account) return
    loadTwitchUserEmotes(account)
    if (payload.channelId) loadTwitchChannelEmotes(account, payload.channelId)
  }, [account])

  return (
    <div className="app">
      <EmotePicker
        channel={payload.channel}
        channelId={payload.channelId}
        account={account}
        standalone
        onPick={(emote) => {
          window.sticki.sendEmotePick(
            JSON.stringify({ paneId: payload.paneId, text: `${emoteInsertText(emote)} ` } satisfies InsertEventDetail)
          )
        }}
        onPickGif={(gif) =>
          void pickGif(gif, payload.channelId, (text) => {
            window.sticki.sendEmotePick(
              JSON.stringify({ paneId: payload.paneId, text: `${text} ` } satisfies InsertEventDetail)
            )
          })
        }
        /**
         * Escape closes the WINDOW, not the picker inside it.
         *
         * Blanking the content left an empty dark window with nothing in it and no way back —
         * the emotes had simply vanished. In every other standalone window here, closing means
         * closing; this one was the exception because it reused the popover's close handler.
         */
        onClose={() => window.close()}
      />
      <Toasts />
    </div>
  )
}
