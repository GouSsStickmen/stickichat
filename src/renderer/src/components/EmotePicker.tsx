import { useEffect, useMemo, useRef, useState } from 'react'
import { Account, Emote, EmoteProvider, FavoriteEmote, Settings } from '../types'
import type { TwitchUserEmote } from '../lib/helix'
import { useEmotesStore } from '../store/emotes'
import { useSettingsStore } from '../store/settings'
import { loadTwitchUserEmotes } from '../services/emoteService'
import { EMOJI_LIST } from '../lib/emojiData'
import { useT } from '../i18n'

const EMOJI_AS_EMOTES: Emote[] = EMOJI_LIST.map((e) => ({ code: e.char, url: '', provider: 'emoji', size: 0 }))
// so emoji show up in typing-suggestions/search by their English name, not just the glyph itself
const EMOJI_SEARCH_NAMES = new Map(EMOJI_LIST.map((e) => [e.char, e.name]))

interface Props {
  channel: string
  channelId: string
  account: Account | undefined
  onPick: (emote: Emote | FavoriteEmote) => void
  onClose: () => void
  /** rendered as a full standalone window instead of a popover anchored to an input */
  standalone?: boolean
  /** centered fixed overlay — for contexts where an anchored popover would get clipped */
  fixed?: boolean
}

type Tab = 'favorites' | 'twitch' | 'thirdparty' | 'emoji'

const PROVIDER_LABEL: Record<EmoteProvider, string> = {
  '7tv': '7TV',
  bttv: 'BTTV',
  ffz: 'FFZ',
  twitch: 'Twitch',
  emoji: 'Emoji'
}

function groupByProvider(map: Map<string, Emote> | undefined): Map<EmoteProvider, Emote[]> {
  const groups = new Map<EmoteProvider, Emote[]>()
  if (!map) return groups
  for (const e of map.values()) {
    const arr = groups.get(e.provider) ?? []
    arr.push(e)
    groups.set(e.provider, arr)
  }
  // smallest to largest; unknown sizes (e.g. BTTV has none) sort after known ones
  for (const arr of groups.values()) {
    arr.sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity) || a.code.localeCompare(b.code))
  }
  return groups
}

