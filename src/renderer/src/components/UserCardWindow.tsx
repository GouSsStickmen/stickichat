import { useEffect } from 'react'
import type { UserCardWindowPayload } from '../App'
import { loadGlobalBadges, loadGlobalEmotes, loadChannelBadges, loadChannelEmotes } from '../services/emoteService'
import UserCard from './UserCard'
import Toasts from './Toasts'

export default function UserCardWindow({ payload }: { payload: UserCardWindowPayload }): React.JSX.Element {
  useEffect(() => {
    document.title = `StickiChat — ${payload.target.displayName}`
  }, [payload.target.displayName])

  // this window never runs chatService — fetch emotes/badges for rendering messages
  useEffect(() => {
    loadGlobalEmotes()
    loadGlobalBadges()
    if (payload.target.channelId) {
      loadChannelEmotes(payload.target.channel, payload.target.channelId)
      loadChannelBadges(payload.target.channel, payload.target.channelId)
    }
  }, [payload.target.channel, payload.target.channelId])

  return (
    <div className="app">
      <UserCard target={payload.target} standalone presetMessages={payload.messages} />
      <Toasts />
    </div>
  )
}
