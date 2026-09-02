import { ChatMessage, OverlayLineData } from '../types'
import { tokenizeMessage, ensureReadable, fallbackColor } from './tokenize'
import { lookupBadgeUrl, lookupCheermote, lookupEmote } from '../store/emotes'
import { useSettingsStore } from '../store/settings'
import { translate } from '../i18n'
import { ensureSevenTvCosmetic } from './seventvCosmetics'
import { ensureAvatar } from './twitchAvatars'
import { displayEmoji } from './emojiData'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * How many subscriptions one line is worth to a goal.
 *
 * The mass-gift header ("X дарує 20 підписок") is an announcement: the twenty gifts arrive as
 * their own lines right behind it, so counting the header as well would double every batch.
 */
function subsWorth(msg: ChatMessage): number | undefined {
  if (!msg.subEvent) return undefined
  return msg.giftGroupId ? 0 : 1
}

/**
 * message body → safe HTML (emotes/cheers as <img class="emote">, everything else escaped)
 *
 * The emote urls come back alongside it: the celebration overlay wants the pictures on their own,
 * and they are already in hand here. Pulling them out of the finished HTML afterwards would mean
 * parsing our own markup to recover what this loop just had.
 */
function bodyHtml(msg: ChatMessage): { html: string; emotes: string[] } {
  let out = ''
  const emotes: string[] = []
  const tokens = tokenizeMessage(
    msg,
    lookupEmote(msg.channel),
    undefined,
    true,
    msg.bits ? lookupCheermote(msg.channel) : undefined
  )
  for (const tk of tokens) {
    switch (tk.kind) {
      case 'text':
      case 'command':
        out += esc(tk.text)
        break
      case 'emote':
        // zero-width emotes are LAYERS on the base one — the overlay used to render only the
        // base, so a combo built in chat lost its decoration on stream
        emotes.push(tk.emote.url)
        if (tk.overlays.length) {
          out +=
            `<span class="emote-stack">` +
            `<img class="emote" src="${esc(tk.emote.url)}" alt="${esc(tk.emote.code)}">` +
            tk.overlays
              .map((o) => `<img class="emote emote-ov" src="${esc(o.url)}" alt="">`)
              .join('') +
            `</span>`
        } else {
          out += `<img class="emote" src="${esc(tk.emote.url)}" alt="${esc(tk.emote.code)}">`
        }
        break
      case 'emoji': {
        // same reasoning as chat: Twemoji image = consistent one-cell rendering in OBS
        const shown = displayEmoji(tk.char)
        const codes = [...shown].map((c) => c.codePointAt(0)!.toString(16))
        const code = codes.join('-')
        const noto = codes.filter((c) => c !== 'fe0f').join('_')
        // onerror hop: Apple set → Noto (Unicode 16 coverage) → plain text glyph
        out += `<img class="emoji-img" src="https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/${code}.png" alt="${esc(shown)}" onerror="if(!this.dataset.s){this.dataset.s='1';this.src='https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/png/72/emoji_u${noto}.png'}else{this.outerHTML=this.alt}">`
        break
      }
      case 'link':
        out +=
          useSettingsStore.getState().settings.linkDisplay !== 'full'
            ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:3px"><path d="M3.9 12a3.6 3.6 0 0 1 3.6-3.6h3.2V6.5H7.5a5.5 5.5 0 0 0 0 11h3.2v-1.9H7.5A3.6 3.6 0 0 1 3.9 12zm5.3 1h5.6v-2H9.2v2zm4.3-6.5h3.2a5.5 5.5 0 0 1 0 11h-3.2v-1.9h3.2a3.6 3.6 0 0 0 0-7.2h-3.2V6.5z"/></svg>' +
              esc(translate(useSettingsStore.getState().settings.language, 'misc.linkShort'))
            : esc(tk.label)
        break
      case 'gif': {
        /*
         * The overlay simply had no case for a GIF, so a message that was nothing but one arrived
         * on stream as an empty line. Capped in height from settings, because a GIPHY original can
         * be five hundred pixels tall and would push everything else off the overlay.
         */
        out += `<img class="chat-gif" src="${esc(tk.url)}" alt="${esc(tk.label)}">`
        break
      }
      case 'mention':
        out += `<b>${esc(tk.name)}</b>`
        break
      case 'cheer':
        if (tk.url) emotes.push(tk.url)
        out += tk.url ? `<img class="emote" src="${esc(tk.url)}">` : ''
        out += `<b style="color:${esc(tk.color)}">${tk.bits}</b>`
        break
    }
  }
  return { html: out, emotes }
}

