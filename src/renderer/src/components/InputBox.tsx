import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Account, Emote, Pane } from '../types'
import { useAccountsStore } from '../store/accounts'
import { useLayoutStore } from '../store/layout'
import { useEmotesStore } from '../store/emotes'
import { useChatStore } from '../store/chat'
import { useSettingsStore } from '../store/settings'
import { chatService } from '../services/chatService'
import { useUiStore } from '../store/ui'
import { matchCommands, runSlashCommand, SlashCommand } from '../lib/slashCommands'
import { canModerate } from '../services/accountService'
import { EMOJI_LIST, emojiLabel } from '../lib/emojiData'
import { swapLayout } from '../lib/translit'
import { TranslitIcon } from './Icons'
import { hotkeyFor, matchHotkey } from '../lib/hotkeys'
import EmotePicker, { emoteInsertText } from './EmotePicker'
import EmojiGlyph from './EmojiGlyph'
import { useT } from '../i18n'
import { isMobile } from '../lib/platform'
import { getWatchStreakInfo } from '../lib/watchStreaks'

export const TWITCH_MESSAGE_LIMIT = 500

/** unsent drafts survive pane unmounts (tab switches) — keyed by pane id, session-lifetime */
const inputDrafts = new Map<string, string>()

export interface ReplyTarget {
  msgId: string
  login: string
  displayName: string
  text: string
}

export interface InsertEventDetail {
  paneId: string
  text: string
}

interface Props {
  tabId: string
  pane: Pane
  account: Account | undefined
  channelId: string
  replyTo: ReplyTarget | null
  onCancelReply: () => void
}

type Suggestion =
  | { kind: 'emote'; emote: Emote }
  | { kind: 'command'; cmd: SlashCommand }
  | { kind: 'mention'; login: string; displayName: string }
  | { kind: 'botcmd'; cmd: string }

