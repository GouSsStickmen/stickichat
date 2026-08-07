import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Account, ChatMessage, FavoriteEmote, MOD_ONLY_TYPES, Settings } from '../types'
import { tokenizeMessage, Token, fallbackColor, ensureReadable, hexToRgba, formatDuration, hiResEmoteUrl } from '../lib/tokenize'
import { emotePageUrl } from '../lib/emoteProviders'
import { lookupBadgeUrl, lookupBadgeTitle, lookupBadge4x, lookupEmote, lookupCheermote, lookupTwitchEmoteOwner } from '../store/emotes'
import { lookupUserColor, isKnownChatter, lookupUserId, useChatStore } from '../store/chat'
import { useAccountsStore } from '../store/accounts'
import { highlightRuleMatches } from '../lib/highlight'
import { openUserCard as openCard } from '../lib/openUserCard'
import { useSettingsStore, favKey } from '../store/settings'
import { isDarkTheme } from '../lib/themes'
import { useUiStore } from '../store/ui'
import { runModButton } from '../services/modActions'
import { banUser, deleteChatMessage } from '../lib/helix'
import BtnIcon from './BtnIcon'
import EmojiGlyph from './EmojiGlyph'
import { ReplyTarget, InsertEventDetail } from './InputBox'
import { JumpEventDetail } from './MessageList'
import { useT } from '../i18n'
import { localizeApiError } from '../lib/apiErrors'
import { useSevenTvColors, ensureSevenTvCosmetic, paintStyleOf } from '../lib/seventvCosmetics'
import { useBttvBadges, ensureBttvBadges } from '../lib/bttvCosmetics'
import { useFfzBadges, ensureFfzBadges } from '../lib/ffzCosmetics'
import { clipSlugFromUrl, fetchLinkPreview, LinkPreviewData } from '../lib/linkPreview'
import { getSourceChannelInfo } from '../lib/sourceChannels'
import { useShoutoutCooldown, shoutoutStatus, formatCooldown } from '../lib/shoutoutCooldown'

/**
 * Tokenized messages, kept alive after their row leaves the screen.
 *
 * This is the one thing Chatterino does that a DOM chat cannot get for free. There a message is
 * laid out ONCE into a MessageLayout that lives on the message, and scrolling only paints it;
 * the layout is thrown away when the width or the font changes and at no other time. Here the
 * row is a React component, and virtualization unmounts it the moment it leaves the overscan —
 * taking its `useMemo` with it. Scroll back over the same forty messages and every one of them
 * is split into code points, matched against the emote tables and the chatter set, and rebuilt
 * from nothing. That is the work behind the hitch on a fast flick upwards.
 *
 * The tokens depend only on the message text, the emote tables and two settings, so they can
 * outlive the component. The key carries everything that can change them; a stale key simply
 * misses and re-tokenizes.
 */
const layoutCache = new Map<string, Token[]>()
/** roughly four screens of a busy channel's buffer — dropped wholesale, it refills in one pass */
const LAYOUT_CACHE_MAX = 6000

interface Props {
  msg: ChatMessage
  index: number
  paneId: string
  account: Account | undefined
  channelId: string
  isMod: boolean
  paneAccountId: string | null
  settings: Settings
  emoteVersion: number
  onReply: (target: ReplyTarget) => void
  flash: boolean
}

/** Twitch's bits Message Effects, normalised to the three looks they actually are */
export function effectClass(id: string): string {
  const k = id.toLowerCase()
  if (k.includes('party') || k.includes('emote') || k.includes('simmer')) return 'emote-party'
  if (k.includes('rainbow') || k.includes('eclipse')) return 'rainbow-eclipse'
  if (k.includes('cosmic') || k.includes('abyss')) return 'cosmic-abyss'
  return 'generic'
}

function formatTime(ts: number, withSeconds: boolean): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (!withSeconds) return `${hh}:${mm}`
  return `${hh}:${mm}:${String(d.getSeconds()).padStart(2, '0')}`
}

/** RMB inserts into the input; Ctrl+RMB sends the token to chat immediately */
function tokenContextHandler(paneId: string, text: string) {
  return (e: React.MouseEvent): void => {
    e.preventDefault()
    // Shift+right-click copies instead of inserting — the only way to get a nick onto the
    // clipboard without selecting it by hand
    if (e.shiftKey) {
      void window.sticki.copyText(text.trim())
      return
    }
    window.dispatchEvent(
      new CustomEvent<InsertEventDetail>(e.ctrlKey ? 'sticki:send' : 'sticki:insert', {
        detail: { paneId, text }
      })
    )
  }
}

