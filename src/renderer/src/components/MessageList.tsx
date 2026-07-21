import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { Account, ChatMessage, Pane } from '../types'
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
  const smoothScroll = useSettingsStore((s) => s.settings.smoothChatScroll)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  atBottomRef.current = atBottom
  // follow-intent: true while the user WANTS to sit at the bottom. Cleared the moment they
  // wheel UP (before any state lags), restored when they reach the bottom again. All
  // re-pin machinery keys off this — so background windows keep following through preview
  // loads, and a fast upward fling is never yanked back down.
  const followingRef = useRef(true)
  const [following, setFollowing] = useState(true)
  // smooth mode falls back to instant jumps during floods (glide can't keep up)
  const smoothOkRef = useRef(true)
  const msgTimes = useRef<number[]>([])
  const [flashId, setFlashId] = useState<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // ---- stable virtual indexing (the scroll-duplication fix) ----
  // The ring buffer trims old messages from the HEAD and history prepends to it. Without
  // `firstItemIndex` Virtuoso sees every remaining row move to a new index: its per-index
  // height cache goes stale, everything re-measures and re-anchors — the visible
  // "messages duplicate / jump for a split second" while scrolling. Tracking a monotone
  // virtual index of the first row (via `firstItemIndex`) engages Virtuoso's native
  // shiftWith/unshiftWith handling: indices stay glued to messages, measurements stay
  // valid, and head changes no longer disturb the viewport at all.
  const FIRST_BASE = 1_000_000
  const firstIndexRef = useRef(FIRST_BASE)
  const prevMessagesRef = useRef<ChatMessage[]>([])
  {
    const prev = prevMessagesRef.current
    if (prev !== messages) {
      if (prev.length > 0 && messages.length > 0) {
        const idxInNew = messages.findIndex((m) => m.id === prev[0].id)
        if (idxInNew >= 0) {
          // old head is still present, shifted right by the number of prepended rows
          firstIndexRef.current -= idxInNew
        } else {
          // old head is gone (trimmed) — count how many rows were cut off the front
          const idxInOld = prev.findIndex((m) => m.id === messages[0].id)
          if (idxInOld >= 0) firstIndexRef.current += idxInOld
          else firstIndexRef.current = FIRST_BASE // disjoint lists (clear) — start over
        }
      } else if (prev.length === 0) {
        firstIndexRef.current = FIRST_BASE
      }
      prevMessagesRef.current = messages
    }
  }

  // resizing the list (closing the highlights sidebar, closing a split pane, window resize)
  // can make Virtuoso drift to the top — re-pin to the bottom if we were following it
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (followingRef.current && !scrollLocked) {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollLocked])

  // late content growth (link previews finishing their fetch) + background windows where
  // rAF-driven followOutput gets throttled: an explicit re-pin keeps autoscroll alive
  useEffect(() => {
    const rePin = (): void => {
      if (!followingRef.current || scrollLocked) return
      // act on the REAL scroller distance: at the bottom this is a no-op (the old
      // unconditional jump interrupted smooth glides every 1.5s — visible stutter),
      // and a small distance in smooth mode means a glide is in progress — let it finish
      const sc = wrapRef.current?.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement | null
      if (sc) {
        const dist = sc.scrollHeight - sc.scrollTop - sc.clientHeight
        if (dist <= 4) return
        if (smoothScroll && dist < 400) return
      }
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' })
    }
    window.addEventListener('sticki:grew', rePin)
    const keepalive = window.setInterval(rePin, 1500)
    // scrolling UP breaks the follow immediately (state updates lag behind fast flings)
    const el = wrapRef.current
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) {
        followingRef.current = false
        setFollowing(false)
      }
    }
    el?.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      window.removeEventListener('sticki:grew', rePin)
      window.clearInterval(keepalive)
      el?.removeEventListener('wheel', onWheel)
    }
  }, [scrollLocked])

  // estimate the message rate: >3 msgs/sec means gliding cannot keep up — fall back to
  // instant jumps until the flood calms down
  useEffect(() => {
    const now = Date.now()
    const t = msgTimes.current
    t.push(now)
    while (t.length && now - t[0] > 2000) t.shift()
    smoothOkRef.current = t.length <= 6
  }, [messages.length])

  // history often arrives AFTER the empty list mounted — snap to the bottom on first fill,
  // otherwise the view stays parked at the top of the freshly-prepended scrollback
  const hadMessagesRef = useRef(false)
  useEffect(() => {
    if (!hadMessagesRef.current && messages.length > 0) {
      hadMessagesRef.current = true
      virtuosoRef.current?.scrollToIndex({ index: 'LAST' })
    }
  }, [messages.length])

  // jump-to-message requests (clicking a reply reference)
  useEffect(() => {
    const onJump = (e: Event): void => {
      const detail = (e as CustomEvent<JumpEventDetail>).detail
      if (detail.channel !== pane.channel) return
      const idx = messagesRef.current.findIndex((m) => m.id === detail.msgId)
      if (idx < 0) return
      // scrollToIndex uses LOCAL indices (0..length-1) even with firstItemIndex active —
      // the offset variant clamped to the end and the jump appeared to do nothing
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
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' })
    }
    window.addEventListener('sticki:sent', onSent)
    return () => window.removeEventListener('sticki:sent', onSent)
  }, [pane.channel])

  return (
    <div className="msg-list-wrap" ref={wrapRef}>
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        // Scrolling up into UNMEASURED rows is where the down-then-up flick comes from:
        // Virtuoso places them at the estimated height, measures the real one, then corrects
        // the scroll position. A large TOP overscan makes rows render & measure ~a screen
        // BEFORE they become visible, so the correction lands while they're still off-screen
        // — invisible. (Safe now: with stable firstItemIndex the measurement cache survives
        // buffer trims, which is what used to make a big overscan thrash.)
        increaseViewportBy={{ top: 800, bottom: 320 }}
        followOutput={(isAtBottom) => (scrollLocked ? false : isAtBottom ? (smoothScroll && smoothOkRef.current ? 'smooth' : 'auto') : false)}
        atBottomStateChange={(b) => {
          setAtBottom(b)
          if (b) {
            followingRef.current = true
            setFollowing(true)
          }
        }}
        atBottomThreshold={40}
        // apply resize corrections synchronously instead of on the next animation frame —
        // removes the one mis-positioned frame that reads as a micro-jump while scrolling up
        skipAnimationFrameInResizeObserver
        // a closer height estimate before measurement means less scroll re-anchoring
        defaultItemHeight={34}
        firstItemIndex={firstIndexRef.current}
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
      {!atBottom && !following && (
        <div
          className="new-msgs-chip"
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' })
          }
        >
          ↓ {t('misc.newMessages')}
        </div>
      )}
    </div>
  )
}