export default function InputBox({ tabId, pane, account, channelId, replyTo, onCancelReply }: Props): React.JSX.Element {
  const t = useT()
  const accounts = useAccountsStore((s) => s.accounts)
  const emoteVersion = useEmotesStore((s) => s.version)
  const showCharCounter = useSettingsStore((s) => s.settings.showCharCounter)
  const emotePickerAsWindow = useSettingsStore((s) => s.settings.emotePickerAsWindow)
  const translitEnabled = useSettingsStore((s) => s.settings.translitEnabled)
  const emoteSuggestions = useSettingsStore((s) => s.settings.emoteSuggestions)
  const botCommands = useSettingsStore((s) => s.settings.botCommands)
  const [text, setText] = useState(() => inputDrafts.get(pane.id) ?? '')
  // own watch streak for this channel (from viewermilestone notices we've seen)
  const streamInfo = useChatStore((s) => s.streamInfo[pane.channel])
  const [streakVer, setStreakVer] = useState(0)
  const [streakOpen, setStreakOpen] = useState(false)
  useEffect(() => {
    const bump = (): void => setStreakVer((v) => v + 1)
    window.addEventListener('sticki:streak', bump)
    return () => window.removeEventListener('sticki:streak', bump)
  }, [])
  const myStreak = useMemo(
    () => (account ? getWatchStreakInfo(pane.channel, account.login) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, pane.channel, streakVer]
  )
  const streamStartTs = streamInfo?.startedAt ? Date.parse(streamInfo.startedAt) : null
  const streakClaimed = !!(myStreak && streamStartTs && myStreak.ts >= streamStartTs)
  // keep the draft in sync so switching tabs (which unmounts this pane) doesn't lose it
  useEffect(() => {
    inputDrafts.set(pane.id, text)
  }, [pane.id, text])
  // sent history survives restarts (per channel, shared by all panes of that channel)
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(`sticki:sentHistory:${pane.channel}`)
      const list = raw ? (JSON.parse(raw) as string[]) : []
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  })
  const pushHistory = (msg: string): void => {
    setHistory((h) => {
      const next = [msg, ...h.filter((x) => x !== msg)].slice(0, 50)
      try {
        localStorage.setItem(`sticki:sentHistory:${pane.channel}`, JSON.stringify(next))
      } catch {
        /* best-effort */
      }
      return next
    })
  }
  const [histIdx, setHistIdx] = useState(-1)
  const [acIndex, setAcIndex] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef('')
  const rowRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const accountAsAvatar = useSettingsStore((s) => s.settings.inputAccountDisplay) === 'avatar'
  const [acctOpen, setAcctOpen] = useState(false)
  const acctRef = useRef<HTMLSpanElement>(null)

  // the picker used to be a native <select> in one of its two modes, which closed itself; a
  // popover has to be told
  useEffect(() => {
    if (!acctOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!acctRef.current?.contains(e.target as Node)) setAcctOpen(false)
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAcctOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [acctOpen])

  // narrow panes swap the account <select> for a compact avatar button
  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 420))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const isCommand = text.startsWith('/')

  // Ctrl+RMB on a clickable token — send it to chat as a message immediately
  useEffect(() => {
    const onQuickSend = (e: Event): void => {
      const d = (e as CustomEvent<InsertEventDetail>).detail
      if (d.paneId !== pane.id || !account) return
      const msg = d.text.trim()
      if (!msg) return
      chatService.sendMessage(account, pane.channel, msg).catch((err) => {
        useUiStore.getState().toast(String(err), 'error')
      })
    }
    window.addEventListener('sticki:send', onQuickSend)
    return () => window.removeEventListener('sticki:send', onQuickSend)
  }, [pane.id, pane.channel, account])

  // external nick/emote inserts: right-click on a nick/emote, chatters list, etc.
  useEffect(() => {
    const onInsert = (e: Event): void => {
      const d = (e as CustomEvent<InsertEventDetail>).detail
      if (d.paneId !== pane.id) return
      const ta = taRef.current
      const focused = ta && document.activeElement === ta
      if (focused && ta) {
        // insert at the caret (replacing any selection), adding a space only when gluing to text
        const start = ta.selectionStart ?? ta.value.length
        const end = ta.selectionEnd ?? start
        const before = ta.value.slice(0, start)
        const after = ta.value.slice(end)
        const glue = before.length > 0 && !before.endsWith(' ') ? ' ' : ''
        const chunk = glue + d.text
        const next = before + chunk + after
        setText(next)
        requestAnimationFrame(() => {
          ta.focus()
          const pos = (before + chunk).length
          ta.setSelectionRange(pos, pos)
        })
        return
      }
      // input not focused — append at the end and drop the caret there so you can keep typing
      setText((cur) => (cur.length === 0 || cur.endsWith(' ') ? cur + d.text : `${cur} ${d.text}`))
      /*
       * On a phone, focusing here is what raised the keyboard — and the keyboard shrinks the page,
       * which pushed the top of the emote picker off the screen the moment the first emote was
       * picked. Picking emotes is not typing: the text lands in the input either way, and the
       * keyboard comes up when the user actually taps the input.
       */
      if (isMobile()) return
      requestAnimationFrame(() => {
        const t = taRef.current
        if (!t) return
        t.focus()
        const len = t.value.length
        t.setSelectionRange(len, len)
      })
    }
    window.addEventListener('sticki:insert', onInsert)
    return () => window.removeEventListener('sticki:insert', onInsert)
  }, [pane.id])

  // focus the input the moment a reply target is picked
  useEffect(() => {
    if (replyTo) taRef.current?.focus()
  }, [replyTo])

  const autoGrow = (): void => {
    const ta = taRef.current
    if (!ta) return
    const before = ta.style.height
    if (!ta.value) {
      // empty field: reset to the CSS min-height — measuring scrollHeight here picks up the
      // multi-line PLACEHOLDER and inflates the box after erasing text
      ta.style.height = ''
      if (before !== '') {
        window.dispatchEvent(new CustomEvent('sticki:inputgrew', { detail: { paneId: pane.id } }))
      }
      return
    }
    /**
     * Measuring costs a collapse, and the collapse costs the chat its scroll position.
     *
     * To measure the content the box has to go to `height: auto` for an instant — which, at two
     * or more lines, makes it ONE line tall and hands those pixels back to the chat above. If
     * the chat was at the end, the browser clamps its scrollTop down to fit the taller viewport;
     * restoring the real height then leaves it exactly that far SHORT of the end. That is the
     * dip under the input on every keystroke, and with scrolling locked (where nothing corrects
     * it afterwards) it is the input slowly crawling over the messages.
     *
     * Nothing is painted between the collapse and the restore, so putting the scroll back here
     * erases the whole excursion. Any REAL height change is still handled afterwards, by the
     * event below and by the list's own resize handling.
     */
    const sc = ta.closest('.pane')?.querySelector<HTMLElement>('.chat-scroller') ?? null
    const keepScroll = sc?.scrollTop ?? 0
    ta.style.height = 'auto'
    // scrollHeight is content + padding and does NOT include the border, but the box is
    // border-box — so `height = scrollHeight` left the text two pixels taller than the box it
    // sits in. The field was therefore ALWAYS scrollable by a hair: the browser nudged it to
    // keep the caret in view on every keystroke, and past one line that nudge showed up as the
    // chat above twitching. Add the border back and the content fits exactly.
    const cs = getComputedStyle(ta)
    const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
    const want = ta.scrollHeight + border
    ta.style.height = `${Math.min(want, 120)}px`
    // scrollHeight is an INTEGER while the real layout is fractional (any zoom, any line-height
    // that lands on a half pixel), so the box can still end up a sliver short of its content —
    // and a textarea that is a sliver scrollable gets nudged by the browser on every keystroke
    // to keep the caret in view. Below the cap, take one extra pixel: invisible, and it ends
    // the nudging for good.
    if (want < 120 && ta.scrollHeight > ta.clientHeight) ta.style.height = `${want + 1}px`
    if (sc && Math.abs(sc.scrollTop - keepScroll) > 0.5) sc.scrollTop = keepScroll
    /**
     * Tell the chat above, NOW.
     *
     * The list also watches its own size, but a ResizeObserver whose target changed during the
     * layout-effect phase can be delivered in the FOLLOWING frame — and the frame in between is
     * painted with the shorter viewport and the old scroll position, which is the chat visibly
     * dropping behind the input for a sixtieth of a second on every line it gains. This event is
     * dispatched synchronously, before paint, so the correction lands in the same frame.
     */
    if (before !== ta.style.height) {
      window.dispatchEvent(new CustomEvent('sticki:inputgrew', { detail: { paneId: pane.id } }))
    }
  }

  // Grow on EVERY text change, not only typing: external inserts (emotes, mod-button fill,
  // history recall) bypass onChange and used to leave the box at its old height.
  //
  // BEFORE paint, not after: as a plain effect this ran once the frame with the new text was
  // already on screen, so a character that added a line was painted at the old height first and
  // the correction landed a frame later — visible as the chat twitching under the input.
  useLayoutEffect(() => {
    autoGrow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const syncHighlightScroll = (): void => {
    if (highlightRef.current && taRef.current) {
      highlightRef.current.scrollTop = taRef.current.scrollTop
      highlightRef.current.scrollLeft = taRef.current.scrollLeft
    }
  }

  const currentWord = useMemo(() => {
    if (isCommand) return ''
    const m = /(^|\s)(\S{2,})$/.exec(text)
    return m ? m[2] : ''
  }, [text, isCommand])

  // @mentions get their own matcher so suggestions appear the moment "@" is typed
  // (the general currentWord needs 2+ chars, which hid the list until "@x"). Works mid-command
  // too — "/ban @user" should still suggest nicks after the command name.
  const mentionQuery = useMemo(() => {
    const m = /(^|\s)@(\S*)$/.exec(text)
    return m ? m[2].toLowerCase() : null
  }, [text])

  const suggestions = useMemo((): Suggestion[] => {
    // no autocomplete while browsing sent history — its arrows must keep working even
    // when a recalled message ends with an emote word
    if (histIdx !== -1) return []
    // slash commands (while typing the command name) — only those this account can use here
    if (isCommand && !text.includes(' ')) {
      const isBroadcaster = !!account && account.login.toLowerCase() === pane.channel.toLowerCase()
      const isMod = canModerate(account, pane.channel, channelId)
      return matchCommands(text, { isMod, isBroadcaster }).map((cmd) => ({ kind: 'command', cmd }))
    }
    // @viewer mentions from recent chatters in this channel (fires even on a bare "@")
    if (mentionQuery !== null) {
      const q = mentionQuery
      const msgs = useChatStore.getState().messages[pane.channel] ?? []
      const seen = new Set<string>()
      const out: Suggestion[] = []
      for (let i = msgs.length - 1; i >= 0 && out.length < 15; i--) {
        const m = msgs[i]
        if (!m.login || m.system || seen.has(m.login)) continue
        if (!q || m.login.startsWith(q) || m.displayName.toLowerCase().startsWith(q)) {
          seen.add(m.login)
          out.push({ kind: 'mention', login: m.login, displayName: m.displayName })
        }
      }
      return out
    }
    if (!currentWord) return []
    // "!" bot commands (StreamElements etc.) — suggested from the configurable list
    if (currentWord.startsWith('!') && currentWord.length >= 1) {
      const q = currentWord.toLowerCase()
      const hits = botCommands.filter((c) => c.toLowerCase().startsWith(q))
      if (hits.length) return hits.slice(0, 15).map((cmd) => ({ kind: 'botcmd', cmd }))
    }
    // emotes — the user can turn these suggestions off (commands and @mentions stay)
    if (!emoteSuggestions) return []
    const st = useEmotesStore.getState()
    const seen = new Set<string>()
    const out: Suggestion[] = []
    const q = currentWord.toLowerCase()
    const scan = (list: Iterable<Emote>): void => {
      for (const emote of list) {
        if (out.length >= 25) return
        if (seen.has(emote.code)) continue
        if (emote.code.toLowerCase().includes(q)) {
          seen.add(emote.code)
          out.push({ kind: 'emote', emote })
        }
      }
    }
    scan(st.channelEmotes[pane.channel]?.values() ?? [])
    if (account) scan(st.twitchByAccount[account.id] ?? [])
    scan(st.globalEmotes.values())
    for (const e of EMOJI_LIST) {
      if (out.length >= 25) break
      if (seen.has(e.char)) continue
      if (!e.name.includes(q) && !e.nameUk.toLowerCase().includes(q)) continue
      seen.add(e.char)
      out.push({ kind: 'emote', emote: { code: e.char, url: '', provider: 'emoji' } })
    }
    out.sort((a, b) => {
      if (a.kind !== 'emote' || b.kind !== 'emote') return 0
      const ap = a.emote.code.toLowerCase().startsWith(q) ? 0 : 1
      const bp = b.emote.code.toLowerCase().startsWith(q) ? 0 : 1
      return ap - bp || a.emote.code.localeCompare(b.emote.code)
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWord, mentionQuery, text, isCommand, pane.channel, emoteVersion, account, histIdx, emoteSuggestions, botCommands])

  const applySuggestion = (s: Suggestion): void => {
    if (s.kind === 'command') setText(`/${s.cmd.name} `)
    else if (s.kind === 'mention') {
      // remove the "@query" the user typed (query may be empty on a bare "@")
      const typed = mentionQuery !== null ? mentionQuery.length + 1 : currentWord.length
      setText(text.slice(0, text.length - typed) + `@${s.login} `)
    } else if (s.kind === 'botcmd') {
      setText(text.slice(0, text.length - currentWord.length) + s.cmd + ' ')
    } else setText(text.slice(0, text.length - currentWord.length) + s.emote.code + ' ')
    setAcIndex(0)
    taRef.current?.focus()
  }

  const insertFromPicker = (code: string): void => {
    setText((cur) => (cur.length === 0 || cur.endsWith(' ') ? cur + code + ' ' : cur + ' ' + code + ' '))
    /*
     * On the desktop focus goes back to the chat input, so Enter sends immediately instead of the
     * caret being left in the picker's search field. On a phone that same focus raises the keyboard
     * over half the picker after every single emote — and there is no Enter to be ready for. The text
     * lands in the input either way; the keyboard comes when the input is tapped.
     */
    if (isMobile()) return
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      const len = ta.value.length
      ta.setSelectionRange(len, len)
    })
  }

  const send = async (): Promise<void> => {
    const msg = text.trim()
    if (!msg || !account) return
    // a SPACE typed before the "/" opts out of command parsing: " /привіт" is sent to chat
    // as a plain message instead of erroring as an unknown command
    const literalSlash = text.startsWith(' ') && msg.startsWith('/')
    setText('')
    if (taRef.current) taRef.current.style.height = 'auto'
    pushHistory(msg)
    setHistIdx(-1)
    try {
      if (msg.startsWith('/') && !literalSlash) {
        await runSlashCommand(msg, {
          account,
          channel: pane.channel,
          channelId,
          toast: useUiStore.getState().toast,
          replyToMsgId: replyTo?.msgId
        })
        // a command that posted a reply has consumed it, exactly as a plain message would
        if (replyTo) onCancelReply()
      } else {
        // literal slash: KEEP the leading space in the outgoing message — Twitch's server
        // treats any message starting with "/" as a command ("Unrecognized command"), but
        // with a leading space it posts as plain text
        await chatService.sendMessage(account, pane.channel, literalSlash ? ` ${msg}` : msg, replyTo?.msgId)
        onCancelReply()
      }
    } catch (e) {
      useUiStore.getState().toast(String(e), 'error')
    }
    // let a paused (scroll-locked) message list snap back to the bottom to show the sent line
    window.dispatchEvent(new CustomEvent('sticki:sent', { detail: { channel: pane.channel } }))
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const hotkeySettings = useSettingsStore.getState().settings
    // configurable: re-send the previously sent message (default Ctrl+Shift+Enter)
    if (account && history.length > 0 && matchHotkey(e, hotkeyFor(hotkeySettings, 'resendLast'))) {
      e.preventDefault()
      chatService.sendMessage(account, pane.channel, history[0]).catch((err) => {
        useUiStore.getState().toast(String(err), 'error')
      })
      return
    }
    // configurable: send the input's text but KEEP it in the field (default Ctrl+Enter)
    if (account && text.trim() && matchHotkey(e, hotkeyFor(hotkeySettings, 'sendKeep'))) {
      e.preventDefault()
      const msg = text.trim()
      pushHistory(msg)
      chatService.sendMessage(account, pane.channel, msg, replyTo?.msgId).catch((err) => {
        useUiStore.getState().toast(String(err), 'error')
      })
      return
    }
    if (suggestions.length > 0) {
      if (e.key === 'Tab') {
        e.preventDefault()
        applySuggestion(suggestions[Math.max(acIndex, 0)])
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAcIndex((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAcIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
    }
    if (e.key === 'Escape' && replyTo) {
      onCancelReply()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
      return
    }
    // recall previously sent messages: Up walks back, Down walks forward to the empty draft
    if (e.key === 'ArrowUp' && (text === '' || histIdx !== -1) && history.length > 0) {
      e.preventDefault()
      if (histIdx === -1) draftRef.current = text
      const next = Math.min(histIdx + 1, history.length - 1)
      setHistIdx(next)
      setText(history[next])
      return
    }
    if (e.key === 'ArrowDown' && histIdx !== -1) {
      e.preventDefault()
      const next = histIdx - 1
      if (next < 0) {
        setHistIdx(-1)
        setText(draftRef.current)
      } else {
        setHistIdx(next)
        setText(history[next])
      }
    }
  }

  const overLimit = text.length > TWITCH_MESSAGE_LIMIT

  // my account timed out / banned in this channel → lock the input with a live countdown
  const selfTimeout = useChatStore(
    (s) => (account ? s.selfTimeouts[`${pane.channel}:${account.id}`] : undefined)
  )
  const timeoutUntil = selfTimeout?.until ?? 0
  const [, tickTimeout] = useState(0)
  useEffect(() => {
    if (!timeoutUntil || timeoutUntil === -1 || Date.now() > timeoutUntil) return
    const id = window.setInterval(() => tickTimeout((v) => v + 1), 1000)
    return () => window.clearInterval(id)
  }, [timeoutUntil])
  const timedOut = timeoutUntil === -1 || timeoutUntil > Date.now()
  const timeoutLeft = timeoutUntil > 0 ? Math.max(0, Math.ceil((timeoutUntil - Date.now()) / 1000)) : 0
  // the reason (if the mod feed provided one) — and a compact variant for narrow panes
  const timeoutPlaceholder = timedOut
    ? timeoutUntil === -1
      ? `${narrow ? '🚫' : t('input.banned')}${selfTimeout?.reason ? ` — ${selfTimeout.reason}` : ''}`
      : narrow
        ? `⏳ ${timeoutLeft}с`
        : `${t('input.timedOut', { seconds: timeoutLeft })}${selfTimeout?.reason ? ` — ${selfTimeout.reason}` : ''}`
    : null

  return (
    <div className="input-area">
      {replyTo && (
        <div className="reply-bar">
          <span className="reply-bar-text">
            ↩ {t('reply.to')} <b>@{replyTo.displayName}</b>: {replyTo.text}
          </span>
          <button className="ghost" onClick={onCancelReply}>
            ✕
          </button>
        </div>
      )}
      <div className="input-row" ref={rowRef}>
        {suggestions.length > 0 && (
          <div className="autocomplete">
            {suggestions.map((s, i) => {
              const key =
                s.kind === 'emote'
                  ? `e:${s.emote.provider}:${s.emote.code}`
                  : s.kind === 'command'
                    ? `c:${s.cmd.name}`
                    : s.kind === 'botcmd'
                      ? `b:${s.cmd}`
                      : `m:${s.login}`
              return (
                <div
                  key={key}
                  className={`item ${i === acIndex ? 'sel' : ''}`}
                  ref={i === acIndex ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    applySuggestion(s)
                  }}
                >
                  {s.kind === 'emote' && (
                    <>
                      {s.emote.provider === 'emoji' ? (
                        <EmojiGlyph char={s.emote.code} className="emoji-cell-char" />
                      ) : (
                        <img src={s.emote.url} alt="" loading="lazy" />
                      )}
                      <span>
                        {s.emote.provider === 'emoji'
                          ? emojiLabel(s.emote.code, useSettingsStore.getState().settings.emojiNameLang)
                          : s.emote.code}
                      </span>
                      <span className="provider">{s.emote.provider}</span>
                    </>
                  )}
                  {s.kind === 'command' && (
                    <>
                      <span style={{ fontWeight: 600 }}>{s.cmd.usage}</span>
                      <span className="provider" style={{ textTransform: 'none' }}>
                        {s.cmd.desc}
                      </span>
                    </>
                  )}
                  {s.kind === 'mention' && (
                    <>
                      <span style={{ fontWeight: 600 }}>@{s.displayName}</span>
                      <span className="provider" style={{ textTransform: 'none' }}>
                        {s.login}
                      </span>
                    </>
                  )}
                  {s.kind === 'botcmd' && (
                    <>
                      <span style={{ fontWeight: 600 }}>{s.cmd}</span>
                      <span className="provider">bot</span>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {pickerOpen && (
          <EmotePicker
            channel={pane.channel}
            channelId={channelId}
            account={account}
            onPick={(emote) => insertFromPicker(emoteInsertText(emote))}
            onClose={() => setPickerOpen(false)}
          />
        )}
        {/*
          One picker, two triggers.

          The compact mode had a proper popover and the full-name mode had a native <select>,
          which meant two different-looking menus for the same choice — and only the <select>
          could add an account, because "+ add" was an <option> rather than a button. Both now
          open the same panel; the only difference is whether the trigger shows a face or a name.
        */}
        <span className="account-picker" ref={acctRef}>
          <button
            className={`ghost ${narrow || accountAsAvatar ? 'account-compact' : 'account-wide'}`}
            title={account?.displayName ?? t('pane.account')}
            onClick={() => setAcctOpen((v) => !v)}
          >
            {account?.avatarUrl ? (
              <img src={account.avatarUrl} alt={account.displayName} draggable={false} />
            ) : (
              '\u{1F464}'
            )}
            {!(narrow || accountAsAvatar) && (
              <span className="account-wide-name">{account?.displayName ?? t('pane.readOnly')}</span>
            )}
          </button>
          {acctOpen && (
            <div className="popover account-pop">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  className={a.id === pane.accountId ? 'primary' : 'ghost'}
                  onClick={() => {
                    useLayoutStore.getState().updatePane(tabId, pane.id, { accountId: a.id })
                    setAcctOpen(false)
                  }}
                >
                  {a.avatarUrl && <img src={a.avatarUrl} alt="" draggable={false} />} {a.displayName}
                </button>
              ))}
              <button
                className={pane.accountId ? 'ghost' : 'primary'}
                onClick={() => {
                  useLayoutStore.getState().updatePane(tabId, pane.id, { accountId: null })
                  setAcctOpen(false)
                }}
              >
                {t('pane.readOnly')}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setAcctOpen(false)
                  useUiStore.getState().setAddAccountOpen(true)
                }}
              >
                + {t('auth.addAccount')}
              </button>
            </div>
          )}
        </span>
        {myStreak && (
          <button
            type="button"
            className={`streak-chip ${streakClaimed ? 'claimed' : 'unclaimed'}`}
            title={
              streakClaimed
                ? t('input.streak.claimed', { n: myStreak.n })
                : t('input.streak.unclaimed', { n: myStreak.n })
            }
            onClick={() => setStreakOpen((v) => !v)}
          >
            🔥
            {streakOpen ? ` ${myStreak.n}` : ''}
          </button>
        )}
        <div className="ta-wrap">
          {showCharCounter && overLimit && (
            <div className="ta-highlight" ref={highlightRef} aria-hidden>
              <span>{text.slice(0, TWITCH_MESSAGE_LIMIT)}</span>
              <span className="over-limit">{text.slice(TWITCH_MESSAGE_LIMIT)}</span>
            </div>
          )}
          <textarea
            ref={taRef}
            className={`${showCharCounter && overLimit ? 'ta-overlaid' : ''} ${showCharCounter ? 'with-counter' : ''}`}
            value={text}
            rows={1}
            placeholder={timeoutPlaceholder ?? (account ? t('input.placeholder') : t('input.placeholderReadOnly'))}
            disabled={!account || timedOut}
            spellCheck={true}
            lang="uk"
            onChange={(e) => {
              setText(e.target.value)
              setAcIndex(0)
              setHistIdx(-1)
              autoGrow()
            }}
            onScroll={syncHighlightScroll}
            onKeyDown={onKeyDown}
          />
          {showCharCounter && (
            <span className={`char-counter ${overLimit ? 'over' : ''}`}>{text.length}</span>
          )}
        </div>
        {translitEnabled && (
          <button
            className="ghost translit-btn"
            title={t('input.translit')}
            disabled={!account || !text}
            onClick={() => {
              setText(swapLayout(text))
              taRef.current?.focus()
            }}
          >
            <TranslitIcon />
          </button>
        )}
        <button
          className="ghost picker-btn"
          title={t('picker.open')}
          disabled={!account}
          onClick={() => {
            if (emotePickerAsWindow) {
              const payload = { paneId: pane.id, channel: pane.channel, channelId, accountId: account?.id ?? null }
              window.sticki.openEmotePickerWindow(`emotepicker=${encodeURIComponent(JSON.stringify(payload))}`)
            } else {
              setPickerOpen((v) => !v)
            }
          }}
        >
          😊
        </button>
        <button className="primary" disabled={!account || !text.trim() || timedOut} onClick={send}>
          ➤
        </button>
      </div>
    </div>
  )
}
