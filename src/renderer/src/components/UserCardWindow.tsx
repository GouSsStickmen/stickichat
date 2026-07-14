import { useEffect } from 'react'
import type { UserCardWindowPayload } from '../App'
import { useLayoutStore, nextId } from '../store/layout'
import { chatService } from '../services/chatService'
import UserCard from './UserCard'
import Toasts from './Toasts'

export default function UserCardWindow({ payload }: { payload: UserCardWindowPayload }): React.JSX.Element {
  useEffect(() => {
    document.title = `StickiChat — ${payload.target.displayName}`
  }, [payload.target.displayName])

  // live messages: join the channel with our own reader (also loads history + emotes/badges),
  // so the card updates in real time instead of showing a frozen snapshot
  useEffect(() => {
    const tabId = nextId('tab')
    useLayoutStore
      .getState()
      .setAll(
        [
          {
            id: tabId,
            name: payload.target.displayName,
            columns: 0,
            panes: [{ id: nextId('pane'), channel: payload.target.channel, accountId: payload.target.accountId }]
          }
        ],
        tabId
      )
    chatService.start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="app">
      <UserCard target={payload.target} standalone presetMessages={payload.messages} />
      <Toasts />
    </div>
  )
}
