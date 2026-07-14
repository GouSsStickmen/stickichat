import { useEffect, useState } from 'react'
import { useAccountsStore } from '../store/accounts'
import {
  loadGlobalBadges,
  loadGlobalEmotes,
  loadChannelBadges,
  loadChannelEmotes,
  loadTwitchUserEmotes
} from '../services/emoteService'
import EmotePicker from './EmotePicker'
import Toasts from './Toasts'
import type { EmotePickerWindowPayload } from '../App'
import type { InsertEventDetail } from './InputBox'

export default function EmotePickerWindow({
  payload
}: {
  payload: EmotePickerWindowPayload
}): React.JSX.Element {
  const [closed, setClosed] = useState(false)
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
    if (account) loadTwitchUserEmotes(account)
  }, [account])

  if (closed) return <div className="app" />

  return (
    <div className="app">
      <EmotePicker
        channel={payload.channel}
        channelId={payload.channelId}
        account={account}
        standalone
        onPick={(emote) => {
          window.sticki.sendEmotePick(
            JSON.stringify({ paneId: payload.paneId, text: `${emote.code} ` } satisfies InsertEventDetail)
          )
        }}
        onClose={() => setClosed(true)}
      />
      <Toasts />
    </div>
  )
}