function TokenView({
  token,
  paneId,
  channel,
  hiRes
}: {
  token: Token
  paneId: string
  channel: string
  hiRes?: boolean
}): React.JSX.Element {
  const linkDisplay = useSettingsStore((s) => s.settings.linkDisplay)
  const t = useT()
  // resolved up here because hooks can't live inside the switch; subscribing (rather than
  // reading getState) is what makes a mention follow a live paint change
  const mentionLogin =
    token.kind === 'mention' ? token.name.replace(/^@/, '').replace(/[^\w]+$/, '') : ''
  const mentionUid = mentionLogin ? lookupUserId(channel, mentionLogin) : undefined
  const mentionCos = useSevenTvColors((s) => (mentionUid ? s.cosmetics[mentionUid] : undefined))
  switch (token.kind) {
    case 'text':
      return <>{token.text}</>
    case 'command': {
      // "!command": right-click puts it into the input, Ctrl+right-click sends it
      return (
        <span className="command-token" title={token.text} onContextMenu={tokenContextHandler(paneId, `${token.text} `)}>
          {token.text}
        </span>
      )
    }
    case 'link':
      return (
        <LinkToken
          url={token.url}
          label={linkDisplay === 'short' ? `\u{1F517}\u00A0${t('misc.linkShort')}` : token.label}
        />
      )
    case 'mention': {
      const login = mentionLogin
      // a mention should look like the person it names — same 7TV paint/colour as their nick
      const cos = mentionCos
      const mPaint = paintStyleOf(cos, isDarkTheme(useSettingsStore.getState().settings.theme))
      const mColor = cos?.color ?? cos?.paintColor ?? token.color
      return (
        <span
          key={cos?.paint ?? 'plain'}
          className="mention-token"
          style={mPaint ?? { color: mColor }}
          title={`${login}${cos?.paintName ? ` · ${cos.paintName}` : ''} — ${t('msg.nickHint')}`}
          onClick={(e) => {
            window.dispatchEvent(
              new CustomEvent('sticki:opencard', {
                detail: { paneId, login, x: e.clientX, y: e.clientY }
              })
            )
          }}
          onContextMenu={tokenContextHandler(paneId, `@${login} `)}
        >
          {token.name}
        </span>
      )
    }
    case 'emote': {
      // Chatterino-style tooltip: the base emote, then each layer stacked on top of it, every
      // line naming its provider and (7TV/FFZ) the person who made it
      // Twitch has no per-emote page, but it does have the OWNING CHANNEL — resolve it from
      // the account's emote list so a click can go there like it does on Twitch itself
      const twOwner = token.emote.provider === 'twitch' ? lookupTwitchEmoteOwner(token.emote.code) : undefined
      const ownerLogin = token.emote.ownerLogin ?? twOwner?.login
      const ownerName = token.emote.ownerName ?? twOwner?.name
      // the full combination, in the word order chat re-stacks it from
      const codes = [token.emote.code, ...token.overlays.map((o) => o.code)].join(' ')
      const describe = (e: typeof token.emote): string =>
        `${e.code} — ${e.provider.toUpperCase()}${
          (e === token.emote ? ownerName : e.ownerName) ? ` · ${e === token.emote ? ownerName : e.ownerName}` : ''
        }`
      const title = [
        describe(token.emote),
        ...token.overlays.map((o) => `${t('msg.overlayLayer')}: ${describe(o)}`),
        emotePageUrl(token.emote) ? t('msg.emoteOpenHint') : ownerLogin ? t('msg.emoteChannelHint') : '',
        t('msg.emoteFavHint')
      ]
        .filter(Boolean)
        .join('\n')
      const page = emotePageUrl(token.emote)
      const openEmote = (e: React.MouseEvent): void => {
        // Alt+click stars the emote — and if it's a layered combo, the WHOLE stack, so a
        // combination someone built in chat can be reused from the favorites tab
        if (e.altKey) {
          const st = useSettingsStore.getState()
          // identity must include the LAYERS. Matching on the base code alone meant starring
          // "Kappa + fire" first deleted a plain "Kappa" favorite (and a second combo on the
          // same base deleted the first one) instead of adding a new entry.
          const entry: FavoriteEmote = {
            code: token.emote.code,
            url: token.emote.url,
            provider: token.emote.provider,
            zeroWidth: token.emote.zeroWidth,
            overlays: token.overlays.map((o) => ({ code: o.code, url: o.url, provider: o.provider }))
          }
          const key = favKey(entry)
          const rest = st.favoriteEmotes.filter((f) => favKey(f) !== key)
          const already = rest.length !== st.favoriteEmotes.length
          st.setFavoriteEmotes(already ? rest : [...st.favoriteEmotes, entry])
          return
        }
        // Ctrl+click goes to the owner's Twitch channel instead of the emote page.
        // Twitch emotes have no page at all, so a plain click goes to the channel directly.
        if ((e.ctrlKey || !page) && ownerLogin) {
          window.sticki.openExternal(`https://twitch.tv/${ownerLogin}`)
          return
        }
        if (page) window.sticki.openExternal(page)
      }
      return (
        <span
          className={`emote-wrap ${page || ownerLogin ? 'clickable' : ''}`}
          title={title}
          onClick={openEmote}
          onContextMenu={tokenContextHandler(paneId, `${codes} `)}
          onMouseEnter={(e) =>
            useUiStore.getState().setEmotePreview({
              url: hiResEmoteUrl(token.emote.url),
              code: token.emote.code,
              overlayUrls: token.overlays.map((o) => hiResEmoteUrl(o.url)),
              subtitle: [
                token.emote.provider === 'twitch'
                  ? t('picker.twitchEmote')
                  : `${t('picker.channelEmote')} ${token.emote.provider.toUpperCase()}`,
                ownerName ? `${t('picker.by')} ${ownerName}` : ''
              ].filter(Boolean),
              x: e.clientX,
              y: e.clientY
            })
          }
          onMouseMove={(e) => {
            const cur = useUiStore.getState().emotePreview
            if (cur) useUiStore.getState().setEmotePreview({ ...cur, x: e.clientX, y: e.clientY })
          }}
          onMouseLeave={() => useUiStore.getState().setEmotePreview(null)}
        >
          {/* NOT lazy: lazy images loaded mid-scroll, reflowing text and jolting the virtualized
              list. Eager load happens while the row is still in the overscan zone. */}
          <img src={hiRes ? hiResEmoteUrl(token.emote.url) : token.emote.url} alt="" />
          {token.overlays.map((o, i) => (
            <img key={i} src={o.url} alt="" />
          ))}
          {/* Chromium glues adjacent img alt texts together ("KappaKeepo") and drops the
              layers of a stack entirely. A clipped text node copies as real words with real
              spaces, so a combination pastes back exactly as it must be typed. */}
          <span className="emote-copy-text">{codes} </span>
        </span>
      )
    }
    case 'emoji': {
      return (
        <span className="emoji-token" title={token.char} onContextMenu={tokenContextHandler(paneId, `${token.char} `)}>
          <EmojiGlyph char={token.char} />
        </span>
      )
    }
    case 'cheer':
      return (
        <span className="cheer-token" title={`${token.bits} bits`}>
          {token.url && <img src={token.url} alt="" loading="lazy" />}
          <span className="cheer-amount" style={{ color: token.color }}>
            {token.bits}
          </span>
        </span>
      )
  }
}

