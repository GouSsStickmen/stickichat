import { useEffect, useMemo, useRef, useState } from 'react'
import { useWhispersStore, setOpenWhisperThread, Whisper } from '../store/whispers'
import { useAccountsStore } from '../store/accounts'
import { useUiStore } from '../store/ui'
import { sendWhisper, getUsers, getUserChatColors } from '../lib/helix'
import EmotePicker from './EmotePicker'
import { fallbackColor, ensureReadable } from '../lib/tokenize'
import { useSettingsStore } from '../store/settings'
import { localizeApiError } from '../lib/apiErrors'
import RichText from './RichText'
import { PinButton } from './EmotePicker'
import { useT } from '../i18n'

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** whisper text: emotes from every set (no channel context), links + RMB copy */
function WhisperText({ text }: { text: string }): React.JSX.Element {
  return <RichText msg={{ text, emotesTag: undefined, channel: '' }} />
}

/** whisper conversations: popover under ✉ or a standalone window (standalone prop) */
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
  const dark = useSettingsStore((s) => s.settings.theme === 'dark')
  const favorites = useSettingsStore((s) => s.settings.whisperFavorites)
  const set = useSettingsStore((s) => s.setSettings)
  const [selected, setSelected] = useState<string | null>(null) // otherLogin
  const [text, setText] = useState('')
  const [composing, setComposing] = useState(false)
  const [composeNick, setComposeNick] = useState('')
  const [composeText, setComposeText] = useState('')
  const [sending, setSending] = useState(false)
  // sent-message history for ↑/↓ recall, like the chat input
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const draftRef = useRef('')
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // real Twitch chat colors for contacts (EventSub whispers don't carry a color)
  const [colors, setColors] = useState<Record<string, string>>({})

  useEffect(() => {
    useWhispersStore.getState().markRead()
  }, [whispers.length])

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

  // publish which conversation is open — the notification sound for it is suppressed
  useEffect(() => {
    setOpenWhisperThread(selected)
    return () => setOpenWhisperThread(null)
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
    const msg = (msgOverride ?? text).trim()
    if (!msg || !selected || sending) return
    const account = accounts.find((a) => a.id === threadLast?.accountId) ?? accounts[0]
    if (!account || !threadLast?.otherId) return
    if (!msgOverride) {
      setText('')
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
    <div className={`whisper-panel ${standalone ? 'whisper-panel-standalone' : ''}`} ref={rootRef}>
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
        {!selected && !composing && (
          <button className="ghost" title={t('whisper.new')} onClick={() => setComposing(true)}>
            ✎
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
            {thread.map((w) => (
              <div key={w.id} className={`whisper-msg ${w.incoming ? '' : 'out'}`}>
                <span className="whisper-ts">{fmtTime(w.timestamp)}</span> <WhisperText text={w.text} />
              </div>
            ))}
          </div>
          <div className="whisper-input">
            {pickerOpen && (
              <EmotePicker
                channel=""
                channelId=""
                account={accounts[0]}
                fixed
                onPick={(emote) => {
                  setText((cur) => (cur.length === 0 || cur.endsWith(' ') ? cur + emote.code + ' ' : `${cur} ${emote.code} `))
                }}
                onClose={() => setPickerOpen(false)}
              />
            )}
            <input
              autoFocus
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
