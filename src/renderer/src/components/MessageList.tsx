import { useEffect, useMemo, useRef, useState } from 'react'
import { Account, ChatMessage, Pane } from '../types'
import { useChatStore } from '../store/chat'
import { useUiStore } from '../store/ui'
import { useSettingsStore } from '../store/settings'
import { useEmotesStore } from '../store/emotes'
import ChatList, { ChatListHandle } from './ChatList'
import MessageView from './MessageView'
import { ReplyTarget } from './InputBox'
import { useT } from '../i18n'
import { diagWarn } from '../lib/diag'

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

/** split-mode scroll sync: one pane's wheel delta, replayed by its siblings */
export interface SyncScrollDetail {
  fromPaneId: string
  deltaY: number
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
  const messages = useMemo(() => {
    const kept = allMessages.filter(
      (m) =>
        (!m.groupedUnder || expandedGifts[m.groupedUnder]) &&
        (m.system || !hiddenLogins.has(m.login))
    )
    /**
     * An unfolded gift group belongs UNDER ITS HEADER, not wherever the clock left it.
     *
     * The gifts are separate usernotices and the chat keeps arriving while they land, so
     * chronological order scatters them: "показати всі" was opening a list that started three
     * or four unrelated messages further down, with other people's chat threaded through it.
     * The grouping already says which header each gift belongs to; using it for placement as
     * well as for folding is what makes the list read as one block.
     */
    if (!kept.some((m) => m.groupedUnder)) return kept
    const under = new Map<string, ChatMessage[]>()
    for (const m of kept) {
      if (!m.groupedUnder) continue
      const at = under.get(m.groupedUnder)
      if (at) at.push(m)
      else under.set(m.groupedUnder, [m])
    }
    const present = new Set(kept.map((m) => m.id))
    const out: ChatMessage[] = []
    for (const m of kept) {
      // a gift whose header is still in the buffer is emitted with the header, not here; one
      // whose header has been trimmed away keeps its own place rather than disappearing
      if (m.groupedUnder && present.has(m.groupedUnder)) continue
      out.push(m)
      const group = under.get(m.id)
      if (group) out.push(...group)
    }
    return out
  }, [allMessages, expandedGifts, hiddenLogins])
  const emoteVersion = useEmotesStore((s) => s.version)
  const listRef = useRef<ChatListHandle>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const smoothScroll = useSettingsStore((s) => s.settings.smoothChatScroll)
  const [atBottom, setAtBottom] = useState(true)
  // follow-intent: true while the user WANTS to sit at the bottom. Cleared the moment they
  // scroll UP by their own hand, restored when they reach the bottom again.
  const followingRef = useRef(true)
  const [following, setFollowing] = useState(true)
  const [flashId, setFlashId] = useState<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  /**
   * Everything that changes how tall a row draws. When any of it moves, the list stops trusting
   * its cached heights and measures again as rows come back on screen — which is why these
   * settings can be changed freely without the layout going wrong.
   *
   * The counter is the part that makes this safe rather than merely mostly right. The list now
   * skips re-reading a row whose height it already knows, so a setting missing from this list
   * is no longer self-healing the way it was when every row was measured every frame: separator
   * lines, the message layout mode, the preview scale all change heights and none of them were
   * named here. Rather than keep guessing at the list, count the times the settings object was
   * replaced at all. Settings change by hand, a few times a session; measuring again costs one
   * pass over what is on screen.
   */
  const settingsGen = useRef(0)
  const lastSettings = useRef(settings)
  if (lastSettings.current !== settings) {
    lastSettings.current = settings
    settingsGen.current++
  }
  const layoutKey = `${settingsGen.current}|${emoteVersion}`

  const stopFollowing = (): void => {
    followingRef.current = false
    setFollowing(false)
  }

