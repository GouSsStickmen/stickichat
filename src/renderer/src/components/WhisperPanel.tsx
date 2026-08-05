import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useWhispersStore, setOpenWhisperThread, loadWhisperUi, saveWhisperUi, Whisper } from '../store/whispers'
import { useAccountsStore } from '../store/accounts'
import { loadTwitchUserEmotes } from '../services/emoteService'
import { useUiStore } from '../store/ui'
import { sendWhisper, getUsers, getUserChatColors } from '../lib/helix'
import EmotePicker from './EmotePicker'
import { fallbackColor, ensureReadable } from '../lib/tokenize'
import { useSettingsStore } from '../store/settings'
import { isDarkTheme } from '../lib/themes'
import { localizeApiError } from '../lib/apiErrors'
import RichText from './RichText'
import { PinButton, emoteInsertText } from './EmotePicker'
import { useT } from '../i18n'

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** whisper text: emotes from every set (no channel context), links + RMB copy */
function WhisperText({ text }: { text: string }): React.JSX.Element {
  return <RichText msg={{ text, emotesTag: undefined, channel: '' }} />
}

/**
 * Replies, carried inside the message text.
 *
 * Twitch whispers have no reply metadata — no parent id, no thread, nothing the API will keep
 * for us. So the quote travels as text: the person on the other end reads a plain
 * `↩ «...» answer` even in the Twitch web client, and StickiChat lifts it back out into a
 * proper quote block. « » are rare enough in chat that a false positive is a curiosity, and
 * the worst it can do is style one line differently.
 */
const REPLY_RE = /^↩\s*«([^»]*)»\s*([\s\S]*)$/

function splitReply(text: string): { quote?: string; body: string } {
  const m = REPLY_RE.exec(text)
  return m ? { quote: m[1], body: m[2] } : { body: text }
}

/** one line, short, and stripped of the guillemets that delimit it */
function quoteOf(text: string): string {
  const flat = splitReply(text).body.replace(/[«»]/g, '"').replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

/** whisper conversations: popover under ✉ or a standalone window (standalone prop) */
/** "Today" / "Yesterday" / a full date, in the app's language */
function fmtDay(ts: number): string {
  const lang = useSettingsStore.getState().settings.language
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86400000)
  if (d.toDateString() === today.toDateString()) return lang === 'uk' ? 'Сьогодні' : 'Today'
  if (d.toDateString() === yesterday.toDateString()) return lang === 'uk' ? 'Вчора' : 'Yesterday'
  return d.toLocaleDateString(lang === 'uk' ? 'uk-UA' : undefined, {
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  })
}

