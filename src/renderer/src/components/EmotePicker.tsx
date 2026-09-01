import { useEffect, useMemo, useRef, useState } from 'react'
import { Account, Emote, EmoteProvider, FavoriteEmote, Settings } from '../types'
import type { TwitchUserEmote } from '../lib/helix'
import { emotePageUrl } from '../lib/emoteProviders'
import { useEmotesStore } from '../store/emotes'
import { useSettingsStore, favKey as favKeyOf } from '../store/settings'
import { loadTwitchUserEmotes, loadTwitchChannelEmotes, loadEmoteOwnerNames } from '../services/emoteService'
import { EMOJI_LIST, emojiLabel, emojiSearchText } from '../lib/emojiData'
import { KAOMOJI } from '../lib/kaomoji'
import EmojiGlyph from './EmojiGlyph'
import { startPointerReorder } from '../lib/pointerReorder'
import { useT } from '../i18n'
import { StarIcon, LockIcon, PinIcon } from './Icons'

// One shared observer: an <img> gets its real src only when it approaches the viewport.
// Native loading="lazy" still fired THOUSANDS of parallel requests for big 7TV channels
// (every hidden section counted as "near"), which crawled for minutes against the CDN.
const imgObserver =
  typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue
            const img = en.target as HTMLImageElement
            const src = img.dataset.src
            if (src) {
              img.src = src
              delete img.dataset.src
            }
            imgObserver?.unobserve(img)
          }
        },
        { rootMargin: '500px' }
      )
    : null

/** url -> "is this emote noticeably wider than tall?", measured once and reused */
const aspectCache = new Map<string, boolean>()
let aspectTimer: number | null = null
const aspectSubs = new Set<() => void>()

function noteAspect(url: string, wide: boolean): void {
  if (aspectCache.get(url) === wide) return
  aspectCache.set(url, wide)
  if (!wide) return // only widening changes the layout
  if (aspectTimer !== null) return
  // coalesce a burst of loads into a single layout pass once scrolling settles
  aspectTimer = window.setTimeout(() => {
    aspectTimer = null
    for (const fn of aspectSubs) fn()
  }, 350)
}

function LazyImg({ src, alt }: { src: string; alt: string }): React.JSX.Element {
  const ref = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const img = ref.current
    if (!img) return
    if (!imgObserver) {
      img.src = src
      return
    }
    img.dataset.src = src
    imgObserver.observe(img)
    return () => imgObserver.unobserve(img)
  }, [src])
  // a wide emote is only known for sure once the image is decoded (BTTV ships no size in its
  // metadata). Mutating the cell's class right here reflowed the whole grid on every lazy
  // load while scrolling — the "picker scrolls badly" jank. Record it instead and let one
  // debounced re-render pick the new widths up.
  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>): void => {
    const img = e.currentTarget
    if (!img.naturalWidth || !img.naturalHeight) return
    noteAspect(src, img.naturalWidth / img.naturalHeight >= 1.6)
  }
  return <img ref={ref} alt={alt} decoding="async" draggable={false} onError={retryImg} onLoad={onLoad} />
}

/** retry once with a cache-buster when the CDN hiccups (images silently stop loading) */
function retryImg(e: React.SyntheticEvent<HTMLImageElement>): void {
  const img = e.currentTarget
  if (img.dataset.retried) return
  img.dataset.retried = '1'
  const src = img.src
  window.setTimeout(() => {
    img.src = src.includes('?') ? `${src}&r=1` : `${src}?r=1`
  }, 1200)
}

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

/**
 * Text to type for a picked emote. A saved COMBINATION expands to the base emote followed by
 * each zero-width layer — chat re-stacks them from exactly that word order.
 */
export function emoteInsertText(e: Emote | FavoriteEmote): string {
  const overlays = 'overlays' in e && e.overlays ? e.overlays : []
  return [e.code, ...overlays.map((o) => o.code)].join(' ')
}