  /**
   * What the reader actually sees going wrong, watched once a frame.
   *
   * Two things are worth a line in the log: the view sitting a whole screen or more away from
   * the bottom while it is supposed to be pinned there, and the list holding hundreds of
   * messages while showing almost none of them. Both are cheap to check from the scroller and
   * neither can be inferred from anything else the app records.
   */
  useEffect(() => {
    let raf = 0
    let driftSince = 0
    let worst = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const sc = listRef.current?.scroller()
      if (!sc || sc.clientHeight === 0) return
      const view = sc.clientHeight
      const away = sc.scrollHeight - sc.scrollTop - view
      if (!followingRef.current || scrollLocked) {
        driftSince = 0
        return
      }
      const shown = sc.firstElementChild?.childElementCount ?? 0
      if (messagesRef.current.length > 40 && shown < 4) {
        diagWarn('list', `${pane.channel}: showing ${shown} of ${messagesRef.current.length} rows`)
      }
      if (away > view) {
        if (!driftSince) {
          driftSince = performance.now()
          worst = away
        } else if (away > worst) worst = away
      } else if (driftSince) {
        const ms = Math.round(performance.now() - driftSince)
        driftSince = 0
        if (ms >= 16) {
          diagWarn(
            'list',
            `${pane.channel}: view drifted ${Math.round(worst)}px off the bottom for ${ms}ms while following`
          )
        }
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pane.channel, scrollLocked])

  // late content growth (link previews finishing) and background windows where rAF is
  // throttled: an explicit nudge keeps autoscroll alive
  useEffect(() => {
    const rePin = (): void => {
      if (!followingRef.current || scrollLocked) return
      const dist = listRef.current?.distanceFromBottom() ?? 0
      if (dist <= 4) return
      if (smoothScroll && dist < 400) return
      listRef.current?.toBottom()
    }
    window.addEventListener('sticki:grew', rePin)
    const keepalive = window.setInterval(rePin, 1500)

    /**
     * The input of THIS pane just changed height — correct the scroll in the same frame.
     *
     * The list watches its own size too, but a ResizeObserver whose target changed during the
     * layout-effect phase can be delivered a frame late, and that frame is painted with the
     * shorter viewport and the old scroll position: the chat visibly drops behind the input on
     * every line it gains. The input dispatches this synchronously, before paint.
     *
     * Unconditionally to the end, and NOT via rePin: rePin declines small distances while smooth
     * scroll is on, which is right for arriving messages (that gap is what the glide animates)
     * and wrong here — the viewport moved under the reader and there is nothing to animate.
     */
    const onInputGrew = (e: Event): void => {
      const detail = (e as CustomEvent<{ paneId: string }>).detail
      if (detail?.paneId !== pane.id) return
      if (!followingRef.current || scrollLocked) return
      listRef.current?.toBottom()
    }
    window.addEventListener('sticki:inputgrew', onInputGrew)

    const el = wrapRef.current
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) stopFollowing()
      // scroll-sync: broadcast the wheel delta so sibling panes move by the SAME amount.
      // Driving it off the wheel (not the scroll event) keeps it user-initiated, so panes
      // can't echo each other into a feedback loop.
      // only panes that opted in lead, and only they follow — see Pane.syncScroll
      if (pane.syncScroll) {
        window.dispatchEvent(
          new CustomEvent<SyncScrollDetail>('sticki:syncscroll', {
            detail: { fromPaneId: pane.id, deltaY: e.deltaY }
          })
        )
      }
    }
    // ...and follow someone else's wheel when sync is on
    const onSync = (ev: Event): void => {
      const d = (ev as CustomEvent<SyncScrollDetail>).detail
      if (d.fromPaneId === pane.id || !pane.syncScroll) return
      const sc = listRef.current?.scroller()
      if (!sc) return
      if (d.deltaY < 0) stopFollowing()
      sc.scrollTop += d.deltaY
    }
    el?.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('sticki:syncscroll', onSync)
    return () => {
      window.removeEventListener('sticki:grew', rePin)
      window.removeEventListener('sticki:inputgrew', onInputGrew)
      window.clearInterval(keepalive)
      el?.removeEventListener('wheel', onWheel)
      window.removeEventListener('sticki:syncscroll', onSync)
    }
  }, [scrollLocked, pane.id, pane.syncScroll, smoothScroll])

  // jump-to-message requests (clicking a reply reference)
  useEffect(() => {
    const onJump = (e: Event): void => {
      const detail = (e as CustomEvent<JumpEventDetail>).detail
      if (detail.channel !== pane.channel) return
      const idx = messagesRef.current.findIndex((m) => m.id === detail.msgId)
      if (idx < 0) return
      // jumping to an old message PARKS the view — new arrivals must not yank it back down
      stopFollowing()
      listRef.current?.toIndex(idx)
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
      followingRef.current = true
      setFollowing(true)
      listRef.current?.toBottom()
    }
    window.addEventListener('sticki:sent', onSent)
    return () => window.removeEventListener('sticki:sent', onSent)
  }, [pane.channel])

  return (
    <div className="msg-list-wrap" ref={wrapRef}>
      <ChatList
        ref={listRef}
        messages={messages}
        layoutKey={layoutKey}
        following={followingRef}
        smooth={smoothScroll}
        locked={scrollLocked}
        onUserScrolledUp={stopFollowing}
        onAtBottomChange={(b) => {
          setAtBottom(b)
          if (b) {
            followingRef.current = true
            setFollowing(true)
          }
        }}
        renderRow={(msg, index) => (
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
        <div className="new-msgs-chip" onClick={() => listRef.current?.toBottom()}>
          ↓ {t('misc.newMessages')}
        </div>
      )}
    </div>
  )
}
