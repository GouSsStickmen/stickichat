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
import { SevenTvMark, ShieldIcon } from './Icons'
import { runModButton } from '../services/modActions'
import { banUser, deleteChatMessage, manageAutoModMessage, describeHelixError } from '../lib/helix'
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
import { confirmDestructive } from '../lib/confirmMod'
import { host, isMobile } from '../lib/platform'

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
/** put text into a pane's input box — the thing right-click does, without needing a right button */
function insertIntoInput(paneId: string, text: string): void {
  window.dispatchEvent(
    new CustomEvent<InsertEventDetail>('sticki:insert', { detail: { paneId, text } })
  )
}

/**
 * Touch handlers for one emote: tap looks, hold takes, long hold leaves.
 *
 * On a phone a tap was opening the emote's page on 7TV — the rarest of the three things anyone wants
 * from an emote, and the only one that leaves the app. So the useful one is the short hold: the code
 * goes into the input, with a buzz to say it happened. The page is still there behind a hold nobody
 * performs by accident.
 */
function emoteTouchProps(
  paneId: string,
  codes: string,
  openPage: (() => void) | null,
  preview: () => void
): {
  onTouchStart: (e: React.TouchEvent) => void
  onTouchEnd: () => void
  onTouchMove: () => void
} {
  let insertAt = 0
  let pageAt = 0
  let done = false

  const clear = (): void => {
    window.clearTimeout(insertAt)
    window.clearTimeout(pageAt)
  }

  return {
    onTouchStart: () => {
      done = false
      clear()
      insertAt = window.setTimeout(() => {
        done = true
        insertIntoInput(paneId, `${codes} `)
        navigator.vibrate?.(12)
      }, 450)
      if (openPage) {
        pageAt = window.setTimeout(() => {
          done = true
          navigator.vibrate?.(24)
          openPage()
        }, 1300)
      }
    },
    // a finger that moved is scrolling the chat, not choosing an emote
    onTouchMove: () => {
      done = true
      clear()
    },
    onTouchEnd: () => {
      clear()
      // released before the hold matured: show what it is, which is what a tap should mean
      if (!done) preview()
    }
  }
}

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
      const previewHere = (): void =>
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
          x: 0,
          y: 0
        })
      const touch = isMobile()
        ? emoteTouchProps(
            paneId,
            codes,
            page || ownerLogin
              ? () =>
                  void host().openUrl(page || `https://twitch.tv/${ownerLogin}`)
              : null,
            previewHere
          )
        : null

      return (
        <span
          className={`emote-wrap ${page || ownerLogin ? 'clickable' : ''}`}
          title={title}
          // a tap must not open the page; on touch the handlers below decide what the press meant
          onClick={touch ? undefined : openEmote}
          onContextMenu={(ev) => {
            /*
             * Alt files it into a favourite category; without Alt this is what it always was —
             * right-click puts the emote's code into the input.
             */
            if (ev.altKey) {
              ev.preventDefault()
              /*
               * The whole stack, and its real key.
               *
               * A layered emote is one favourite — Alt+click has always starred it that way — and
               * its identity includes every layer. Building the key by hand from the base code
               * alone meant a combination was filed under a name nothing else uses, so the menu
               * could never tell that it was already on a shelf, and adding it created a second,
               * different entry.
               */
              const entry: FavoriteEmote = {
                code: token.emote.code,
                url: token.emote.url,
                provider: token.emote.provider,
                zeroWidth: token.emote.zeroWidth,
                overlays: token.overlays.length
                  ? token.overlays.map((o) => ({ code: o.code, url: o.url, provider: o.provider }))
                  : undefined
              }
              useUiStore.getState().setEmoteFolderMenu({
                key: favKey(entry),
                emote: entry,
                x: ev.clientX,
                y: ev.clientY
              })
              return
            }
            tokenContextHandler(paneId, `${codes} `)(ev)
          }}
          {...(touch ?? {})}
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
    case 'gif':
      /*
       * NOT lazy, like the emotes above: a picture that arrives after the row has been measured
       * makes the virtualised list jolt. The title keeps the placeholder Twitch sent, so the GIF is
       * still identifiable when it fails to load or when someone copies the line.
       */
      return (
        <span className="chat-gif" title={token.label}>
          <img
            src={token.url}
            alt={token.label}
            onLoad={() =>
              window.dispatchEvent(
                new CustomEvent('sticki:rowresized', { detail: { deliberate: false } })
              )
            }
          />
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
  /*
   * "Open on hover" — the same setting that used to mean "draw the card already open", which is the
   * same wish: see the preview without asking for it twice.
   *
   * Never on touch, and that is why link previews did nothing there at all. It defaults to on, and
   * with it on the tag after the link is not rendered — the card is supposed to come up under the
   * pointer instead. A phone has no pointer, so neither ever appeared. On touch there is one
   * question, "previews or not", and the tag is how you ask for one.
   */
  const onHover = useSettingsStore((s) => s.settings.linkPreviewsExpanded) && !isMobile()
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
  /**
   * Announce a height change only when the tag actually appears or goes away.
   *
   * It used to fire on every change of `data`, and the first of those is the mount, where `data`
   * is still null and this component draws nothing at all. That lands in the SAME commit as the
   * message itself — before its first paint — and the list reads the signal as "a row changed on
   * purpose", which is its cue to pin instantly instead of gliding. So every message containing a
   * link snapped into place while every other message slid in.
   *
   * When the tag really does arrive, a frame or two later, this fires for real and the list
   * absorbs it in the same frame rather than one after — which is the whole reason the signal
   * exists. By then the message has finished its glide and the correction is invisible.
   */
  const tagShown = useRef(false)
  useLayoutEffect(() => {
    const shown = !!data
    if (shown === tagShown.current) return
    tagShown.current = shown
    // Content that arrived by itself, NOT a gesture. The distinction decides whether the list
    // jumps to the bottom or glides there: a card the reader opened is the page changing under
    // their hand and must land at once, but a preview tag turning up on a message that is still
    // sliding in is just more of that message. Measured: with a cached preview the tag lands
    // inside the same frame as the message, and the instant pin turned a 4px-per-frame glide
    // into one 102px jump.
    window.dispatchEvent(new CustomEvent('sticki:rowresized', { detail: { deliberate: false } }))
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
  /*
   * The swipe writes to the DOM, not to state.
   *
   * `dragX` used to be React state set on every pointermove, which re-rendered this component — the
   * one that tokenizes the message, lays out its emotes and runs its effects — once per finger
   * position. On a phone that is what "not smooth" was. The offset now goes straight onto the
   * element's transform, and React only hears about the tier label, which changes a handful of times
   * in a whole gesture.
   */
  const [swipeAction, setSwipeAction] = useState<SwipeAction | null>(null)
  /** the grip was tapped in 'tap' mode: the ladder of actions, listed rather than dragged */
  const [tierSheet, setTierSheet] = useState(false)
  useEffect(() => {
    if (!tierSheet) return
    // Escape is also what Android's back button becomes — see the handler in MobileApp
    const close = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setTierSheet(false)
    }
    const away = (e: Event): void => {
      if (!(e.target as HTMLElement | null)?.closest?.('.msg-sheet, .swipe-grip')) setTierSheet(false)
    }
    window.addEventListener('keydown', close)
    document.addEventListener('touchstart', away, { passive: true })
    document.addEventListener('mousedown', away)
    return () => {
      window.removeEventListener('keydown', close)
      document.removeEventListener('touchstart', away)
      document.removeEventListener('mousedown', away)
    }
  }, [tierSheet])
  const msgElRef = useRef<HTMLDivElement | null>(null)
  const dragXRef = useRef(0)
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

  /*
   * The same, for whoever received a gifted sub.
   *
   * "X подарував підписку для Y" said Y in plain grey while Y's own messages carry their colour and
   * their paint. The name is the point of the line, so it is drawn the way that person is drawn
   * everywhere else. The colour comes from the chatter index, never from a walk of the buffer.
   */
  const giftToCos = useSevenTvColors((s) =>
    stvWanted && msg.giftToId ? s.cosmetics[msg.giftToId] : undefined
  )
  useEffect(() => {
    if (stvWanted && msg.giftToId) ensureSevenTvCosmetic(msg.giftToId)
  }, [stvWanted, msg.giftToId])

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

  /*
   * Redemptions are excluded here and drawn further down, with the rest of the message machinery.
   * They need the nick handlers and the mod buttons, and those are declared below this point — a
   * redemption is a message someone typed into, so a moderator has to be able to answer it and
   * delete it like any other.
   */
  if (msg.system === 'info' && !(msg.redeemed && msg.rewardTitle)) {
    /**
     * A 7TV set change, drawn as a card with the emotes in it.
     *
     * It used to be one grey sentence naming codes — and a code you have never seen tells you
     * nothing at all, which made the announcement useless exactly when it was most interesting.
     * Showing the picture is the whole point, so the emote comes with the line rather than being
     * looked up later: by the time anyone scrolls back, a removed emote is no longer in the set.
     */
    if (msg.emoteEvent) {
      const ev = msg.emoteEvent
      return (
        <div className={`msg emote-event ${ev.kind}`} style={customBg ? { background: customBg } : undefined}>
          <div className="ee-head">
            <SevenTvMark />
            <span className="ee-title">{t(ev.kind === 'added' ? 'info.emoteCardAdded' : 'info.emoteCardRemoved')}</span>
            <span className="ee-spacer" />
            {ev.actor && <span className="ee-actor">{ev.actor}</span>}
            {settings.showTimestamps && (
              <span className="ts">{formatTime(msg.timestamp, settings.timestampSeconds)}</span>
            )}
          </div>
          <div className="ee-body">
            {ev.emotes.map((e) => (
              <div className="ee-row" key={e.code}>
                {e.url ? (
                  <img
                    className="ee-emote"
                    src={e.url}
                    alt={e.code}
                    loading="lazy"
                    onMouseEnter={(me) =>
                      useUiStore.getState().setEmotePreview({
                        url: e.url as string,
                        code: e.code,
                        x: me.clientX,
                        y: me.clientY
                      })
                    }
                    onMouseLeave={() => useUiStore.getState().setEmotePreview(null)}
                  />
                ) : (
                  <span className="ee-emote ee-emote-missing" />
                )}
                <span className="ee-text">
                  <b>{e.code}</b> {t(ev.kind === 'added' ? 'info.emoteCardInSet' : 'info.emoteCardOutSet')}
                </span>
              </div>
            ))}
          </div>
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
  /**
   * The same paint for a /me line, minus the halo.
   *
   * The nick's legibility halo is drawn with a filter, and a filter on the message text would
   * take every emote in it with it — a drop-shadow around each picture, which is not what the
   * paint says. Text on the message line is also bigger and never sits on a badge, so it does
   * not need the halo the nick does.
   */
  const actionPaint = paintStyle ? { ...paintStyle, filter: undefined } : undefined
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
  if (swipeAction) classes.push('swiping')
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
  /*
   * Whether this row's action sheet is the one open. Selecting the comparison, not the id, means a
   * row only re-renders when its own answer flips — not every time some other message is held.
   */
  const held = useUiStore((s) => s.heldMsgId === msg.id)
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
  // ...and only at all if the gesture is wanted: switched off, there is no grip and no gutter for it
  const swipeEnabled = isMod && canAct && settings.swipeModEnabled !== false
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

  /** perform one moderation action, with the confirmation the touch build insists on */
  const runModAction = async (action: SwipeAction | null): Promise<void> => {
    if (!action || !account) return
    // every one of the three asks first on touch — a deleted message is not recoverable either
    const ok = await confirmDestructive(
      action.kind,
      msg.login,
      action.seconds ? formatDuration(action.seconds) : undefined
    )
    if (!ok) return
    const res =
      action.kind === 'delete'
        ? await deleteChatMessage(account, channelId, msg.id)
        : await banUser(account, channelId, msg.userId, action.seconds)
    if (res.ok) toast(`${action.label}: ${msg.login}`, 'ok')
    else toast((localizeApiError((res.json as { message?: string })?.message ?? '') || t('mod.actionFail')) + t('err.account', { login: account?.login ?? '' }), 'error')
  }

  const executeSwipe = (dx: number): Promise<void> =>
    runModAction(swipeActionFor(dx, swipeLabels, swipeTiers, targetIsProtected))

  /*
   * The tap mode's list: the same ladder the drag walks through, written out. Built from the same
   * tiers setting, so the two modes can never disagree about what is on offer.
   */
  const tierActions = (): SwipeAction[] => {
    const list: SwipeAction[] = [
      { kind: 'delete', label: swipeLabels.delete, color: 'var(--warning)' }
    ]
    if (!targetIsProtected) {
      for (const secs of swipeTiers) {
        list.push({ kind: 'timeout', seconds: secs, label: `⏱ ${formatDuration(secs)}`, color: 'var(--accent-strong)' })
      }
      list.push({ kind: 'ban', label: `🔨 ${swipeLabels.ban}`, color: 'var(--danger)' })
    }
    return list
  }

  // swipe-to-moderate starts ONLY from the ⠿ grip — dragging from the message body used to
  // hijack plain text selection (left-to-right copy started a swipe)
  const startSwipe = (e: React.PointerEvent): void => {
    if (!swipeEnabled || e.button !== 0) return
    /*
     * Tap mode is a hold, not a tap.
     *
     * Opening the list on the press put it under the finger that was still down, and the release
     * landed on whatever ended up first — an action chosen by accident, which is the one thing this
     * mode exists to prevent. It opens once the press has been held, and the release that follows is
     * on nothing.
     */
    if (settings.swipeModMode === 'tap') {
      e.preventDefault()
      const timer = window.setTimeout(() => {
        setTierSheet(true)
        navigator.vibrate?.(12)
      }, 400)
      const cancel = (): void => {
        window.clearTimeout(timer)
        window.removeEventListener('pointerup', cancel)
        window.removeEventListener('pointercancel', cancel)
        window.removeEventListener('pointermove', onMoveAway)
      }
      const onMoveAway = (ev: PointerEvent): void => {
        if (Math.abs(ev.clientY - e.clientY) > 8 || Math.abs(ev.clientX - e.clientX) > 8) cancel()
      }
      window.addEventListener('pointerup', cancel)
      window.addEventListener('pointercancel', cancel)
      window.addEventListener('pointermove', onMoveAway)
      return
    }
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    draggingRef.current = true
    document.getSelection()?.removeAllRanges()

    const el = msgElRef.current
    // no transition while a finger is on it: the row has to sit exactly where the finger is
    if (el) el.style.transition = 'none'
    let shownLabel: string | null = null
    /** set once the drag has been abandoned — the row goes home and nothing happens on release */
    let abandoned = false

    const paint = (dx: number): void => {
      dragXRef.current = dx
      if (el) el.style.transform = dx > 0 ? `translateX(${dx}px)` : ''
      const action = dx > 0 ? swipeActionFor(dx, swipeLabels, swipeTiers, targetIsProtected) : null
      // React is told only when the words change, not when the finger moves
      if ((action?.label ?? null) !== shownLabel) {
        shownLabel = action?.label ?? null
        setSwipeAction(action)
      }
    }

    const onMove = (ev: PointerEvent): void => {
      if (abandoned) return
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      /*
       * Sliding a finger down means "I am scrolling, or I changed my mind" — and until now there was
       * no way to say either: the row followed sideways whatever the hand did, and letting go fired
       * whatever tier it happened to be sitting in. Leaving the lane calls the whole thing off.
       */
      if (Math.abs(dy) > 44) {
        abandoned = true
        paint(0)
        return
      }
      const cap = targetIsProtected ? SWIPE_TIMEOUT_START - 1 : banStartFor(swipeTiers) + 40
      paint(Math.max(0, Math.min(dx, cap)))
    }

    const finish = (run: boolean): void => {
      cleanup()
      draggingRef.current = false
      const dx = dragXRef.current
      // slide home under its own steam; the drag itself had the transition off
      if (el) {
        el.style.transition = ''
        el.style.transform = ''
      }
      dragXRef.current = 0
      shownLabel = null
      setSwipeAction(null)
      if (run && !abandoned) void executeSwipe(dx)
    }

    const onUp = (): void => finish(true)
    // the browser taking the gesture for a scroll is not a decision to moderate anyone
    const onCancel = (): void => finish(false)

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  // RMB inserts the nick; Ctrl+RMB sends "@nick" to chat immediately
  // insert the nick AS DISPLAYED (case preserved); localized display names fall back to
  // the login so the mention still pings
  const mentionName = msg.displayName && msg.displayName.toLowerCase() === msg.login ? msg.displayName : msg.login
  const insertNick = tokenContextHandler(paneId, `@${mentionName} `)

  const jumpToParent = (): void => {
    if (!msg.replyParent?.msgId) return
    window.dispatchEvent(
      new CustomEvent<JumpEventDetail>('sticki:jump', {
        detail: { channel: msg.channel, msgId: msg.replyParent.msgId }
      })
    )
  }

  /*
   * A message AutoMod is holding.
   *
   * It is not in chat and never was, so nothing else in the buffer refers to it and there is
   * nothing to strike through or delete: the row IS the decision. Allow and deny go straight to
   * Twitch, and the row keeps its place afterwards saying what was chosen, because a moderator
   * scrolling back wants to see that it was handled rather than find a gap.
   */
  if (msg.automod) {
    const held = msg.automod
    const decide = async (action: 'ALLOW' | 'DENY'): Promise<void> => {
      const acc = useAccountsStore.getState().accounts.find((a) => a.id === held.accountId)
      if (!acc) return
      const res = await manageAutoModMessage(acc, held.msgId, action)
      if (!res.ok) {
        useUiStore.getState().toast(describeHelixError(res), 'error')
        return
      }
      // the update event confirms it too, but not always instantly, and the click must feel done
      useChatStore
        .getState()
        .patchAutoMod(msg.channel, msg.id, action === 'ALLOW' ? 'allowed' : 'denied')
    }
    return (
      <div className={`msg automod-row ${held.resolved ? 'settled' : ''}`}>
        <div className="automod-head">
          <ShieldIcon size={13} /> {t('automod.held', { reason: held.reason })}
        </div>
        <div className="automod-body">
          <span className="nick" style={{ color: msg.color }}>
            {msg.displayName}
          </span>
          : {msg.text}
        </div>
        {held.resolved ? (
          <div className="automod-done">
            {held.resolved === 'allowed'
              ? t('automod.allowed')
              : held.resolved === 'denied'
                ? t('automod.denied')
                : t('automod.expired')}
          </div>
        ) : (
          <div className="automod-actions">
            <button className="primary" onClick={() => void decide('ALLOW')}>
              {t('automod.allow')}
            </button>
            <button className="danger" onClick={() => void decide('DENY')}>
              {t('automod.deny')}
            </button>
          </div>
        )}
      </div>
    )
  }

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
    /*
     * A redemption is a message like any other, and it was drawn as if it were not.
     *
     * This branch returned its own bare line, which skipped the row wrapper — so the nick was
     * inert text and there was nowhere for the mod buttons to live. A redemption someone typed
     * something rude into could be seen and not deleted, which is the one thing a moderator
     * needs from it. Same wrapper as every other message now: the nick answers a click and a
     * right-click exactly as it does elsewhere, and the actions are the same actions.
     */
    return (
      <div className="msg-row">
        <div className="msg-outer">
          {/* the same slide-to-moderate the ordinary rows have — a redemption is moderated the same way */}
          {swipeAction && (
            <div className="swipe-overlay" style={{ background: swipeAction.color }}>
              {swipeAction.label}
            </div>
          )}
          <div
            ref={msgElRef}
            /*
             * `deleted` and `historical` belong here as much as on any other line: a removed
             * redemption is struck through for the moderator who removed it, the same way a removed
             * message is, rather than quietly vanishing or coming back looking untouched.
             */
            className={`msg redeem-info ${swipeEnabled ? 'has-grip' : ''} ${
              msg.deleted ? 'deleted' : ''
            } ${msg.historical ? 'historical' : ''}`}
            style={customBg ? { background: customBg } : undefined}
          >
            {swipeEnabled && (
              <span className="swipe-grip" title={t('swipe.hint')} onPointerDown={startSwipe}>
                ⠿
              </span>
            )}
            {settings.showTimestamps && (
              <span className="ts">{formatTime(msg.timestamp, settings.timestampSeconds)}</span>
            )}
            {msg.rewardIcon ? (
              <img className="redeem-icon" src={msg.rewardIcon} alt="" loading="lazy" />
            ) : (
              <span className="redeem-icon-emoji">🔴</span>
            )}
            {msg.displayName && (
              <span
                className="redeem-nick nick"
                style={{ color: nickColor }}
                onClick={openUserCard}
                onContextMenu={insertNick}
              >
                {msg.displayName}
              </span>
            )}{' '}
            <span className="redeem-reward">{msg.rewardTitle}</span>
            {msg.rewardCost != null && <span className="redeem-cost"> · {msg.rewardCost.toLocaleString('uk-UA')}</span>}
            {msg.text ? <span className="redeem-input">: {msg.text}</span> : null}
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
          ref={msgElRef}
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
                : undefined
              // the swipe offset is written straight to this element during the drag — see startSwipe
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
              {msg.announceColor ? '📢' : '★'}{' '}
              {(() => {
                const who = msg.giftToName
                const at = who && msg.systemText ? msg.systemText.indexOf(who) : -1
                if (!who || at < 0) return msg.systemText
                const paint = settings.sevenTvNickColors ? paintStyleOf(giftToCos, dark) : undefined
                const colour =
                  giftToCos?.color ??
                  (msg.giftToLogin ? lookupUserColor(msg.channel, msg.giftToLogin) : undefined)
                return (
                  <>
                    {msg.systemText!.slice(0, at)}
                    <span
                      className="gift-recipient"
                      style={paint ?? (colour ? { color: ensureReadable(colour, dark) } : undefined)}
                    >
                      {who}
                    </span>
                    {msg.systemText!.slice(at + who.length)}
                  </>
                )
              })()}
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
                ...(msg.isAction && !actionPaint ? { color } : undefined),
                ...(brailleArt ? { width: Math.ceil(getBrailleCellWidth() * artCols) } : undefined)
              }}
            >
              {msg.isAction && actionPaint ? (
                /**
                 * A /me line is the nick's own colour, so it is the nick's own paint too.
                 *
                 * Twitch colours the whole action in the writer's colour, and for somebody with a
                 * 7TV paint that colour is a flat approximation of a gradient everyone can see on
                 * their nick two words earlier.
                 *
                 * The paint lives on a span of its own, keyed by the paint, for the same reason
                 * the nick is: Chromium keeps the OLD text clip on a live element and paints the
                 * gradient as a solid bar over it, and a cosmetic that arrives after the first
                 * render is exactly that transition. The key belongs on this inner span rather
                 * than on the message body, so the body stays the same unkeyed child of the same
                 * parent it has always been.
                 */
                <span key={actionPaint.background as string} style={actionPaint}>
                  {tokens.map((tk, i) => (
                    <TokenView key={i} token={tk} paneId={paneId} channel={msg.channel} hiRes={!!(settings.showBits && msg.gigantified)} />
                  ))}
                </span>
              ) : (
                tokens.map((tk, i) => (
                  <TokenView key={i} token={tk} paneId={paneId} channel={msg.channel} hiRes={!!(settings.showBits && msg.gigantified)} />
                ))
              )}
            </span>
          )}
        </div>
      </div>
      {/*
        Touch: one sheet instead of the hover row.

        The hover buttons were 36px pills over the message they act on, and a long press brought them
        up together with Android's own copy menu — two menus, one gesture, neither comfortable. This
        is the same buttons, from the same `visibleButtons` and the same action context, as a list
        with names on it; and because it is drawn by the row that owns the message, none of that had
        to be rebuilt anywhere else. `position: fixed` in the stylesheet keeps it out of the row's
        measured height.
      */}
      {tierSheet && (
        <div className="msg-sheet">
          <div className="msg-sheet-who">{msg.displayName || msg.login}</div>
          {tierActions().map((a) => (
            <button
              key={`${a.kind}${a.seconds ?? ''}`}
              onClick={() => {
                setTierSheet(false)
                void runModAction(a)
              }}
            >
              {a.kind === 'delete' ? `🗑 ${a.label}` : a.label}
            </button>
          ))}
        </div>
      )}
      {held && (
        <div className="msg-sheet">
          <div className="msg-sheet-who">{msg.displayName || msg.login}</div>
          <button
            onClick={() =>
              onReply({ msgId: msg.id, login: msg.login, displayName: msg.displayName, text: msg.text })
            }
          >
            ↩ {t('reply.action')}
          </button>
          <button onClick={() => void host().copyText(msg.text)}>
            📋 {t('btn.type.copy')}
          </button>
          <button onClick={() => void host().copyText(msg.login)}>
            @ {t('user.copyName')}
          </button>
          {canAct &&
            visibleButtons.map((btn) => (
              <button
                key={btn.id}
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
                <BtnIcon icon={btn.icon} /> {btn.label}
              </button>
            ))}
        </div>
      )}
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