const PROVIDER_LABEL: Record<EmoteProvider, string> = {
  '7tv': '7TV',
  bttv: 'BTTV',
  ffz: 'FFZ',
  twitch: 'Twitch',
  emoji: 'Emoji'
}

function groupByProvider(
  map: Map<string, Emote> | undefined,
  sort: Settings['pickerSort']
): Map<EmoteProvider, Emote[]> {
  const groups = new Map<EmoteProvider, Emote[]>()
  if (!map) return groups
  for (const e of map.values()) {
    const arr = groups.get(e.provider) ?? []
    arr.push(e)
    groups.set(e.provider, arr)
  }
  // smallest to largest; unknown sizes (e.g. BTTV has none) sort after known ones
  const bySize = (a: Emote, b: Emote): number =>
    (a.size ?? Infinity) - (b.size ?? Infinity) || a.code.localeCompare(b.code)
  for (const arr of groups.values()) {
    if (sort === 'name') arr.sort((a, b) => a.code.localeCompare(b.code))
    else if (sort === 'overlaysFirst' || sort === 'overlaysLast') {
      // one block of overlays and one of the rest, each still smallest-first inside itself
      const dir = sort === 'overlaysFirst' ? -1 : 1
      arr.sort((a, b) => (Number(!!a.zeroWidth) - Number(!!b.zeroWidth)) * dir || bySize(a, b))
    } else arr.sort(bySize)
  }
  return groups
}