export function PinButton({ settingKey }: { settingKey: 'emotePickerPinned' | 'settingsPinned' }): React.JSX.Element {
  const remember = useSettingsStore((s) => s.settings.rememberPinState)
  const saved = useSettingsStore((s) => s.settings[settingKey])
  const set = useSettingsStore((s) => s.setSettings)
  const [pinned, setPinned] = useState(remember && saved)

  // restore the remembered pin as soon as the window opens
  useEffect(() => {
    if (remember && saved) window.sticki.setAlwaysOnTop(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <button
      className={`picker-pin-btn ${pinned ? 'active' : ''}`}
      title="Always on top"
      onClick={() => {
        const next = !pinned
        setPinned(next)
        window.sticki.setAlwaysOnTop(next)
        if (remember) set({ [settingKey]: next } as Partial<Settings>)
      }}
    >
      📌
    </button>
  )
}

export default function EmotePicker({
  channel,
  channelId,
  account,
  onPick,
  onClose,
  standalone,
  fixed
}: Props): React.JSX.Element {
  const t = useT()
  const emoteVersion = useEmotesStore((s) => s.version)
  const favorites = useSettingsStore((s) => s.favoriteEmotes)
  const toggleFavorite = useSettingsStore((s) => s.toggleFavoriteEmote)
  const defaultTab = useSettingsStore((s) => s.settings.emotePickerDefaultTab)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<Tab>(defaultTab)
  const ref = useRef<HTMLDivElement>(null)

  // sub/follower/global twitch emotes for the sending account
  useEffect(() => {
    if (account) loadTwitchUserEmotes(account)
  }, [account])

  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    if (standalone) return () => document.removeEventListener('keydown', onEsc)
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      // the 😊 button toggles the picker itself — don't fight its onClick
      if (target.closest('.picker-btn')) return
      if (ref.current && !ref.current.contains(target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose, standalone])

  const twitchEmotes = useEmotesStore((s) => (account ? s.twitchByAccount[account.id] : undefined)) ?? []
  const ownerNames = useEmotesStore((s) => s.ownerNames)

  const ownerLabel = (ownerId: string): string => {
    if (!ownerId || ownerId === '0') return 'Twitch'
    if (channelId && ownerId === channelId) return `#${channel}`
    return ownerNames[ownerId] ? `#${ownerNames[ownerId]}` : '…'
  }

  // group all twitch emotes by owning channel, current channel pinned first
  const twitchGroups = useMemo(() => {
    const groups = new Map<string, { label: string; emotes: TwitchUserEmote[] }>()
    for (const e of twitchEmotes) {
      const key = e.ownerId || '0'
      const g = groups.get(key)
      if (g) g.emotes.push(e)
      else groups.set(key, { label: ownerLabel(key), emotes: [e] })
    }
    for (const g of groups.values()) g.emotes.sort((a, b) => a.code.localeCompare(b.code))
    const entries = [...groups.entries()]
    entries.sort(([keyA, a], [keyB, b]) => {
      if (channelId && keyA === channelId) return -1
      if (channelId && keyB === channelId) return 1
      if (keyA === '0') return 1
      if (keyB === '0') return -1
      return a.label.localeCompare(b.label)
    })
    // keep the ownerId as the React key: while owner names are still resolving every label
    // is '…', and duplicate keys across sections corrupt React's reconciliation (frozen UI)
    return entries.map(([key, g]) => ({ key, ...g }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twitchEmotes, channelId, ownerNames])

  const { channelGroups, globalGroups } = useMemo(() => {
    const st = useEmotesStore.getState()
    return {
      channelGroups: groupByProvider(st.channelEmotes[channel]),
      globalGroups: groupByProvider(st.globalEmotes)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, emoteVersion])

  const searchResults = useMemo((): (Emote | FavoriteEmote)[] => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const seen = new Set<string>()
    const out: (Emote | FavoriteEmote)[] = []
    const push = (e: Emote | FavoriteEmote, matchText?: string): void => {
      if (out.length >= 100 || seen.has(`${e.provider}:${e.code}`)) return
      if ((matchText ?? e.code).toLowerCase().includes(q)) {
        seen.add(`${e.provider}:${e.code}`)
        out.push(e)
      }
    }
    const st = useEmotesStore.getState()
    for (const e of twitchEmotes) push(e)
    for (const e of st.channelEmotes[channel]?.values() ?? []) push(e)
    for (const e of st.globalEmotes.values()) push(e)
    for (const e of EMOJI_AS_EMOTES) push(e, EMOJI_SEARCH_NAMES.get(e.code))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, channel, emoteVersion, twitchEmotes])

  const cell = (e: Emote | FavoriteEmote): React.JSX.Element => (
    <button
      key={`${e.provider}:${e.code}`}
      className="emote-cell"
      title={e.provider === 'emoji' ? (EMOJI_SEARCH_NAMES.get(e.code) ?? e.code) : `${e.code} (${PROVIDER_LABEL[e.provider]})`}
      onClick={() => onPick(e)}
      onContextMenu={(ev) => {
        ev.preventDefault()
        toggleFavorite({ code: e.code, url: e.url, provider: e.provider })
      }}
    >
      {e.provider === 'emoji' ? <span className="emoji-cell-char">{e.code}</span> : <img src={e.url} alt={e.code} loading="lazy" />}
    </button>
  )

  const section = (title: string, emotes: (Emote | FavoriteEmote)[], key?: string): React.JSX.Element | null =>
    emotes.length === 0 ? null : (
      <div key={key ?? title}>
        <div className="picker-section">{title}</div>
        <div className="picker-grid">{emotes.map(cell)}</div>
      </div>
    )

  return (
    <div
      className={`emote-picker ${standalone ? 'emote-picker-standalone' : ''} ${fixed ? 'emote-picker-fixed' : ''}`}
      ref={ref}
      draggable={false}
    >
      <div className="picker-tabs">
        {(
          [
            ['favorites', `⭐ ${t('picker.favorites')}`],
            ['twitch', 'Twitch'],
            ['thirdparty', '7TV · BTTV · FFZ'],
            ['emoji', '🙂 Emoji']
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button key={key} className={`picker-tab-btn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
        {standalone && (
          <>
            <PinButton settingKey="emotePickerPinned" />
            <button className="ghost picker-close-btn" title={t('misc.close')} onClick={() => window.close()}>
              ✕
            </button>
          </>
        )}
      </div>
      <input
        autoFocus
        placeholder={t('picker.search')}
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="picker-body">
        {query.trim() ? (
          searchResults.length > 0 ? (
            <div className="picker-grid">{searchResults.map(cell)}</div>
          ) : (
            <div className="picker-empty">{t('picker.empty')}</div>
          )
        ) : tab === 'favorites' ? (
          favorites.length > 0 ? (
            <div className="picker-grid">{favorites.map(cell)}</div>
          ) : (
            <div className="picker-empty">{t('picker.empty')}</div>
          )
        ) : tab === 'twitch' ? (
          twitchEmotes.length === 0 ? (
            <div className="picker-empty">{account ? '…' : t('picker.empty')}</div>
          ) : (
            <>{twitchGroups.map((g) => section(g.label, g.emotes, g.key))}</>
          )
        ) : tab === 'thirdparty' ? (
          <>
            {(['7tv', 'bttv', 'ffz'] as EmoteProvider[]).map((p) =>
              section(`${t('picker.channel')} · ${PROVIDER_LABEL[p]}`, channelGroups.get(p) ?? [])
            )}
            {(['7tv', 'bttv', 'ffz'] as EmoteProvider[]).map((p) =>
              section(`${t('picker.global')} · ${PROVIDER_LABEL[p]}`, globalGroups.get(p) ?? [])
            )}
          </>
        ) : (
          <div className="picker-grid">{EMOJI_AS_EMOTES.map(cell)}</div>
        )}
      </div>
      <div className="picker-hint">{t('picker.favHint')}</div>
    </div>
  )
}
