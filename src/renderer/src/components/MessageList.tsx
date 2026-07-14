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
  const settings = useSettingsStore((s) => s.settings)
  // sub-gifts of a collapsed mass-gift group stay hidden until the header is clicked;
  // muted-with-'hide' users disappear from the list entirely
  const hiddenLogins = useMemo(
    () => new Set(settings.mutedUsers.filter((u) => u.mode === 'hide').map((u) => u.login)),
    [settings.mutedUsers]
  )
  const messages = useMemo(
    () =>
      allMessages.filter(
        (m) =>
          (!m.groupedUnder || expandedGifts[m.groupedUnder]) &&
          (m.system || !hiddenLogins.has(m.login))
      ),
    [allMessages, expandedGifts, hiddenLogins]
  )
  const emoteVersion = useEmotesStore((s) => s.version)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  atBottomRef.current = atBottom
  const [flashId, setFlashId] = useState<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // resizing the list (closing the highlights sidebar, closing a split pane, window resize)
  // can make Virtuoso drift to the top — re-pin to the bottom if we were following it
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current && !scrollLocked) {
        virtuosoRef.current?.scrollToIndex({ index: messagesRef.current.length - 1, behavior: 'auto' })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollLocked])

  // history often arrives AFTER the empty list mounted — snap to the bottom on first fill,
  // otherwise the view stays parked at the top of the freshly-prepended scrollback
  const hadMessagesRef = useRef(false)
  useEffect(() => {
    if (!hadMessagesRef.current && messages.length > 0) {
      hadMessagesRef.current = true
      virtuosoRef.current?.scrollToIndex({ index: messages.length - 1 })
    }
  }, [messages.length])

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

  // sending a message snaps to the bottom — so a paused/scrolled-up list shows the sent line
  useEffect(() => {
    const onSent = (e: Event): void => {
      const detail = (e as CustomEvent<{ channel: string }>).detail
      if (detail.channel !== pane.channel) return
      virtuosoRef.current?.scrollToIndex({ index: messagesRef.current.length - 1, behavior: 'auto' })
    }
    window.addEventListener('sticki:sent', onSent)
    return () => window.removeEventListener('sticki:sent', onSent)
  }, [pane.channel])

  return (
    <div className="msg-list-wrap" ref={wrapRef}>
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        // a large TOP overscan made Virtuoso measure many rows at once when scrolling up and
        // re-anchor the scroll position — the visible "jump up then settle back". Keep the top
        // overscan small (smoother scroll) and the bottom a bit larger for incoming messages.
        increaseViewportBy={{ top: 120, bottom: 320 }}
        followOutput={(isAtBottom) => (scrollLocked ? false : isAtBottom ? 'auto' : false)}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={40}
        // a closer height estimate before measurement means less scroll re-anchoring
        defaultItemHeight={34}
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