export function PinButton({
  settingKey
}: {
  settingKey: 'emotePickerPinned' | 'settingsPinned' | 'usercardPinned' | 'whispersPinned' | 'highlightsPinned'
}): React.JSX.Element {
  const t = useT()
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
      title={t('set.alwaysOnTop')}
      onClick={() => {
        const next = !pinned
        setPinned(next)
        window.sticki.setAlwaysOnTop(next)
        if (remember) set({ [settingKey]: next } as Partial<Settings>)
      }}
    >
      <PinIcon size={13} />
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
  // re-render when newly measured wide emotes are flushed (see noteAspect)
  const [, bumpAspect] = useState(0)
  useEffect(() => {
    const fn = (): void => bumpAspect((v) => v + 1)
    aspectSubs.add(fn)
    return () => {
      aspectSubs.delete(fn)
    }
  }, [])

  // sub/follower/global twitch emotes for the sending account, plus THIS channel's full
  // set (so its free/locked emotes show even without a sub)
  useEffect(() => {
    if (!account) return
    loadTwitchUserEmotes(account)
    if (channelId) loadTwitchChannelEmotes(account, channelId)
  }, [account, channelId])

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
    // usable emotes first, padlocked (sub-only) ones after them — while you have no sub the
    // grid should lead with what you can actually send
    for (const g of groups.values()) {
      g.emotes.sort((a, b) => {
        const la = a.locked ? 1 : 0
        const lb = b.locked ? 1 : 0
        return la !== lb ? la - lb : a.code.localeCompare(b.code)
      })
    }
    const pinned = pinnedOwners
    const entries = [...groups.entries()]
    entries.sort(([keyA, a], [keyB, b]) => {
      // the streamer of the channel the picker was opened on ALWAYS sits first —
      // above even the pinned ones (avatar rail and emote sections alike)
      if (channelId && keyA === channelId) return -1
      if (channelId && keyB === channelId) return 1
      // then user-pinned streamers (RMB on their avatar), in pin order
      const pa = pinned.indexOf(keyA)
      const pb = pinned.indexOf(keyB)
      if (pa !== -1 || pb !== -1) return (pa === -1 ? 1e9 : pa) - (pb === -1 ? 1e9 : pb)
      if (keyA === '0') return 1
      if (keyB === '0') return -1
      return a.label.localeCompare(b.label)
    })
    // keep the ownerId as the React key: while owner names are still resolving every label
    // is '…', and duplicate keys across sections corrupt React's reconciliation (frozen UI)
    return entries.map(([key, g]) => ({ key, ...g }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twitchEmotes, channelId, ownerNames, pinnedOwners])

  const pickerSort = useSettingsStore((s) => s.settings.pickerSort)
  const { channelGroups, globalGroups } = useMemo(() => {
    const st = useEmotesStore.getState()
    return {
      channelGroups: groupByProvider(st.channelEmotes[channel], pickerSort),
      globalGroups: groupByProvider(st.globalEmotes, pickerSort)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, emoteVersion, pickerSort])

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
  /*
   * Shelves inside the favourites.
   *
   * `folderId` is which one is being looked at, null meaning the whole collection. `assignFor` is
   * the emote whose shelf list is open — an emote belongs to as many as you like, so it is a list
   * of checkboxes rather than a choice.
   */
  const folders = useSettingsStore((s) => s.favoriteFolders)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [assignFor, setAssignFor] = useState<string | null>(null)
  /*
   * Renaming happens in the chip itself.
   *
   * The first version asked with window.prompt, which Electron does not implement at all — it
   * returns nothing and logs a line nobody sees, so the ＋ button silently did nothing.
   */
  const [editingFolder, setEditingFolder] = useState<string | null>(null)
  const setFavoriteEmotes = useSettingsStore((s) => s.setFavoriteEmotes)

  const favSet = useMemo(() => new Set(favorites.map(favKeyOf)), [favorites])
  const shownFavorites = useMemo(() => {
    if (!folderId) return favorites
    const keys = new Set(folders.find((f) => f.id === folderId)?.keys ?? [])
    return favorites.filter((f) => keys.has(favKeyOf(f)))
  }, [favorites, folders, folderId])

  const cell = (e: Emote | FavoriteEmote): React.JSX.Element => {
    const cellKey = favKeyOf(e as FavoriteEmote)
    const isFav = favSet.has(cellKey)
    // kaomoji live under the 'emoji' provider but are long text — they need a wide cell
    // kaomoji are TEXT art; emoji ZWJ sequences also exceed 3 units but must stay square
    const isKaomoji = e.provider === 'emoji' && Array.from(e.code).length > 3 && !/\p{Extended_Pictographic}/u.test(e.code)
    // zero-width emotes are LAYERS: they render on top of the emote before them. Outlining
    // them (like 7TV does) is the only way to tell them apart from ordinary emotes.
    const isLayer = 'zeroWidth' in e && !!e.zeroWidth
    const combo = 'overlays' in e && e.overlays && e.overlays.length ? e.overlays : null
    // sub-only emote of a channel we're not subscribed to: shown so you know it exists, with
    // a padlock, and picking it would only produce plain text — so it doesn't insert
    const locked = 'locked' in e && !!(e as { locked?: boolean }).locked
    /**
     * WHY it is locked, not just that it is.
     *
     * A padlock on its own tells you the emote exists and you cannot have it, which is the
     * least useful half of the information — tier 2 and tier 3 emotes look identical to a
     * tier 1 subscriber who is wondering why theirs do not work. Twitch tells us the tier and
     * the type; this passes it on.
     */
    const lockHint = locked
      ? (() => {
          const tier = 'tier' in e ? (e as { tier?: string }).tier : undefined
          const kind = 'emoteType' in e ? (e as { emoteType?: string }).emoteType : undefined
          if (kind === 'bitstier') return t('picker.lockedBits')
          if (tier === '2000') return t('picker.lockedTier', { n: '2' })
          if (tier === '3000') return t('picker.lockedTier', { n: '3' })
          if (tier === '1000') return t('picker.lockedTier', { n: '1' })
          return t('picker.locked')
        })()
      : ''
    // 7TV/BTTV/FFZ emotes are often much wider than tall; a square cell squashes them, so a
    // wide emote gets a wide cell (the grid is dense-packed, so the row simply reflows)
    const wide = ('size' in e && !!e.size && e.size >= 48) || aspectCache.get(e.url) === true
    return (
      <button
        key={cellKey}
        // never keep keyboard focus on a cell: Enter must go to the message input,
        // not re-trigger the last clicked emote
        tabIndex={-1}
        onMouseDown={(ev) => ev.preventDefault()}
        className={`emote-cell ${isKaomoji ? 'kaomoji-fav' : ''} ${favPop === cellKey ? 'fav-pop' : ''} ${isLayer ? 'zero-width' : ''} ${combo ? 'is-combo' : ''} ${locked ? 'locked' : ''} ${wide ? 'wide' : ''}`}
        title={
          isKaomoji
            ? e.code
            : e.provider === 'emoji'
              ? emojiLabel(e.code, emojiNameLang)
              : combo
                ? [e.code, ...combo.map((o) => o.code)].join(' + ') + ` (${PROVIDER_LABEL[e.provider]})`
                : `${e.code} (${PROVIDER_LABEL[e.provider]})${isLayer ? ` · ${t('picker.zeroWidth')}` : ''}${locked ? `
${lockHint}` : ''}`
        }
        onMouseEnter={() => setPreview(e)}

        onClick={(ev) => {
          const page = e.provider !== 'emoji' ? emotePageUrl(e as Emote) : undefined
          const login = 'ownerLogin' in e ? e.ownerLogin : undefined
          if (ev.ctrlKey && ev.shiftKey && login) {
            window.sticki.openExternal(`https://twitch.tv/${login}`)
            return
          }
          if (ev.ctrlKey && page) {
            window.sticki.openExternal(page)
            return
          }
          if (locked) return
          onPick(e)
        }}
        onContextMenu={(ev) => {
          ev.preventDefault()
          toggleFavorite({
            code: e.code,
            url: e.url,
            provider: e.provider,
            zeroWidth: 'zeroWidth' in e ? e.zeroWidth : undefined,
            overlays: combo ?? undefined
          })
          if (!isFav) {
            setFavPop(cellKey)
            window.setTimeout(() => setFavPop((cur) => (cur === cellKey ? null : cur)), 500)
          }
        }}
      >
        {isFav && <span className="fav-star"><StarIcon filled size={12} /></span>}
        {locked && <span className="emote-lock" title={lockHint}><LockIcon size={12} /></span>}
        {isKaomoji ? (
          <span className="kaomoji-fav-text">{e.code}</span>
        ) : e.provider === 'emoji' ? (
          <EmojiGlyph char={e.code} className="emoji-cell-char" />
        ) : combo ? (
          <span className="emote-cell-stack">
            <LazyImg src={e.url} alt={e.code} />
            {combo.map((o, i) => (
              <img key={i} className="emote-cell-ov" src={o.url} alt="" />
            ))}
          </span>
        ) : (
          <LazyImg src={e.url} alt={e.code} />
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
        {/* no ✕ here: this is a real window and its title bar already has one */}
        {standalone && <PinButton settingKey="emotePickerPinned" />}
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
              {/*
                One shelf at a time, and "all" is a shelf too. Right-clicking an emote below says
                which shelves it sits on — an emote can be on several, so nothing is moved anywhere.
              */}
              <div className="fav-folders">
                <button className={folderId === null ? 'on' : ''} onClick={() => setFolderId(null)}>
                  {t('picker.allFavs')}
                </button>
                {folders.map((f) =>
                  editingFolder === f.id ? (
                    <input
                      key={f.id}
                      className="fav-folder-name"
                      autoFocus
                      defaultValue={f.name}
                      onMouseDown={(ev) => ev.stopPropagation()}
                      onBlur={(ev) => {
                        const name = ev.currentTarget.value.trim()
                        const st = useSettingsStore.getState()
                        // a blank name keeps the old one; deleting is the ✕, which cannot be a typo
                        if (name) {
                          st.setFavoriteFolders(
                            st.favoriteFolders.map((x) => (x.id === f.id ? { ...x, name } : x))
                          )
                        }
                        setEditingFolder(null)
                      }}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') ev.currentTarget.blur()
                        if (ev.key === 'Escape') setEditingFolder(null)
                      }}
                    />
                  ) : (
                    <span key={f.id} className={`fav-folder ${folderId === f.id ? 'on' : ''}`}>
                      <button
                        title={f.name}
                        onClick={() => setFolderId(f.id)}
                        onDoubleClick={() => setEditingFolder(f.id)}
                      >
                        {f.icon ? <img src={f.icon} alt="" /> : f.name}
                      </button>
                      {/* only on the shelf being looked at, so a ✕ is never a stray click away */}
                      {folderId === f.id && (
                        <button
                          className="fav-folder-del"
                          title={t('picker.folderDelete')}
                          onClick={() => {
                            const st = useSettingsStore.getState()
                            st.setFavoriteFolders(st.favoriteFolders.filter((x) => x.id !== f.id))
                            setFolderId(null)
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  )
                )}
                <button
                  className="fav-folder-add"
                  title={t('picker.folderNew')}
                  onClick={() => {
                    const st = useSettingsStore.getState()
                    const id = `fav-${Date.now().toString(36)}`
                    // made first, named second: there is something to look at while you type
                    st.setFavoriteFolders([
                      ...st.favoriteFolders,
                      { id, name: t('picker.folderDefault'), keys: [] }
                    ])
                    setFolderId(id)
                    setEditingFolder(id)
                  }}
                >
                  ＋
                </button>
              </div>
              <button
                className={`ghost fav-edit-btn ${editFavs ? 'active' : ''}`}
                onClick={() => setEditFavs((v) => !v)}
              >
                ✎ {t('picker.editFavs')}
              </button>
              {/*
                Checkboxes, not a chooser: the same emote belongs on the raid shelf and the bit
                shelf at once, and picking one must not take it off the other.
              */}
              {assignFor && (
                <div className="fav-assign" onMouseDown={(ev) => ev.preventDefault()}>
                  <div className="fav-assign-title">{t('picker.folderAssign')}</div>
                  {folders.length === 0 && <div className="fav-assign-empty">—</div>}
                  {folders.map((f) => {
                    const inIt = f.keys.includes(assignFor)
                    return (
                      <button
                        key={f.id}
                        className={inIt ? 'on' : ''}
                        onClick={() => useSettingsStore.getState().toggleInFolder(f.id, assignFor)}
                      >
                        <span className="fav-assign-box">{inIt ? '☑' : '☐'}</span>
                        {f.name}
                      </button>
                    )
                  })}
                  {folderId && (
                    <button
                      className="fav-assign-icon"
                      onClick={() => {
                        const fav = favorites.find((x) => favKeyOf(x) === assignFor)
                        const st = useSettingsStore.getState()
                        st.setFavoriteFolders(
                          st.favoriteFolders.map((x) =>
                            x.id === folderId ? { ...x, icon: fav?.url || undefined } : x
                          )
                        )
                        setAssignFor(null)
                      }}
                    >
                      ★ {t('picker.folderAsIcon')}
                    </button>
                  )}
                  <button className="fav-assign-close" onClick={() => setAssignFor(null)}>
                    ✕
                  </button>
                </div>
              )}
              <div className="picker-grid" ref={favGridRef}>
                {editFavs
                  ? favorites.map((f, i) => (
                      <button
                        key={favKeyOf(f)}
                        className={`emote-cell fav-editing ${
                          f.provider === 'emoji' &&
                          Array.from(f.code).length > 3 &&
                          !/\p{Extended_Pictographic}/u.test(f.code)
                            ? 'kaomoji-fav'
                            : ''
                        }`}
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
                          Array.from(f.code).length > 3 && !/\p{Extended_Pictographic}/u.test(f.code) ? (
                            <span className="kaomoji-fav-text">{f.code}</span>
                          ) : (
                            <EmojiGlyph char={f.code} className="emoji-cell-char" />
                          )
                        ) : f.overlays && f.overlays.length ? (
                          // reorder mode must show a combination as the finished stack too,
                          // otherwise every combo looks like its bare base emote
                          <span className="emote-cell-stack">
                            <LazyImg src={f.url} alt={f.code} />
                            {f.overlays.map((o, k) => (
                              <img key={k} className="emote-cell-ov" src={o.url} alt="" />
                            ))}
                          </span>
                        ) : (
                          <LazyImg src={f.url} alt={f.code} />
                        )}
                      </button>
                    ))
                  : shownFavorites.map((f) => (
                      <span
                        key={favKeyOf(f)}
                        className="fav-slot"
                        onContextMenu={(ev) => {
                          ev.preventDefault()
                          setAssignFor(favKeyOf(f))
                        }}
                      >
                        {cell(f)}
                      </span>
                    ))}
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
                    {pinnedOwners.includes(g.key) && <span className="picker-owner-pin"><PinIcon size={13} /></span>}
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
            {/* how this tab is ordered — the overlay options are the reason it exists */}
            <div className="picker-sort">
              {(
                [
                  ['size', t('picker.sort.size')],
                  ['name', t('picker.sort.name')],
                  ['overlaysFirst', t('picker.sort.overlaysFirst')],
                  ['overlaysLast', t('picker.sort.overlaysLast')]
                ] as [Settings['pickerSort'], string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={pickerSort === key ? 'on' : ''}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => useSettingsStore.getState().setSettings({ pickerSort: key })}
                >
                  {label}
                </button>
              ))}
            </div>
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
                        {isFav && <span className="fav-star"><StarIcon filled size={12} /></span>}
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
            ) : 'overlays' in preview && preview.overlays && preview.overlays.length ? (
              // a saved combination previews AS THE FINISHED STACK — seeing only the base
              // emote tells you nothing about what you're about to send
              <span className="picker-preview-stack" style={{ height: previewSize, width: previewSize }}>
                <img src={preview.url} alt="" style={{ height: previewSize }} />
                {preview.overlays.map((o, i) => (
                  <img key={i} src={o.url} alt="" style={{ height: previewSize }} />
                ))}
              </span>
            ) : (
              <img src={preview.url} alt={preview.code} style={{ height: previewSize }} />
            )}
            <div className="picker-preview-name">
              {preview.provider === 'emoji'
                ? emojiLabel(preview.code, emojiNameLang)
                : 'overlays' in preview && preview.overlays && preview.overlays.length
                  ? [preview.code, ...preview.overlays.map((o) => o.code)].join(' + ')
                  : preview.code}
            </div>
            {/* who made it — and a click straight to their channel/page, same as in chat */}
            {(() => {
              const owner = 'ownerName' in preview ? preview.ownerName : undefined
              const login = 'ownerLogin' in preview ? preview.ownerLogin : undefined
              const page = preview.provider !== 'emoji' ? emotePageUrl(preview as Emote) : undefined
              if (!owner && !page) return null
              return (
                <div className="picker-preview-owner">
                  {owner && (
                    <a
                      href="#"
                      title={t('picker.openAuthor')}
                      onClick={(ev) => {
                        ev.preventDefault()
                        if (login) window.sticki.openExternal(`https://twitch.tv/${login}`)
                      }}
                    >
                      {t('picker.by')} {owner}
                    </a>
                  )}
                  {page && (
                    <a
                      href="#"
                      title={t('picker.openEmotePage')}
                      onClick={(ev) => {
                        ev.preventDefault()
                        window.sticki.openExternal(page)
                      }}
                    >
                      ↗ {preview.provider.toUpperCase()}
                    </a>
                  )}
                </div>
              )
            })()}
          </>
        ) : (
          <div className="picker-preview-name">{t('picker.previewHint')}</div>
        )}
      </div>
      <div className="picker-hint">{t('picker.favHint')}</div>
    </div>
  )
}
