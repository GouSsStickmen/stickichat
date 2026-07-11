import { useEffect, useMemo, useRef, useState } from 'react'
import { useWhispersStore, Whisper } from '../store/whispers'
import { useAccountsStore } from '../store/accounts'
import { useUiStore } from '../store/ui'
import { sendWhisper, getUsers } from '../lib/helix'
import { fallbackColor, ensureReadable } from '../lib/tokenize'
import { useSettingsStore } from '../store/settings'
import { useT } from '../i18n'

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** whisper conversations popover, anchored under the ✉ button in the tab bar */
export default function WhisperPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  const whispers = useWhispersStore((s) => s.whispers)
  const accounts = useAccountsStore((s) => s.accounts)
  const dark = useSettingsStore((s) => s.settings.theme === 'dark')
  const [selected, setSelected] = useState<string | null>(null) // otherLogin
  const [text, setText] = useState('')
  const [composing, setComposing] = useState(false)
  const [composeNick, setComposeNick] = useState('')
  const [composeText, setComposeText] = useState('')
  const [sending, setSending] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    useWhispersStore.getState().markRead()
  }, [whispers.length])

  // close on outside click / Escape
  useEffect(() => {
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
  }, [onClose])

  // newest conversation first; a conversation = all whispers with one login
  const conversations = useMemo(() => {
    const byLogin = new Map<string, Whisper[]>()
    for (const w of whispers) {
      const arr = byLogin.get(w.otherLogin) ?? []
      arr.push(w)
      byLogin.set(w.otherLogin, arr)
    }
    return [...byLogin.entries()].sort(
      (a, b) => b[1][b[1].length - 1].timestamp - a[1][a[1].length - 1].timestamp
    )
  }, [whispers])

  const thread = selected ? (conversations.find(([login]) => login === selected)?.[1] ?? []) : []

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread.length, selected])

  const send = async (): Promise<void> => {
    const msg = text.trim()
    if (!msg || !selected) return
    const last = thread[thread.length - 1]
    const account =
      accounts.find((a) => a.id === last?.accountId) ?? accounts[0]
    if (!account || !last?.otherId) return
    setText('')
    const res = await sendWhisper(account, last.otherId, msg)
    if (res.ok) {
      useWhispersStore.getState().add({
        id: `w-out-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        accountId: account.id,
        otherLogin: last.otherLogin,
        otherDisplay: last.otherDisplay,
        otherId: last.otherId,
        color: last.color,
        text: msg,
        timestamp: Date.now(),
        incoming: false
      })
    } else {
      useUiStore
        .getState()
        .toast((res.json as { message?: string })?.message ?? t('mod.actionFail'), 'error')
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
        useUiStore.getState().toast((res.json as { message?: string })?.message ?? t('mod.actionFail'), 'error')
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="whisper-panel" ref={rootRef}>
      <div className="whisper-head">
        {selected || composing ? (
          <button className="ghost" onClick={() => (composing ? setComposing(false) : setSelected(null))}>
            ← {t('whisper.back')}
          </button>
        ) : (
          <b>✉ {t('whisper.title')}</b>
        )}
        <div className="spacer" />
        {!selected && !composing && (
          <button className="ghost" title={t('whisper.new')} onClick={() => setComposing(true)}>
            ✎
          </button>
        )}
        <button className="ghost" onClick={onClose}>
          ✕
        </button>
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
            const color = ensureReadable(last.color || fallbackColor(login), dark)
            return (
              <button key={login} className="whisper-conv" onClick={() => setSelected(login)}>
                <span className="whisper-conv-nick" style={{ color }}>
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
                <span className="whisper-ts">{fmtTime(w.timestamp)}</span> {w.text}
              </div>
            ))}
          </div>
          <div className="whisper-input">
            <input
              autoFocus
              placeholder={t('whisper.placeholder')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send()
              }}
            />
            <button className="primary" disabled={!text.trim()} onClick={send}>
              ➤
            </button>
          </div>
        </>
      )}
    </div>
  )
}
