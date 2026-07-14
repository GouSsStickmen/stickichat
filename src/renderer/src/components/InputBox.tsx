import { useEffect, useMemo, useRef, useState } from 'react'
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
import { hotkeyFor, matchHotkey } from '../lib/hotkeys'
import EmotePicker from './EmotePicker'
import { useT } from '../i18n'

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
  const [acctOpen, setAcctOpen] = useState(false)

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
    if (!ta.value) {
      // empty field: reset to the CSS min-height — measuring scrollHeight here picks up the
      // multi-line PLACEHOLDER and inflates the box after erasing text
      ta.style.height = ''
      return
    }
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }

  // grow on EVERY text change, not only typing: external inserts (emotes, mod-button fill,
  // history recall) bypass onChange and used to leave the box at its old height
  useEffect(() => {
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
    // move focus (and the caret) back to the chat input so Enter sends right away, instead of
    // leaving it in the picker's search field
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
    setText('')
    if (taRef.current) taRef.current.style.height = 'auto'
    pushHistory(msg)
    setHistIdx(-1)
    try {
      if (msg.startsWith('/')) {
        await runSlashCommand(msg, {
          account,
          channel: pane.channel,
          channelId,
          toast: useUiStore.getState().toast
        })
      } else {
        await chatService.sendMessage(account, pane.channel, msg, replyTo?.msgId)
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
                        <span className="emoji-cell-char">{s.emote.code}</span>
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
            onPick={(emote) => insertFromPicker(emote.code)}
            onClose={() => setPickerOpen(false)}
          />
        )}
        {narrow ? (
          <span style={{ position: 'relative' }}>
            <button
              className="ghost account-compact"
              title={account?.displayName ?? t('pane.account')}
              onClick={() => setAcctOpen((v) => !v)}
            >
              {account?.avatarUrl ? (
                <img src={account.avatarUrl} alt={account.displayName} draggable={false} />
              ) : (
                '👤'
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
                  className="ghost"
                  onClick={() => {
                    useLayoutStore.getState().updatePane(tabId, pane.id, { accountId: null })
                    setAcctOpen(false)
                  }}
                >
                  {t('pane.readOnly')}
                </button>
              </div>
            )}
          </span>
        ) : (
          <select
            className="account-select"
            title={t('pane.account')}
            value={pane.accountId ?? ''}
            onChange={(e) => {
              if (e.target.value === '__add__') {
                useUiStore.getState().setAddAccountOpen(true)
                return
              }
              useLayoutStore.getState().updatePane(tabId, pane.id, { accountId: e.target.value || null })
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
            <option value="">{t('pane.readOnly')}</option>
            <option value="__add__">+ {t('auth.addAccount')}</option>
          </select>
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
            className={showCharCounter && overLimit ? 'ta-overlaid' : ''}
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
            <span className={`char-counter ${overLimit ? 'over' : ''}`}>
              {text.length}/{TWITCH_MESSAGE_LIMIT}
            </span>
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
            {/* monochrome "A ⇄ Ф" layout-swap glyph; currentColor follows the button state */}
            <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true">
              <text
                x="7"
                y="11.5"
                textAnchor="middle"
                fontSize="11.5"
                fontWeight="700"
                fill="currentColor"
              >
                A
              </text>
              <text
                x="17"
                y="23"
                textAnchor="middle"
                fontSize="11.5"
                fontWeight="700"
                fill="currentColor"
              >
                Ф
              </text>
              <g stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 10 V7.5 Q21 5 18.5 5 H14.5" />
                <path d="M16.5 2.5 L14 5 L16.5 7.5" />
                <path d="M3 14 V16.5 Q3 19 5.5 19 H9.5" />
                <path d="M7.5 16.5 L10 19 L7.5 21.5" />
              </g>
            </svg>
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
