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
import { EMOJI_LIST } from '../lib/emojiData'
import EmotePicker from './EmotePicker'
import { useT } from '../i18n'

export const TWITCH_MESSAGE_LIMIT = 500

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

export default function InputBox({ tabId, pane, account, channelId, replyTo, onCancelReply }: Props): React.JSX.Element {
  const t = useT()
  const accounts = useAccountsStore((s) => s.accounts)
  const emoteVersion = useEmotesStore((s) => s.version)
  const showCharCounter = useSettingsStore((s) => s.settings.showCharCounter)
  const emotePickerAsWindow = useSettingsStore((s) => s.settings.emotePickerAsWindow)
  const [text, setText] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [acIndex, setAcIndex] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef('')

  const isCommand = text.startsWith('/')

  // external nick/emote inserts: right-click on a nick/emote, chatters list, etc.
  useEffect(() => {
    const onInsert = (e: Event): void => {
      const d = (e as CustomEvent<InsertEventDetail>).detail
      if (d.paneId !== pane.id) return
      setText((cur) => (cur.length === 0 || cur.endsWith(' ') ? cur + d.text : `${cur} ${d.text}`))
      taRef.current?.focus()
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
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }

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

  const suggestions = useMemo((): Suggestion[] => {
    // slash commands (while typing the command name)
    if (isCommand && !text.includes(' ')) {
      return matchCommands(text).map((cmd) => ({ kind: 'command', cmd }))
    }
    if (!currentWord) return []
    // @viewer mentions from recent chatters in this channel
    if (currentWord.startsWith('@')) {
      const q = currentWord.slice(1).toLowerCase()
      const msgs = useChatStore.getState().messages[pane.channel] ?? []
      const seen = new Set<string>()
      const out: Suggestion[] = []
      for (let i = msgs.length - 1; i >= 0 && out.length < 15; i--) {
        const m = msgs[i]
        if (!m.login || m.system || seen.has(m.login)) continue
        if (m.login.startsWith(q) || m.displayName.toLowerCase().startsWith(q)) {
          seen.add(m.login)
          out.push({ kind: 'mention', login: m.login, displayName: m.displayName })
        }
      }
      return out
    }
    // emotes
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
      if (seen.has(e.char) || !e.name.includes(q)) continue
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
  }, [currentWord, text, isCommand, pane.channel, emoteVersion, account])

  const applySuggestion = (s: Suggestion): void => {
    if (s.kind === 'command') setText(`/${s.cmd.name} `)
    else if (s.kind === 'mention') setText(text.slice(0, text.length - currentWord.length) + `@${s.login} `)
    else setText(text.slice(0, text.length - currentWord.length) + s.emote.code + ' ')
    setAcIndex(0)
    taRef.current?.focus()
  }

  const insertFromPicker = (code: string): void => {
    setText((cur) => (cur.length === 0 || cur.endsWith(' ') ? cur + code + ' ' : cur + ' ' + code + ' '))
    taRef.current?.focus()
  }

  const send = async (): Promise<void> => {
    const msg = text.trim()
    if (!msg || !account) return
    setText('')
    if (taRef.current) taRef.current.style.height = 'auto'
    setHistory((h) => [msg, ...h.slice(0, 49)])
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
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
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
      <div className="input-row">
        {suggestions.length > 0 && (
          <div className="autocomplete">
            {suggestions.map((s, i) => {
              const key =
                s.kind === 'emote' ? `e:${s.emote.provider}:${s.emote.code}` : s.kind === 'command' ? `c:${s.cmd.name}` : `m:${s.login}`
              return (
                <div
                  key={key}
                  className={`item ${i === acIndex ? 'sel' : ''}`}
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
                      <span>{s.emote.code}</span>
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
            placeholder={account ? t('input.placeholder') : t('input.placeholderReadOnly')}
            disabled={!account}
            spellCheck={false}
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
        <button className="primary" disabled={!account || !text.trim()} onClick={send}>
          ➤
        </button>
      </div>
    </div>
  )
}