export default function WhisperPanel({
  onClose,
  standalone
}: {
  onClose: () => void
  standalone?: boolean
}): React.JSX.Element {
  const t = useT()
  const whispers = useWhispersStore((s) => s.whispers)
  const accounts = useAccountsStore((s) => s.accounts)
  const dark = useSettingsStore((s) => isDarkTheme(s.settings.theme))
  const favorites = useSettingsStore((s) => s.settings.whisperFavorites)
  const scale = useSettingsStore((s) => s.settings.whisperScale)
  const width = useSettingsStore((s) => s.settings.whisperWidth)
  const set = useSettingsStore((s) => s.setSettings)
  // restored from disk: a stray click outside the popover used to throw away a half-written
  // message and forget which conversation was open
  const ui0 = useRef(loadWhisperUi()).current
  const [selected, setSelected] = useState<string | null>(ui0.selected) // otherLogin
  const [text, setText] = useState(ui0.selected ? (ui0.drafts[ui0.selected] ?? '') : '')
  const [composing, setComposing] = useState(ui0.composing)
  const [composeNick, setComposeNick] = useState(ui0.composeNick)
  const [composeText, setComposeText] = useState(ui0.composeText)
  const [sending, setSending] = useState(false)
  const [replyTo, setReplyTo] = useState<Whisper | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  // sent-message history for ↑/↓ recall, like the chat input
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const draftRef = useRef('')
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // real Twitch chat colors for contacts (EventSub whispers don't carry a color)
  const [colors, setColors] = useState<Record<string, string>>({})

  useEffect(() => {
    useWhispersStore.getState().markRead()
  }, [whispers.length])

  /**
   * Grow the box to the text, up to a ceiling.
   *
   * Reset to `auto` first, otherwise scrollHeight only ever reports the height we already set
   * and the box can grow but never shrink back. The cap is a third of the panel: past that the
   * thing you are replying to would be off screen, which is worse than scrolling the draft.
   */
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = Math.max(80, Math.round((rootRef.current?.clientHeight ?? 420) / 3))
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [text, selected])

  /**
   * Ctrl+wheel zooms the panel, the same gesture that zooms the chat and the tab bar.
   *
   * Listened on the panel and stopped there: the app-wide handler lives on `window`, so
   * without stopPropagation one scroll would zoom the whispers AND the chat text behind them.
   * A native listener because React's onWheel is passive and cannot preventDefault the
   * browser's own page zoom.
   */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      const cur = useSettingsStore.getState().settings.whisperScale
      const next = Math.max(0.8, Math.min(2, Math.round((cur + (e.deltaY < 0 ? 0.1 : -0.1)) * 10) / 10))
      if (next !== cur) set({ whisperScale: next })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [set])

  /** drag the left edge: the popover hangs off the right, so it grows leftwards into the app */
  const onGripDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = useSettingsStore.getState().settings.whisperWidth
    const move = (ev: PointerEvent): void => {
      const next = Math.round(Math.max(280, Math.min(760, startW + (startX - ev.clientX) / scale)))
      set({ whisperWidth: next })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // an answer belongs to the conversation it was written in
  useEffect(() => {
    setReplyTo(null)
  }, [selected])

  // keep the disk copy current — cheap, and it is what makes closing the panel harmless
  useEffect(() => {
    saveWhisperUi({ selected, composing, composeNick, composeText })
  }, [selected, composing, composeNick, composeText])
  useEffect(() => {
    if (!selected) return
    const t = window.setTimeout(() => {
      saveWhisperUi({ drafts: { ...loadWhisperUi().drafts, [selected]: text } })
    }, 250)
    return () => window.clearTimeout(t)
  }, [text, selected])
  // switching conversations shows that conversation's own unsent text
  const prevSelRef = useRef(selected)
  useEffect(() => {
    if (prevSelRef.current === selected) return
    prevSelRef.current = selected
    setText(selected ? (loadWhisperUi().drafts[selected] ?? '') : '')
  }, [selected])

  /**
   * The account's Twitch emotes, so whisper text renders them instead of printing their names.
   *
   * The chat pane loads these, which is why they were there in panel mode and gone the moment
   * the whispers were popped into their own window: a new window is a new renderer with empty
   * stores and nobody in it had ever asked for the list. Loading it here covers both modes,
   * and the list is cached in localStorage for an hour, so the panel case costs nothing.
   */
  useEffect(() => {
    for (const a of accounts) if (a._accessToken) void loadTwitchUserEmotes(a)
  }, [accounts])

  useEffect(() => {
    const account = accounts[0]
    if (!account) return
    const ids = [...new Set(whispers.map((w) => w.otherId).filter(Boolean))].filter((id) => !(id in colors))
    if (ids.length === 0) return
    getUserChatColors(account, ids).then((fetched) => {
      // remember misses too (empty string) so we don't refetch colorless users forever
      const merged: Record<string, string> = { ...fetched }
      for (const id of ids) if (!(id in merged)) merged[id] = ''
      setColors((c) => ({ ...c, ...merged }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whispers, accounts])

  const colorFor = (w: Whisper): string =>
    ensureReadable(colors[w.otherId] || w.color || fallbackColor(w.otherLogin), dark)

  /**
   * Publish which conversation is open, so its arrival does not ping — but as a HEARTBEAT,
   * not a flag. A flag set once and cleared on unmount never gets cleared when the app is
   * closed or killed with the panel open, and the leftover silences that person's whispers
   * for good. A marker that has to be renewed cannot outlive the thing it describes.
   *
   * Focus is part of "looking at it": a panel sitting open in a window behind three others is
   * not being read, and suppressing the ping for it is how a whisper gets missed entirely.
   */
  useEffect(() => {
    if (!selected) {
      setOpenWhisperThread(null)
      return
    }
    const beat = (): void => setOpenWhisperThread(document.hasFocus() ? selected : null)
    beat()
    const t = window.setInterval(beat, 3000)
    window.addEventListener('focus', beat)
    window.addEventListener('blur', beat)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('focus', beat)
      window.removeEventListener('blur', beat)
      setOpenWhisperThread(null)
    }
  }, [selected])

  // close on outside click / Escape (popover mode only)
  useEffect(() => {
    if (standalone) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      // ignore the ✉ toggle button — otherwise this closes just before its onClick
      // reopens it, so a second click on the icon never closes the panel
      if (target.closest('.whisper-btn')) return
      if (rootRef.current && !rootRef.current.contains(target)) onClose()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose, standalone])

  // favorites first, then newest conversation first
  const conversations = useMemo(() => {
    const byLogin = new Map<string, Whisper[]>()
    for (const w of whispers) {
      const arr = byLogin.get(w.otherLogin) ?? []
      arr.push(w)
      byLogin.set(w.otherLogin, arr)
    }
    return [...byLogin.entries()].sort((a, b) => {
      const favA = favorites.includes(a[0]) ? 1 : 0
      const favB = favorites.includes(b[0]) ? 1 : 0
      if (favA !== favB) return favB - favA
      return b[1][b[1].length - 1].timestamp - a[1][a[1].length - 1].timestamp
    })
  }, [whispers, favorites])

  const thread = selected ? (conversations.find(([login]) => login === selected)?.[1] ?? []) : []
  const threadLast = thread[thread.length - 1]

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread.length, selected])

  const toggleFavorite = (login: string): void => {
    set({
      whisperFavorites: favorites.includes(login)
        ? favorites.filter((f) => f !== login)
        : [...favorites, login]
    })
  }

  const send = async (msgOverride?: string): Promise<void> => {
    let msg = (msgOverride ?? text).trim()
    if (!msg || !selected || sending) return
    const account = accounts.find((a) => a.id === threadLast?.accountId) ?? accounts[0]
    if (!account || !threadLast?.otherId) return
    // the quote goes on the wire, not just in our own copy — see REPLY_RE
    if (replyTo && !msgOverride) msg = `↩ «${quoteOf(replyTo.text)}» ${msg}`
    if (!msgOverride) {
      setText('')
      setReplyTo(null)
      setHistory((h) => [msg, ...h.slice(0, 49)])
      setHistIdx(-1)
    }
    setSending(true)
    try {
      const res = await sendWhisper(account, threadLast.otherId, msg)
      if (res.ok) {
        useWhispersStore.getState().add({
          id: `w-out-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          accountId: account.id,
          otherLogin: threadLast.otherLogin,
          otherDisplay: threadLast.otherDisplay,
          otherId: threadLast.otherId,
          color: threadLast.color,
          text: msg,
          timestamp: Date.now(),
          incoming: false
        })
      } else {
        useUiStore
          .getState()
          .toast(localizeApiError((res.json as { message?: string })?.message ?? '') || t('mod.actionFail'), 'error')
      }
    } finally {
      setSending(false)
    }
  }

  const onInputKeyDown = (e: React.KeyboardEvent): void => {
    // Escape drops the reply first; only an already-plain input closes the panel
    if (e.key === 'Escape' && replyTo) {
      e.preventDefault()
      e.stopPropagation()
      setReplyTo(null)
      return
    }
    // Ctrl+Enter — send the previous message again
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault()
      if (history[0]) send(history[0])
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      send()
      return
    }
    // ↑/↓ — browse sent messages, like the chat input
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

  // start a brand-new conversation by nickname
  const startCompose = async (): Promise<void> => {
    const nick = composeNick.trim().replace(/^@/, '').toLowerCase()
    const msg = composeText.trim()
    if (!nick || !msg || sending) return
    const account = accounts[0]
    if (!account) return
    setSending(true)
    try {
      const [user] = await getUsers(account, { logins: [nick] })
      if (!user) {
        useUiStore.getState().toast(t('whisper.noUser'), 'error')
        return
      }
      const res = await sendWhisper(account, user.id, msg)
      if (res.ok) {
        useWhispersStore.getState().add({
          id: `w-out-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          accountId: account.id,
          otherLogin: user.login.toLowerCase(),
          otherDisplay: user.display_name,
          otherId: user.id,
          text: msg,
          timestamp: Date.now(),
          incoming: false
        })
        setComposing(false)
        setComposeNick('')
        setComposeText('')
        setSelected(user.login.toLowerCase())
      } else {
        useUiStore
          .getState()
          .toast(localizeApiError((res.json as { message?: string })?.message ?? '') || t('mod.actionFail'), 'error')
      }
    } finally {
      setSending(false)
    }
  }

  const threadColor = threadLast ? colorFor(threadLast) : undefined

  return (
    <div
      className={`whisper-panel ${standalone ? 'whisper-panel-standalone' : ''}`}
      ref={rootRef}
      // zoom, not font-size: the bubbles, emotes, avatars and paddings all scale together, and
      // the popover's own width scales with them, so a zoomed panel is not a narrow column of
      // giant text. `--whisper-zoom` lets max-width undo the zoom when clamping to the viewport.
      style={{ zoom: scale, ['--whisper-zoom' as string]: scale, ...(standalone ? {} : { width }) }}
    >
      {!standalone && <div className="whisper-grip" title={t('whisper.width')} onPointerDown={onGripDown} />}
      <div className="whisper-head">
        {selected || composing ? (
          <button className="ghost" onClick={() => (composing ? setComposing(false) : setSelected(null))}>
            ←
          </button>
        ) : (
          <b>✉ {t('whisper.title')}</b>
        )}
        {/* who the open conversation is with — nick in their chat color */}
        {selected && threadLast && (
          <b className="whisper-thread-title" style={{ color: threadColor }}>
            {threadLast.otherDisplay}
          </b>
        )}
        {selected && (
          <button
            className={`ghost ${favorites.includes(selected) ? 'active' : ''}`}
            title={t('whisper.favorite')}
            onClick={() => toggleFavorite(selected)}
          >
            {favorites.includes(selected) ? '⭐' : '☆'}
          </button>
        )}
        <div className="spacer" />
        {/* the offline-history caveat is worth saying once and then getting out of the way — it
            lives behind this "!" and is not a permanent banner over every conversation */}
        {!selected && !composing && (
          <button
            className={`ghost whisper-info-btn ${noteOpen ? 'active' : ''}`}
            title={t('whisper.why')}
            onClick={() => setNoteOpen((v) => !v)}
          >
            !
          </button>
        )}
        {/* "+" rather than a pencil: this starts a NEW conversation, it does not edit one */}
        {!selected && !composing && (
          <button className="ghost" title={t('whisper.new')} onClick={() => setComposing(true)}>
            ＋
          </button>
        )}
        {standalone && <PinButton settingKey="whispersPinned" />}
        {!standalone && (
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        )}
      </div>
      {composing ? (
        <div className="whisper-compose">
          <input
            autoFocus
            placeholder={t('whisper.nick')}
            value={composeNick}
            spellCheck={false}
            onChange={(e) => setComposeNick(e.target.value)}
          />
          {favorites.length > 0 && (
            <div className="whisper-fav-row">
              {favorites.map((f) => (
                <button key={f} className="chip" onClick={() => setComposeNick(f)}>
                  ⭐ {f}
                </button>
              ))}
            </div>
          )}
          <textarea
            placeholder={t('whisper.placeholder')}
            value={composeText}
            rows={3}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                startCompose()
              }
            }}
          />
          <button className="primary" disabled={!composeNick.trim() || !composeText.trim() || sending} onClick={startCompose}>
            {t('whisper.send')}
          </button>
        </div>
      ) : !selected ? (
        <div className="whisper-list">
          {noteOpen && <div className="whisper-note">{t('whisper.offlineGap')}</div>}
          {conversations.length === 0 && <div className="picker-empty">{t('whisper.empty')}</div>}
          {conversations.map(([login, msgs]) => {
            const last = msgs[msgs.length - 1]
            const color = colorFor(last)
            return (
              <button key={login} className="whisper-conv" onClick={() => setSelected(login)}>
                <span className="whisper-conv-nick" style={{ color }}>
                  {favorites.includes(login) ? '⭐ ' : ''}
                  {last.otherDisplay}
                </span>
                <span className="whisper-conv-text">
                  {last.incoming ? '' : '↦ '}
                  {last.text}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <>
          <div className="whisper-thread" ref={listRef}>
            {thread.map((w, i) => {
              // a whisper thread can span weeks and only shows a time, so "00:12" told you
              // nothing about WHICH day — start every new day with a divider
              const prev = i > 0 ? thread[i - 1] : undefined
              const newDay =
                !prev || new Date(prev.timestamp).toDateString() !== new Date(w.timestamp).toDateString()
              // a Fragment, NOT a wrapper div: the thread is a flex column and the bubbles
              // align themselves left/right — a wrapper would become the flex child and
              // every message would fall back to the left
              const { quote, body } = splitReply(w.text)
              return (
                <Fragment key={w.id}>
                  {newDay && <div className="whisper-day">{fmtDay(w.timestamp)}</div>}
                  <div className={`whisper-msg ${w.incoming ? '' : 'out'}`}>
                    {quote && <div className="whisper-quote">↩ {quote}</div>}
                    <span className="whisper-ts">{fmtTime(w.timestamp)}</span> <WhisperText text={body} />
                    <button
                      className="whisper-reply-btn"
                      title={t('whisper.reply')}
                      onClick={() => {
                        setReplyTo(w)
                        inputRef.current?.focus()
                      }}
                    >
                      ↩
                    </button>
                  </div>
                </Fragment>
              )
            })}
          </div>
          {replyTo && (
            <div className="whisper-reply-bar">
              <span className="whisper-reply-nick" style={{ color: threadColor }}>
                {replyTo.incoming ? replyTo.otherDisplay : t('whisper.you')}
              </span>
              <span className="whisper-reply-text">{quoteOf(replyTo.text)}</span>
              <button className="ghost" title={t('whisper.replyCancel')} onClick={() => setReplyTo(null)}>
                ✕
              </button>
            </div>
          )}
          <div className="whisper-input">
            {pickerOpen && (
              <EmotePicker
                channel=""
                channelId=""
                account={accounts[0]}
                fixed
                onPick={(emote) => {
                  setText((cur) => {
                    const txt = emoteInsertText(emote)
                    return cur.length === 0 || cur.endsWith(' ') ? cur + txt + ' ' : `${cur} ${txt} `
                  })
                }}
                onClose={() => setPickerOpen(false)}
              />
            )}
            {/* a textarea, not an input: a long message used to scroll away inside a one-line
                box with no way to see what you had written. It grows with the text and stops
                at a third of the panel, so it can never eat the conversation it belongs to. */}
            <textarea
              ref={inputRef}
              autoFocus
              rows={1}
              className="whisper-textarea"
              placeholder={t('whisper.placeholder')}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setHistIdx(-1)
              }}
              onKeyDown={onInputKeyDown}
            />
            <button className="ghost picker-btn" title={t('picker.open')} onClick={() => setPickerOpen((v) => !v)}>
              😊
            </button>
            <button className="primary" disabled={!text.trim() || sending} onClick={() => send()}>
              ➤
            </button>
          </div>
        </>
      )}
    </div>
  )
}