// Braille art is drawn for a specific number of cells per line, but the count varies by
// generator (28–40+). Measure one cell's width in OUR font, wrap at an adjustable column
// count (slider on the art itself), and remember the last pick as the new default.
let brailleCellWidth: number | null = null
/**
 * A link in a message, and the way its preview is reached.
 *
 * Two things changed here, and the second one is why the chat stopped moving.
 *
 * The preview is per LINK, not per message. The old card took the first URL in the text and
 * ignored every other one, so a message with three links previewed one of them.
 *
 * And the card is no longer part of the message. Drawn inline it was part of the document:
 * opening it made the row taller, which moved every row under it, which the list then had to
 * undo — in the right frame, in every combination of following-the-end and reading-history.
 * The floating card (see LinkCard) has nothing to undo, because nothing about the row changes.
 */
function LinkToken({ url, label }: { url: string; label: string }): React.JSX.Element {
  const previews = useSettingsStore((s) => s.settings.linkPreviews)
  const clipsOnly = useSettingsStore((s) => s.settings.linkPreviewsClipsOnly)
  // "open on hover" — the same setting that used to mean "draw the card already open", which
  // is the same wish: see the preview without asking for it twice
  const onHover = useSettingsStore((s) => s.settings.linkPreviewsExpanded)
  const eligible = previews && (!clipsOnly || !!clipSlugFromUrl(url))
  const timer = useRef<number | undefined>(undefined)

  const openAt = (el: HTMLElement, sticky: boolean): void => {
    const r = el.getBoundingClientRect()
    useUiStore.getState().setLinkCard({ url, x: r.left, y: r.bottom, sticky })
  }

  return (
    <>
      <a
        href={url}
        title={url}
        onClick={(e) => {
          e.preventDefault()
          window.sticki.openExternal(url)
        }}
        onMouseEnter={
          eligible && onHover
            ? (e) => {
                // a short delay, so dragging the pointer across a wall of links does not open
                // and discard a dozen cards on the way past
                const el = e.currentTarget
                window.clearTimeout(timer.current)
                timer.current = window.setTimeout(() => openAt(el, false), 180)
              }
            : undefined
        }
        onMouseLeave={
          eligible && onHover
            ? () => {
                window.clearTimeout(timer.current)
                // the card decides whether to go — the pointer may be on its way ONTO it
                window.dispatchEvent(new CustomEvent('sticki:linkcardmaybeclose'))
              }
            : undefined
        }
      >
        {label}
      </a>
      {eligible && !onHover && <LinkChip url={url} />}
    </>
  )
}

/** the small tag after a link that says what is behind it; clicking opens the floating card */
function LinkChip({ url }: { url: string }): React.JSX.Element | null {
  const t = useT()
  const [data, setData] = useState<LinkPreviewData | null>(null)
  useEffect(() => {
    let alive = true
    setData(null)
    fetchLinkPreview(url).then((d) => {
      if (alive && d) setData(d)
    })
    return () => {
      alive = false
    }
  }, [url])
  // the tag arriving can push the message onto a second line — the one height change left in
  // this feature, and it is announced before the frame is painted so the list absorbs it in
  // the same frame rather than one later
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent('sticki:rowresized'))
  }, [data])
  if (!data) return null
  const label = data.title ?? data.siteName ?? t('misc.linkShort')
  return (
    <span
      className="link-preview-toggle"
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        // the tag is a toggle: clicking the one that is already showing puts it away, so the
        // same gesture opens and closes and nothing has to be aimed at to dismiss a card
        const shown = useUiStore.getState().linkCard
        if (shown && shown.url === url && shown.sticky) {
          useUiStore.getState().setLinkCard(null)
          return
        }
        const r = e.currentTarget.getBoundingClientRect()
        useUiStore.getState().setLinkCard({ url, x: r.left, y: r.bottom, sticky: true })
      }}
    >
      ▸ {data.kind === 'clip' ? '🎬' : '🔗'} <span className="lpt-label">{label}</span>
    </span>
  )
}

/** shared-chat origin tag: which channel's chat this user wrote in */
function SharedSourceTag({ roomId }: { roomId: string }): React.JSX.Element {
  const t = useT()
  const [, force] = useState(0)
  useEffect(() => {
    const bump = (): void => force((v) => v + 1)
    window.addEventListener('sticki:srcchan', bump)
    return () => window.removeEventListener('sticki:srcchan', bump)
  }, [])
  const info = getSourceChannelInfo(roomId)
  // avatar-only keeps a busy shared stream readable — the picture already says whose chat it is
  const avatarOnly = useSettingsStore.getState().settings.sharedChatTagMode === 'avatar'
  return (
    <span
      className={`shared-src-tag ${avatarOnly && info?.avatar ? 'avatar-only' : ''}`}
      title={t('msg.sharedFrom', { channel: info?.name ?? '…' })}
    >
      {info?.avatar ? <img className="shared-src-av" src={info.avatar} alt="" /> : '🔀'}
      {!(avatarOnly && info?.avatar) && ` ${info?.name ?? '…'}`}
    </span>
  )
}

