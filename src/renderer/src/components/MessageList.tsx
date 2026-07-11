import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { Account, Pane } from '../types'
import { useChatStore } from '../store/chat'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { useEmotesStore } from '../store/emotes'
import MessageView from './MessageView'
import { ReplyTarget } from './InputBox'
import { useT } from '../i18n'

interface Props {
  pane: Pane
  account: Account | undefined
  channelId: string
  isMod: boolean
  onReply: (target: ReplyTarget) => void
  scrollLocked: boolean
}

export interface JumpEventDetail {
  channel: string
  msgId: string
}

export default function MessageList({
  pane,
  account,
  channelId,
  isMod,
  onReply,
  scrollLocked
}: Props): React.JSX.Element {
  const t = useT()
  const allMessages = useChatStore((s) => s.messages[pane.channel]) ?? []
  const expandedGifts = useUiStore((s) => s.expandedGifts)
  // sub-gifts of a collapsed mass-gift group stay hidden until the header is clicked
  const messages = useMemo(
    () => allMessages.filter((m) => !m.groupedUnder || expandedGifts[m.groupedUnder]),
    [allMessages, expandedGifts]
  )
  const settings = useSettingsStore((s) => s.settings)
  const emoteVersion = useEmotesStore((s) => s.version)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [flashId, setFlashId] = useState<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // jump-to-message requests (clicking a reply reference)
  useEffect(() => {
    const onJump = (e: Event): void => {
      const detail = (e as CustomEvent<JumpEventDetail>).detail
      if (detail.channel !== pane.channel) return
      const idx = messagesRef.current.findIndex((m) => m.id === detail.msgId)
      if (idx < 0) return
      virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center' })
      setFlashId(detail.msgId)
      window.setTimeout(() => setFlashId(null), 3200)
    }
    window.addEventListener('sticki:jump', onJump)
    return () => window.removeEventListener('sticki:jump', onJump)
  }, [pane.channel])

  return (
    <div className="msg-list-wrap">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        followOutput={(isAtBottom) => (scrollLocked ? false : isAtBottom ? 'auto' : false)}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={40}
        initialTopMostItemIndex={Math.max(messages.length - 1, 0)}
        computeItemKey={(_i, m) => m.id}
        itemContent={(index, msg) => (
          <MessageView
            msg={msg}
            index={index}
            paneId={pane.id}
            account={account}
            channelId={channelId}
            isMod={isMod}
            paneAccountId={pane.accountId}
            settings={settings}
            emoteVersion={emoteVersion}
            onReply={onReply}
            flash={flashId === msg.id}
          />
        )}
      />
      {!atBottom && (
        <div
          className="new-msgs-chip"
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: 'auto' })
          }
        >
          ↓ {t('misc.newMessages')}
        </div>
      )}
    </div>
  )
}