/**
 * Builds the structured overlay line for a chat message, or null when no overlay should
 * ever see it (deleted/historical/globally muted). Per-overlay filtering (commands, redeems,
 * bits, subs, mod actions, per-overlay hidden users) happens on the overlay page itself via
 * the flags carried on the line — each OBS source applies its own config.
 */
export function buildOverlayLine(msg: ChatMessage): OverlayLineData | null {
  const s = useSettingsStore.getState().settings
  if (msg.deleted || msg.historical || msg.groupedUnder) return null
  // local client feedback ("Unrecognized command", mute notices…) — viewers must never
  // see these on the stream overlay
  if (msg.system === 'notice' || msg.clientNotice) return null
  if (s.mutedUsers.some((u) => u.login === msg.login && u.mode === 'hide')) return null
  if (s.overlayHiddenUsers.includes(msg.login)) return null

  // pure system lines (raids, clears, info…) — no nick/body structure
  if (msg.system === 'info') {
    if (!msg.systemText) return null
    return {
      id: msg.id,
      user: msg.userId,
      login: msg.login,
      badges: [],
      body: '',
      sys: esc(msg.systemText),
      kind: 'info',
      ts: msg.timestamp,
      redeem: !!msg.redeemed,
      mod: !!msg.modAction,
      /**
       * A follow line carries who it was, unlike every other system line.
       *
       * The alert overlay needs the name and the picture, and this is the only place they exist —
       * there is no chat message behind a follow to look them up from later.
       */
      follow: msg.follow || undefined,
      nick: msg.follow ? msg.displayName : '',
      avatar: msg.follow ? ensureAvatar(msg.login) : undefined,
      color: msg.follow ? ensureReadable(msg.color || fallbackColor(msg.login), true) : ''
    }
  }

  // NOT gated by the app's own `sevenTvNickColors`: that switch is about how the chat window
  // looks to the streamer, and it was quietly deciding what the stream showed to everyone else.
  // The paint always travels; the overlay's own toggle decides whether to wear it.
  const cosmetic = msg.userId ? ensureSevenTvCosmetic(msg.userId) : undefined
  const color = ensureReadable(cosmetic?.color || msg.color || fallbackColor(msg.login), true)

  const badges: string[] = []
  const badgeSets: string[] = []
  const badgeVers: string[] = []
  for (const b of msg.badges) {
    const url = lookupBadgeUrl(msg.channel, b.setId, b.version)
    if (url) {
      badges.push(url)
      badgeSets.push(b.setId)
      badgeVers.push(b.version)
    }
  }

  const rendered = msg.text ? bodyHtml(msg) : { html: '', emotes: [] }
  const line: OverlayLineData = {
    id: msg.id,
    user: msg.userId,
    login: msg.login,
    nick: msg.displayName,
    color,
    paint: cosmetic?.paint,
    paintSize: cosmetic?.paintSize,
    paintRepeat: cosmetic?.paintRepeat,
    paintShadow: cosmetic?.paintShadow,
    firstMsg: msg.isFirstMsg || undefined,
    firstStream: msg.isFirstInSession || undefined,
    avatar: ensureAvatar(msg.login),
    badges,
    badgeSets,
    badgeVers,
    body: rendered.html,
    emotes: rendered.emotes.length ? rendered.emotes : undefined,
    text: msg.text,
    act: msg.isAction || undefined,
    kind: 'msg',
    ts: msg.timestamp,
    redeem: !!msg.redeemed,
    bits: !!msg.bits,
    bitsAmount: msg.bits || undefined,
    sub: msg.system === 'usernotice',
    subCount: subsWorth(msg),
    subGift: msg.giftFrom ? true : undefined,
    cmd: /^!/.test(msg.text)
  }
  if (msg.system === 'usernotice' && msg.systemText) line.sys = esc(msg.systemText)
  else if (msg.redeemed && msg.rewardTitle) line.sys = esc(msg.rewardTitle + (msg.rewardCost ? ` · ${msg.rewardCost}` : ''))
  return line
}