function getBrailleCellWidth(): number {
  if (brailleCellWidth !== null) return brailleCellWidth
  try {
    const span = document.createElement('span')
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:13px;line-height:1'
    span.textContent = '⣿'.repeat(30)
    document.body.appendChild(span)
    brailleCellWidth = (span.getBoundingClientRect().width || 330) / 30
    span.remove()
  } catch {
    brailleCellWidth = 11
  }
  return brailleCellWidth
}
let lastArtCols = 30

/**
 * Twitch replaces the newlines of pasted braille art with SPACES, while the art itself uses
 * the braille blank (U+2800) inside lines. So space-separated segments of consistent length
 * are almost certainly the original lines — rebuild them. Returns null when unsure.
 */
function recoverArtLines(text: string): string[] | null {
  const segs = text.split(' ').filter((s) => s.length > 0)
  if (segs.length < 4) return null
  const lens = segs.map((s) => [...s].length).sort((a, b) => a - b)
  const median = lens[Math.floor(lens.length / 2)]
  if (median < 8) return null
  const consistent = segs.filter((s) => Math.abs([...s].length - median) <= 2).length
  return consistent / segs.length >= 0.7 ? segs : null
}

// swipe zones (px): 40‑90 delete, then one timeout tier every SWIPE_TIER_WIDTH px, beyond — ban
const SWIPE_DELETE_START = 40
const SWIPE_TIMEOUT_START = 90
const SWIPE_TIER_WIDTH = 42
const banStartFor = (tiers: number[]): number => SWIPE_TIMEOUT_START + SWIPE_TIER_WIDTH * tiers.length

const ANNOUNCE_COLORS: Record<string, string> = {
  primary: '#9147ff',
  blue: '#1e90ff',
  green: '#2ecc71',
  orange: '#ff8c1a',
  purple: '#a970ff'
}

interface SwipeAction {
  kind: 'delete' | 'timeout' | 'ban'
  seconds?: number
  label: string
  color: string
}

function swipeActionFor(
  dx: number,
  labels: { delete: string; ban: string },
  tiers: number[],
  deleteOnly = false
): SwipeAction | null {
  if (dx < SWIPE_DELETE_START) return null
  if (deleteOnly || dx < SWIPE_TIMEOUT_START)
    return { kind: 'delete', label: labels.delete, color: 'var(--warning)' }
  if (dx < banStartFor(tiers)) {
    const tier = Math.min(tiers.length - 1, Math.floor((dx - SWIPE_TIMEOUT_START) / SWIPE_TIER_WIDTH))
    const secs = tiers[tier]
    return { kind: 'timeout', seconds: secs, label: `⏱ ${formatDuration(secs)}`, color: 'var(--accent-strong)' }
  }
  return { kind: 'ban', label: `🔨 ${labels.ban}`, color: 'var(--danger)' }
}

