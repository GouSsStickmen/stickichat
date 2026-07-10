import { useEffect, useMemo, useRef, useState } from 'react'
import { Account, Pane } from '../types'
import { getChatters, Chatter } from '../lib/helix'
import { useChatStore, lookupUserBadges } from '../store/chat'
import { lookupBadgeUrl } from '../store/emotes'
import { InsertEventDetail } from './InputBox'
import { useT } from '../i18n'

interface Props {
  pane: Pane
  account: Account | undefined
  channelId: string
  isMod: boolean
  onClose: () => void
}

type Role = 'broadcaster' | 'moderator' | 'vip' | 'viewer'

function roleOf(channel: string, login: string): Role {
  const badges = lookupUserBadges(channel, login)
  if (!badges) return 'viewer'
  if (badges.some((b) => b.setId === 'broadcaster')) return 'broadcaster'
  if (badges.some((b) => b.setId === 'moderator' || b.setId === 'lead_moderator')) return 'moderator'
  if (badges.some((b) => b.setId === 'vip')) return 'vip'
  return 'viewer'
}

function badgesOf(channel: string, login: string): { setId: string; version: string }[] {
  return lookupUserBadges(channel, login) ?? []
}

export default function ChattersList({ pane, account, channelId, isMod, onClose }: Props): React.JSX.Element {
  const t = useT()
  const [chatters, setChatters] = useState<Chatter[] | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (target.closest('.chatters-btn')) return
      if (ref.current && !ref.current.contains(target)) onClose()
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

  // full list via Helix for mods, fallback to recently-active from the buffer
  useEffect(() => {
    let cancelled = false
    if (isMod && account && channelId) {
      getChatters(account, channelId).then(({ list, total: apiTotal }) => {
        if (cancelled) return
        setChatters(list)
        setTotal(apiTotal)
      })
    } else {
      const msgs = useChatStore.getState().messages[pane.channel] ?? []
      const seen = new Map<string, Chatter>()
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.login && !m.system && !seen.has(m.login)) {
          seen.set(m.login, { user_id: m.userId, user_login: m.login, user_name: m.displayName })
        }
      }
      setChatters([...seen.values()])
    }
    return () => {
      cancelled = true
    }
  }, [isMod, account, channelId, pane.channel])

  const filtered = useMemo(() => {
    if (!chatters) return []
    const q = query.trim().toLowerCase()
    const list = q
      ? chatters.filter((c) => c.user_login.includes(q) || c.user_name.toLowerCase().includes(q))
      : chatters
    return list.slice(0, 400)
  }, [chatters, query])

  const grouped = useMemo(() => {
    const groups: Record<Role, Chatter[]> = { moderator: [], vip: [], viewer: [], broadcaster: [] }
    for (const c of filtered) groups[roleOf(pane.channel, c.user_login)].push(c)
    return groups
  }, [filtered, pane.channel])

  const insert = (login: string): void => {
    window.dispatchEvent(
      new CustomEvent<InsertEventDetail>('sticki:insert', {
        detail: { paneId: pane.id, text: `@${login} ` }
      })
    )
    onClose()
  }

  const row = (c: Chatter): React.JSX.Element => {
    const badges = badgesOf(pane.channel, c.user_login)
    return (
      <button key={c.user_login} className="chatter-row" onClick={() => insert(c.user_login)}>
        {badges.map((b) => {
          const url = lookupBadgeUrl(pane.channel, b.setId, b.version)
          return url ? <img key={b.setId} className="badge" src={url} alt={b.setId} draggable={false} /> : null
        })}
        {c.user_name}
        {c.user_name.toLowerCase() !== c.user_login ? ` (${c.user_login})` : ''}
      </button>
    )
  }

  const section = (title: string, list: Chatter[]): React.JSX.Element | null =>
    list.length === 0 ? null : (
      <div key={title}>
        <div className="picker-section">
          {title} · {list.length}
        </div>
        {list.map(row)}
      </div>
    )

  return (
    <div
      className="chatters-pop"
      ref={ref}
      draggable={false}
      // the popover lives inside the draggable pane header — don't let a drag that starts
      // here bubble up and grab the whole pane
      onDragStart={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="picker-section" style={{ margin: '0 0 6px 0' }}>
        {t('chatters.title')}
        {chatters ? ` · ${total ?? chatters.length}` : ''}
      </div>
      <input
        autoFocus
        placeholder={t('chatters.search')}
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />
      {!isMod && <div className="picker-hint" style={{ marginTop: 4 }}>{t('chatters.fallback')}</div>}
      <div className="chatters-list">
        {chatters === null && <div className="picker-empty">…</div>}
        {chatters !== null && filtered.length === 0 && <div className="picker-empty">{t('chatters.empty')}</div>}
        {section(t('chatters.moderators'), grouped.moderator)}
        {section(t('chatters.vips'), grouped.vip)}
        {section(t('chatters.viewers'), grouped.viewer)}
        {section(t('chatters.broadcaster'), grouped.broadcaster)}
      </div>
    </div>
  )
}
