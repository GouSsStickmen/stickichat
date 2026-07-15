import { useEffect, useMemo, useRef, useState } from 'react'
import { Account, Emote, EmoteProvider, FavoriteEmote, Settings } from '../types'
import type { TwitchUserEmote } from '../lib/helix'
import { useEmotesStore } from '../store/emotes'
import { useSettingsStore } from '../store/settings'
import { loadTwitchUserEmotes, loadEmoteOwnerNames } from '../services/emoteService'
import { EMOJI_LIST, emojiLabel, emojiSearchText } from '../lib/emojiData'
import { KAOMOJI } from '../lib/kaomoji'
import EmojiGlyph from './EmojiGlyph'
import { startPointerReorder } from '../lib/pointerReorder'
import { useT } from '../i18n'

const EMOJI_AS_EMOTES: Emote[] = EMOJI_LIST.map((e) => ({ code: e.char, url: '', provider: 'emoji', size: 0 }))

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

type Tab = 'favorites' | 'twitch' | 'thirdparty' | 'emoji' | 'kaomoji'

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

export function PinButton({
  settingKey
}: {
  settingKey: 'emotePickerPinned' | 'settingsPinned' | 'usercardPinned' | 'whispersPinned' | 'highlightsPinned'
}): React.JSX.Element {
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
  const pinnedOwners = useSettingsStore((s) => s.settings.pinnedEmoteOwners)

  const ownerLabel = (ownerId: string): string => {
    if (!ownerId || ownerId === '0') return 'Twitch'
    if (channelId && ownerId === channelId) return channel
    return ownerNames[ownerId] ?? '…'
  }

  // make sure the owning streamers' names + avatars are loaded (for the Twitch-tab rail),
  // even in a standalone picker window where nobody else preloaded them
  useEffect(() => {
    if (!account || twitchEmotes.length === 0) return
    const ids = [...new Set(twitchEmotes.map((e) => e.ownerId).filter((id) => id && id !== '0'))]
    if (ids.length) loadEmoteOwnerNames(account, ids)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, twitchEmotes.length])

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
    const pinned = pinnedOwners
    const entries = [...groups.entries()]
    entries.sort(([keyA, a], [keyB, b]) => {
      // user-pinned streamers (RMB on their avatar) float to the very top, in pin order
      const pa = pinned.indexOf(keyA)
      const pb = pinned.indexOf(keyB)
      if (pa !== -1 || pb !== -1) return (pa === -1 ? 1e9 : pa) - (pb === -1 ? 1e9 : pb)
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
  }, [twitchEmotes, channelId, ownerNames, pinnedOwners])

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
    for (const e of EMOJI_AS_EMOTES) push(e, emojiSearchText(e.code))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, channel, emoteVersion, twitchEmotes])

  const emojiNameLang = useSettingsStore((s) => s.settings.emojiNameLang)
  const previewSize = useSettingsStore((s) => s.settings.emotePreviewSize)
  const [preview, setPreview] = useState<Emote | FavoriteEmote | null>(null)
  const [favPop, setFavPop] = useState<string | null>(null)
  const [editFavs, setEditFavs] = useState(false)
  const favGridRef = useRef<HTMLDivElement>(null)
  const setFavoriteEmotes = useSettingsStore((s) => s.setFavoriteEmotes)

  const favSet = useMemo(
    () => new Set(favorites.map((f) => `${f.provider}:${f.code}`)),
    [favorites]
  )

  const cell = (e: Emote | FavoriteEmote): React.JSX.Element => {
    const favKey = `${e.provider}:${e.code}`
    const isFav = favSet.has(favKey)
    // kaomoji live under the 'emoji' provider but are long text — they need a wide cell
    const isKaomoji = e.provider === 'emoji' && Array.from(e.code).length > 3
    return (
      <button
        key={favKey}
        // never keep keyboard focus on a cell: Enter must go to the message input,
        // not re-trigger the last clicked emote
        tabIndex={-1}
        onMouseDown={(ev) => ev.preventDefault()}
        className={`emote-cell ${isKaomoji ? 'kaomoji-fav' : ''} ${favPop === favKey ? 'fav-pop' : ''}`}
        title={
          isKaomoji
            ? e.code
            : e.provider === 'emoji'
              ? emojiLabel(e.code, emojiNameLang)
              : `${e.code} (${PROVIDER_LABEL[e.provider]})`
        }
        onMouseEnter={() => setPreview(e)}
        onMouseLeave={() => setPreview((cur) => (cur === e ? null : cur))}
        onClick={() => onPick(e)}
        onContextMenu={(ev) => {
          ev.preventDefault()
          toggleFavorite({ code: e.code, url: e.url, provider: e.provider })
          if (!isFav) {
            setFavPop(favKey)
            window.setTimeout(() => setFavPop((cur) => (cur === favKey ? null : cur)), 500)
          }
        }}
      >
        {isFav && <span className="fav-star">⭐</span>}
        {isKaomoji ? (
          <span className="kaomoji-fav-text">{e.code}</span>
        ) : e.provider === 'emoji' ? (
          <EmojiGlyph char={e.code} className="emoji-cell-char" />
        ) : (
          <img src={e.url} alt={e.code} loading="lazy" />
        )}
      </button>
    )
  }

  // refs to each twitch owner-group section, so the avatar rail can scroll to one
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const ownerAvatars = useEmotesStore((s) => s.ownerAvatars)

  const section = (title: string, emotes: (Emote | FavoriteEmote)[], key?: string): React.JSX.Element | null =>
    emotes.length === 0 ? null : (
      <div key={key ?? title} ref={key ? (el) => (groupRefs.current[key] = el) : undefined}>
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
            ['emoji', '🙂 Emoji'],
            ['kaomoji', '(◕‿◕)']
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
        // in popup mode the message input keeps focus (Enter sends the message);
        // the standalone window has nothing else to focus, so search it is
        autoFocus={standalone}
        placeholder={t('picker.search')}
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className={`picker-body ${!query.trim() && tab === 'twitch' ? 'picker-body-twitch' : ''}`}>
        {query.trim() ? (
          searchResults.length > 0 ? (
            <div className="picker-grid">{searchResults.map(cell)}</div>
          ) : (
            <div className="picker-empty">{t('picker.empty')}</div>
          )
        ) : tab === 'favorites' ? (
          favorites.length > 0 ? (
            <>
              <button
                className={`ghost fav-edit-btn ${editFavs ? 'active' : ''}`}
                onClick={() => setEditFavs((v) => !v)}
              >
                ✎ {t('picker.editFavs')}
              </button>
              <div className="picker-grid" ref={favGridRef}>
                {editFavs
                  ? favorites.map((f, i) => (
                      <button
                        key={`${f.provider}:${f.code}`}
                        className="emote-cell fav-editing"
                        title={t('picker.editFavs')}
                        onPointerDown={(e) => {
                          if (!favGridRef.current) return
                          e.preventDefault()
                          startPointerReorder({
                            e,
                            container: favGridRef.current,
                            itemSelector: '.emote-cell',
                            index: i,
                            axis: 'x',
                            threshold: 3,
                            onMove: (from, to) => {
                              const list = [...useSettingsStore.getState().favoriteEmotes]
                              const [it] = list.splice(from, 1)
                              list.splice(to, 0, it)
                              setFavoriteEmotes(list)
                            },
                            onDragState: () => undefined
                          })
                        }}
                      >
                        {f.provider === 'emoji' ? (
                          <EmojiGlyph char={f.code} className="emoji-cell-char" />
                        ) : (
                          <img src={f.url} alt={f.code} loading="lazy" draggable={false} />
                        )}
                      </button>
                    ))
                  : favorites.map(cell)}
              </div>
            </>
          ) : (
            <div className="picker-empty">{t('picker.empty')}</div>
          )
        ) : tab === 'twitch' ? (
          twitchEmotes.length === 0 ? (
            <div className="picker-empty">{account ? '…' : t('picker.empty')}</div>
          ) : (
            <div className="picker-twitch">
              {/* avatar rail: one per emote-owning streamer, click scrolls to their group */}
              <div className="picker-owner-rail">
                {twitchGroups.map((g) => (
                  <button
                    key={g.key}
                    className={`picker-owner-avatar ${pinnedOwners.includes(g.key) ? 'pinned' : ''}`}
                    title={`${g.label}\n${t('picker.pinOwnerHint')}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => groupRefs.current[g.key]?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      // toggle-pin the streamer to the top of the rail/list (does NOT touch the
                      // favorites tab)
                      const cur = useSettingsStore.getState().settings.pinnedEmoteOwners
                      useSettingsStore.getState().setSettings({
                        pinnedEmoteOwners: cur.includes(g.key)
                          ? cur.filter((k) => k !== g.key)
                          : [g.key, ...cur]
                      })
                    }}
                  >
                    {ownerAvatars[g.key] ? (
                      <img src={ownerAvatars[g.key]} alt={g.label} loading="lazy" />
                    ) : (
                      <span>{g.label.replace('#', '').slice(0, 2)}</span>
                    )}
                    {pinnedOwners.includes(g.key) && <span className="picker-owner-pin">📌</span>}
                  </button>
                ))}
              </div>
              <div className="picker-twitch-groups">
                {twitchGroups.map((g) => section(g.label, g.emotes, g.key))}
              </div>
            </div>
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
        ) : tab === 'emoji' ? (
          <div className="picker-grid">{EMOJI_AS_EMOTES.map(cell)}</div>
        ) : (
          // kaomoji: plain-text emoticons, sent as-is
          <>
            {KAOMOJI.map((group) => (
              <div key={group.label}>
                <div className="picker-section">{group.label}</div>
                <div className="kaomoji-grid">
                  {group.items.map((k) => {
                    const isFav = favSet.has(`emoji:${k}`)
                    return (
                      <button
                        key={k}
                        tabIndex={-1}
                        className="kaomoji-cell"
                        title={`${k} · ${t('picker.favHint')}`}
                        onMouseDown={(ev) => ev.preventDefault()}
                        onClick={() => onPick({ code: k, url: '', provider: 'emoji' })}
                        onContextMenu={(ev) => {
                          ev.preventDefault()
                          toggleFavorite({ code: k, url: '', provider: 'emoji' })
                        }}
                      >
                        {isFav && <span className="fav-star">⭐</span>}
                        {k}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      {/* always the same height — a popover anchored to the input jumps otherwise */}
      <div className="picker-preview" style={{ height: previewSize + 26 }}>
        {preview ? (
          <>
            {preview.provider === 'emoji' ? (
              <span style={{ fontSize: previewSize * 0.72, lineHeight: 1 }}>
                <EmojiGlyph char={preview.code} className="emoji-preview-glyph" />
              </span>
            ) : (
              <img src={preview.url} alt={preview.code} style={{ height: previewSize }} />
            )}
            <div className="picker-preview-name">
              {preview.provider === 'emoji' ? emojiLabel(preview.code, emojiNameLang) : preview.code}
            </div>
          </>
        ) : (
          <div className="picker-preview-name">{t('picker.previewHint')}</div>
        )}
      </div>
      <div className="picker-hint">{t('picker.favHint')}</div>
    </div>
  )
}