function MessageViewInner({
  msg,
  index,
  paneId,
  account,
  channelId,
  isMod,
  paneAccountId,
  settings,
  emoteVersion,
  onReply,
  flash
}: Props): React.JSX.Element {
  const t = useT()
  const modButtons = useSettingsStore((s) => s.modButtons)
  const highlightRules = useSettingsStore((s) => s.highlightRules)
  const channelAccent = useChatStore((s) => s.channelAccents[msg.channel])
  const [dragX, setDragX] = useState(0)
  const draggingRef = useRef(false)

  const tokens = useMemo(() => {
    if (msg.system === 'info') return []
    const cacheKey = `${msg.id} ${emoteVersion} ${settings.theme} ${settings.colorBareNicks ? 1 : 0}`
    const cached = layoutCache.get(cacheKey)
    if (cached) return cached
    const toks = tokenizeMessage(
      msg,
      lookupEmote(msg.channel),
      (login) => lookupUserColor(msg.channel, login),
      isDarkTheme(settings.theme),
      msg.bits ? lookupCheermote(msg.channel) : undefined,
      settings.colorBareNicks ? (login) => isKnownChatter(msg.channel, login) : undefined
    )
    // Twitch prefixes reply bodies with "@nick " — the nick already shows greyed on the
    // reply-ref line above, so drop the duplicate leading @mention (and its trailing space)
    const parentLogin = msg.replyParent?.login?.toLowerCase()
    const first = toks[0]
    if (parentLogin && first?.kind === 'mention') {
      if (first.name.slice(1).replace(/[^\w]+$/, '').toLowerCase() === parentLogin) {
        toks.shift()
        const next = toks[0]
        if (next?.kind === 'text') {
          if (next.text.trimStart() === '') toks.shift()
          else toks[0] = { kind: 'text', text: next.text.replace(/^\s+/, '') }
        }
      }
    }
    // an emote reload or a theme flip changes every key at once, so the old entries are dead
    // weight rather than a leak that grows — but they still have to go
    if (layoutCache.size >= LAYOUT_CACHE_MAX) layoutCache.clear()
    layoutCache.set(cacheKey, toks)
    return toks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg, emoteVersion, settings.theme, settings.colorBareNicks])

  // optional 7TV cosmetic nick color/paint: subscribe so the nick restyles when the fetch lands
  const stvWanted = settings.sevenTvNickColors || settings.showThirdPartyBadges
  const stvCosmetic = useSevenTvColors((s) =>
    stvWanted && msg.userId ? s.cosmetics[msg.userId] : undefined
  )
  useEffect(() => {
    if (stvWanted && !msg.system) ensureSevenTvCosmetic(msg.userId)
  }, [stvWanted, msg.userId, msg.system])

  // BTTV and FFZ publish one roster for everyone, so these are lookups rather than per-user
  // fetches; 7TV's badge rides along with the cosmetic request above
  const bttvBadge = useBttvBadges((s) => (msg.userId ? s.badges[msg.userId] : undefined))
  const ffzBadgeList = useFfzBadges((s) => (msg.userId ? s.badges[msg.userId] : undefined))
  useEffect(() => {
    if (!settings.showThirdPartyBadges) return
    ensureBttvBadges()
    ensureFfzBadges()
  }, [settings.showThirdPartyBadges])
  const thirdPartyBadges = useMemo(() => {
    const out: { url: string; title: string; color?: string }[] = []
    if (stvCosmetic?.badgeUrl) out.push({ url: stvCosmetic.badgeUrl, title: stvCosmetic.badgeTooltip ?? '7TV' })
    if (bttvBadge) out.push({ url: bttvBadge.url, title: bttvBadge.description })
    for (const b of ffzBadgeList ?? []) out.push({ url: b.url, title: b.title, color: b.color })
    return out
  }, [stvCosmetic?.badgeUrl, stvCosmetic?.badgeTooltip, bttvBadge, ffzBadgeList])

  // shoutout cooldown countdown (subscribing to `tick` is what re-renders it each second)
  useShoutoutCooldown((s) => s.tick)
  const soLeft = msg.raidFrom ? shoutoutStatus(channelId).left : 0

  const isMention = settings.highlightMentions && !!msg.isMention

  const customBg = useMemo(() => {
    if (isMention) return undefined
    const myAccountIds = useAccountsStore.getState().accounts.map((a) => a.id)
    const ctx = { caseSensitiveNicks: settings.caseSensitiveNicks, myAccountIds }
    const rule = highlightRules.find((r) => highlightRuleMatches(msg, r, ctx))
    if (!rule) return undefined
    // adaptColor: tint from the sender's own nick color instead of the rule's fixed color
    const base = rule.adaptColor ? stvCosmetic?.color || msg.color || fallbackColor(msg.login) : rule.color
    return hexToRgba(base, rule.opacity)
  }, [highlightRules, msg, isMention, settings.caseSensitiveNicks, stvCosmetic])

  // muted users: 'hide' is filtered out in MessageList; 'dim' renders semi-transparent here
  const muted = useMemo(
    () => settings.mutedUsers.find((u) => u.login === msg.login && !msg.system),
    [settings.mutedUsers, msg.login, msg.system]
  )

  if (msg.system === 'info') {
    // channel-point redemption: real points icon + colored nick + reward name + cost,
    // instead of an emoji and a generic "redeems" label
    if (msg.redeemed && msg.rewardTitle) {
      const rdark = isDarkTheme(settings.theme)
      // prefer the user's CURRENT chat color from the live buffer (the redeem's stored color
      // is a snapshot and is often just a fallback hash if they hadn't spoken yet)
      const nickColor = ensureReadable(
        lookupUserColor(msg.channel, msg.login) || msg.color || fallbackColor(msg.login || ''),
        rdark
      )
      return (
        <div className="msg redeem-info" style={customBg ? { background: customBg } : undefined}>
          {settings.showTimestamps && (
            <span className="ts">{formatTime(msg.timestamp, settings.timestampSeconds)}</span>
          )}
          {msg.rewardIcon ? (
            <img className="redeem-icon" src={msg.rewardIcon} alt="" loading="lazy" />
          ) : (
            <span className="redeem-icon-emoji">🔴</span>
          )}
          {msg.displayName && (
            <span className="redeem-nick" style={{ color: nickColor }}>
              {msg.displayName}
            </span>
          )}{' '}
          <span className="redeem-reward">{msg.rewardTitle}</span>
          {msg.rewardCost != null && <span className="redeem-cost"> · {msg.rewardCost.toLocaleString('uk-UA')}</span>}
          {msg.text ? <span className="redeem-input">: {msg.text}</span> : null}
        </div>
      )
    }
    return (
      <div className={`msg ${msg.redeemed ? 'redeem-info' : ''}`} style={customBg ? { background: customBg } : undefined}>
        {settings.showTimestamps && <span className="ts">{formatTime(msg.timestamp, settings.timestampSeconds)}</span>}
        <span className="sysmsg">{msg.systemText}</span>
      </div>
    )
  }

  const dark = isDarkTheme(settings.theme)
  const color = ensureReadable(
    stvCosmetic?.color || stvCosmetic?.paintColor || msg.color || fallbackColor(msg.login),
    dark
  )
  // a 7TV gradient/image paint renders as the nick's own text fill (clipped background).
  // size/repeat matter for URL paints (a bare tile covered a corner of the nick) and the
  // shadow chain is a big part of how a paint actually looks on 7TV.
  const paintStyle = settings.sevenTvNickColors ? paintStyleOf(stvCosmetic, dark) : undefined
  const classes = ['msg']
  // shared chat: visitors from the partner channel get a subtle tint + origin tag
  if (msg.sourceRoomId) classes.push('shared-msg')
  if (settings.alternatingBackground && index % 2 === 1) classes.push('alt')
  // a rule between messages instead of (or as well as) the stripes — the other way of telling
  // where one message ends, and the one that stays readable on a busy custom theme
  if (settings.messageSeparators) classes.push('ruled')
  if (isMention && settings.showMentionBg) classes.push('mention')
  if (msg.deleted) classes.push('deleted')
  if (msg.historical) classes.push('historical')
  if (flash) classes.push('flash')
  if (msg.system === 'usernotice') classes.push('usernotice')
  if (dragX > 0) classes.push('swiping')
  // bits power-ups (Twitch-style): gigantified emote + animated message effect
  if (settings.showBits && msg.gigantified) classes.push('gigantified')
  /**
   * Which of Twitch's three Message Effects this is.
   *
   * Matched by shape rather than by an exact tag value: Twitch has renamed these ids at least
   * once, and an id we do not recognise should still land on the effect it obviously means
   * rather than falling back to a generic wash. Anything genuinely unknown keeps the default.
   */
  const bitsEffect = settings.showBits && msg.messageEffect ? effectClass(msg.messageEffect) : ''
  if (bitsEffect) classes.push('msg-effect', `effect-${bitsEffect}`)

  const canAct = !!account && !!msg.userId
  // moderators/broadcasters can't be timed out or banned by another mod — only their messages can be deleted
  const targetIsProtected = msg.badges.some(
    (b) => b.setId === 'moderator' || b.setId === 'lead_moderator' || b.setId === 'broadcaster'
  )
  const visibleButtons = modButtons
    .filter((b) => b.scope === 'message')
    .filter((b) => !b.channels?.length || b.channels.includes(msg.channel))
    .filter((b) => {
      const modOnly = MOD_ONLY_TYPES.has(b.type)
      if (modOnly && !isMod) return false
      // mods/broadcasters can't be punished, but delete and shoutout still make sense on them
      if (modOnly && targetIsProtected && b.type !== 'delete' && b.type !== 'shoutout') return false
      return true
    })
  // still swipeable after a delete — you often delete first, then decide to time out too
  const swipeEnabled = isMod && canAct
  // the grip is absolutely positioned over the row's left edge — give it its own gutter so
  // dragging a selection across the first characters isn't intercepted by it
  if (swipeEnabled) classes.push('has-grip')
  const swipeTiers = settings.swipeTimeouts.length ? settings.swipeTimeouts : [60, 300, 600, 1800, 3600, 86400]
  // braille "ASCII art" is drawn for a fixed line width — never rewrap it
  const brailleArt = (msg.text.match(/[⠀-⣿]/g)?.length ?? 0) >= 24
  // best case: the original line structure can be recovered exactly (no slider needed)
  const artLines = useMemo(() => (brailleArt ? recoverArtLines(msg.text) : null), [brailleArt, msg.text])
  const [artCols, setArtCols] = useState(lastArtCols)
  const toast = useUiStore.getState().toast

  const openUserCard = (e: React.MouseEvent): void => {
    openCard({
      channel: msg.channel,
      channelId,
      userId: msg.userId,
      login: msg.login,
      displayName: msg.displayName,
      color,
      badges: msg.badges,
      accountId: paneAccountId,
      x: e.clientX,
      y: e.clientY
    })
  }

  const swipeLabels = { delete: t('swipe.delete'), ban: t('swipe.ban') }

  const executeSwipe = async (dx: number): Promise<void> => {
    const action = swipeActionFor(dx, swipeLabels, swipeTiers, targetIsProtected)
    if (!action || !account) return
    const res =
      action.kind === 'delete'
        ? await deleteChatMessage(account, channelId, msg.id)
        : await banUser(account, channelId, msg.userId, action.seconds)
    if (res.ok) toast(`${action.label} — ${msg.login}`, 'ok')
    else toast((localizeApiError((res.json as { message?: string })?.message ?? '') || t('mod.actionFail')) + t('err.account', { login: account?.login ?? '' }), 'error')
  }

  // swipe-to-moderate starts ONLY from the ⠿ grip — dragging from the message body used to
  // hijack plain text selection (left-to-right copy started a swipe)
  const startSwipe = (e: React.PointerEvent): void => {
    if (!swipeEnabled || e.button !== 0) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    draggingRef.current = true
    document.getSelection()?.removeAllRanges()
    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - start.x
      const cap = targetIsProtected ? SWIPE_TIMEOUT_START - 1 : banStartFor(swipeTiers) + 40
      setDragX(Math.max(0, Math.min(dx, cap)))
    }
    const onUp = (ev: PointerEvent): void => {
      cleanup()
      draggingRef.current = false
      executeSwipe(ev.clientX - start.x)
      setDragX(0)
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // RMB inserts the nick; Ctrl+RMB sends "@nick" to chat immediately
  // insert the nick AS DISPLAYED (case preserved); localized display names fall back to
  // the login so the mention still pings
  const mentionName = msg.displayName && msg.displayName.toLowerCase() === msg.login ? msg.displayName : msg.login
  const insertNick = tokenContextHandler(paneId, `@${mentionName} `)

  const swipeAction = dragX > 0 ? swipeActionFor(dragX, swipeLabels, swipeTiers, targetIsProtected) : null

  const jumpToParent = (): void => {
    if (!msg.replyParent?.msgId) return
    window.dispatchEvent(
      new CustomEvent<JumpEventDetail>('sticki:jump', {
        detail: { channel: msg.channel, msgId: msg.replyParent.msgId }
      })
    )
  }

  return (
    // .msg-row is the unclipped frame; .msg-outer inside it is the clipped one. The hover
    // buttons hang above the row's top edge and must not be cut off, but a swipe slides .msg
    // sideways and must be. Two boxes is the only way to have both — and it also means the
    // buttons are not inside the sliding row, so they stay put while you swipe.
    <div className="msg-row">
      <div className="msg-outer">
        {swipeAction && (
          <div className="swipe-overlay" style={{ background: swipeAction.color }}>
            {swipeAction.label}
          </div>
        )}
        <div
          className={classes.join(' ')}
          style={
            {
              opacity: muted?.mode === 'dim' ? muted.opacity : undefined,
              /**
               * A bits effect owns the background of the line it is on.
               *
               * A highlight rule writes its tint INLINE, and an inline background beats any
               * stylesheet — so a viewer who highlights, say, their own messages, or subs, lost
               * the animation they had just paid bits for: the effect was still there, painted
               * underneath a flat colour. The effect wins; it is the rarer and more deliberate
               * of the two.
               */
              background: msg.announceColor || bitsEffect ? undefined : customBg,
              // PRIMARY announcements take the broadcaster's own color for this channel
              '--announce-accent': msg.announceColor
                ? msg.announceColor === 'primary'
                  ? (channelAccent ?? ANNOUNCE_COLORS.primary)
                  : ANNOUNCE_COLORS[msg.announceColor]
                : undefined,
              transform: dragX > 0 ? `translateX(${dragX}px)` : undefined
            } as React.CSSProperties
          }
        >
          {/* the particles each effect throws; absolutely positioned, so neither adds anything
              to the row's height */}
          {bitsEffect === 'cosmic-abyss' && (
            <span className="fx-motes" aria-hidden="true">
              <i style={{ left: '8%', animationDelay: '0s' }} />
              <i style={{ left: '24%', animationDelay: '0.7s' }} />
              <i style={{ left: '41%', animationDelay: '1.4s' }} />
              <i style={{ left: '58%', animationDelay: '0.35s' }} />
              <i style={{ left: '73%', animationDelay: '2.1s' }} />
              <i style={{ left: '89%', animationDelay: '1.05s' }} />
            </span>
          )}
          {bitsEffect === 'emote-party' && (
            <span className="fx-party" aria-hidden="true">
              <i style={{ left: '6%', animationDelay: '0s' }}>🎉</i>
              <i style={{ left: '21%', animationDelay: '0.18s' }}>😹</i>
              <i style={{ left: '38%', animationDelay: '0.36s' }}>🥳</i>
              <i style={{ left: '55%', animationDelay: '0.09s' }}>✨</i>
              <i style={{ left: '71%', animationDelay: '0.27s' }}>😻</i>
              <i style={{ left: '87%', animationDelay: '0.45s' }}>🎊</i>
            </span>
          )}
          {swipeEnabled && (
            <span
              className="swipe-grip"
              title={t('swipe.hint')}
              onPointerDown={startSwipe}
            >
              ⠿
            </span>
          )}
          {/* redemptions are announced on their own line by PubSub (with the real reward name);
              here we only tag bits, which come through IRC with the amount */}
          {settings.showBits && !!msg.bits && !msg.system && (
            <span className="event-header bits">{t('msg.bits', { count: msg.bits })}</span>
          )}
          {msg.system === 'usernotice' && msg.systemText && (
            <span
              className={`usernotice-tag ${msg.giftGroupId ? 'gift-toggle' : ''}`}
              onClick={
                msg.giftGroupId
                  ? () => useUiStore.getState().toggleGiftGroup(msg.giftGroupId!)
                  : undefined
              }
            >
              {msg.announceColor ? '📢' : '★'} {msg.systemText}
              {msg.giftGroupId && (
                <span className="gift-toggle-arrow">
                  {useUiStore.getState().expandedGifts[msg.giftGroupId] ? ' ▲' : ` ▼ ${t('gift.showAll')}`}
                </span>
              )}
              {/* incoming raid + mod rights → one-click shoutout for the raider */}
              {msg.raidFrom && isMod && account && !msg.historical && (
                <button
                  className={`raid-shoutout-btn ${soLeft > 0 ? 'cooling' : ''}`}
                  disabled={soLeft > 0}
                  title={
                    soLeft > 0
                      ? t('mod.shoutoutCooldown', { time: formatCooldown(soLeft) })
                      : `${t('mod.shoutout')}: ${msg.raidFrom}`
                  }
                  onClick={async (e) => {
                    e.stopPropagation()
                    const { resolveUserId } = await import('../services/modActions')
                    const id = await resolveUserId(account, msg.raidFrom!)
                    if (!id) {
                      toast(t('mod.actionFail'), 'error')
                      return
                    }
                    const { sendShoutout } = await import('../lib/helix')
                    const res = await sendShoutout(account, channelId, id)
                    if (res.ok) {
                      toast(`📣 ${msg.raidFrom}`, 'ok')
                      const { chatService } = await import('../services/chatService')
                      chatService.localInfo(msg.channel, t('mod.shoutoutGiven', { user: msg.raidFrom! }))
                    } else {
                      toast((localizeApiError((res.json as { message?: string })?.message ?? '') || t('mod.actionFail')) + t('err.account', { login: account?.login ?? '' }), 'error')
                    }
                  }}
                >
                  📣 {soLeft > 0 ? formatCooldown(soLeft) : t('mod.shoutout')}
                </button>
              )}
            </span>
          )}
          {msg.replyParent && (
            <span
              className={`reply-ref ${msg.replyParent.msgId ? 'clickable' : ''}`}
              title={`${msg.replyParent.displayName}: ${msg.replyParent.text}\n${msg.replyParent.msgId ? t('reply.jump') : ''}`}
              onClick={jumpToParent}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const rp = msg.replyParent!
                const rpName = rp.displayName && rp.displayName.toLowerCase() === rp.login ? rp.displayName : rp.login
                window.dispatchEvent(
                  new CustomEvent<InsertEventDetail>('sticki:insert', {
                    detail: { paneId, text: `@${rpName} ` }
                  })
                )
              }}
            >
              ↩ @{msg.replyParent.displayName}: {msg.replyParent.text}
            </span>
          )}
          {settings.showTimestamps && (
            <>
              <span className="ts">{formatTime(msg.timestamp, settings.timestampSeconds)}</span>{' '}
            </>
          )}
          {msg.badges.map((b) => {
            const url = lookupBadgeUrl(msg.channel, b.setId, b.version)
            if (!url) return null
            const title = lookupBadgeTitle(msg.channel, b.setId, b.version) ?? b.setId
            return (
              <img
                key={`${b.setId}/${b.version}`}
                className="badge"
                src={url}
                alt=""
                title={title}
                draggable={false}
                onMouseEnter={(e) =>
                  useUiStore.getState().setEmotePreview({
                    url: lookupBadge4x(msg.channel, b.setId, b.version) ?? url,
                    code: title,
                    x: e.clientX,
                    y: e.clientY
                  })
                }
                onMouseLeave={() => useUiStore.getState().setEmotePreview(null)}
              />
            )
          })}
          {/* third-party badges sit after the Twitch ones, same as on 7TV/BTTV/FFZ themselves,
              and hover-preview exactly like a Twitch badge does */}
          {settings.showThirdPartyBadges &&
            thirdPartyBadges.map((b, i) => (
              <img
                key={`${b.title}-${i}`}
                className="badge badge-3p"
                style={b.color ? { background: b.color } : undefined}
                src={b.url}
                alt=""
                draggable={false}
                title={b.title}
                onMouseEnter={(e) =>
                  useUiStore.getState().setEmotePreview({
                    url: b.url,
                    code: b.title,
                    x: e.clientX,
                    y: e.clientY
                  })
                }
                onMouseLeave={() => useUiStore.getState().setEmotePreview(null)}
              />
            ))}
          <span
            // remount when the paint changes: Chromium keeps the OLD text clip on a live
            // element, which paints the gradient as a solid bar over the nick
            key={stvCosmetic?.paint ?? 'plain'}
            className="nick"
            style={paintStyle ?? { color }}
            title={stvCosmetic?.paintName}
            onClick={openUserCard}
            onContextMenu={insertNick}
          >
            {msg.displayName}
            {msg.displayName.toLowerCase() !== msg.login ? ` (${msg.login})` : ''}
          </span>
          {/* raider tag: which streamer's raid they arrived with — lives exactly as long as
              the raider highlight window */}
          {msg.raider && msg.raiderFrom && (
            <span className="raider-tag" title={`${t('raid.raidWord')}: ${msg.raiderFrom}`}>
              🚨 {msg.raiderFrom}
            </span>
          )}
          {msg.isAction ? ' ' : ': '}
          {/* after the colon, not before it: the tag says where the message came from, so it
              belongs with the message rather than glued onto the end of the nick */}
          {msg.sourceRoomId && <SharedSourceTag roomId={msg.sourceRoomId} />}
          {brailleArt && !artLines && (
            <span className="art-width-ctl" title={`${artCols}`}>
              <input
                type="range"
                min={16}
                max={60}
                value={artCols}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  setArtCols(v)
                  lastArtCols = v
                }}
              />
            </span>
          )}
          {artLines ? (
            // original line structure recovered — render exactly as drawn
            <span className="msg-text ascii-art" style={{ whiteSpace: 'pre' }}>
              {artLines.join('\n')}
            </span>
          ) : (
            <span
              className={`msg-text ${brailleArt ? 'ascii-art' : ''}`}
              style={{
                ...(msg.isAction ? { color } : undefined),
                ...(brailleArt ? { width: Math.ceil(getBrailleCellWidth() * artCols) } : undefined)
              }}
            >
              {tokens.map((tk, i) => (
                <TokenView key={i} token={tk} paneId={paneId} channel={msg.channel} hiRes={!!(settings.showBits && msg.gigantified)} />
              ))}
            </span>
          )}
        </div>
      </div>
      {canAct && (
        <span className="hover-actions">
          <button
            title={t('reply.action')}
            onClick={() =>
              onReply({ msgId: msg.id, login: msg.login, displayName: msg.displayName, text: msg.text })
            }
          >
            ↩
          </button>
          {visibleButtons.map((btn) => (
            <button
              key={btn.id}
              title={btn.label}
              onClick={() =>
                runModButton(btn, {
                  account: account!,
                  channel: msg.channel,
                  channelId,
                  paneId,
                  targetUserId: msg.userId,
                  targetLogin: msg.login,
                  targetMsgId: msg.id,
                  targetText: msg.text
                })
              }
            >
              <BtnIcon icon={btn.icon} />
              {!btn.icon && btn.label}
            </button>
          ))}
        </span>
      )}
    </div>
  )
}

const MessageView = memo(MessageViewInner)
export default MessageView
