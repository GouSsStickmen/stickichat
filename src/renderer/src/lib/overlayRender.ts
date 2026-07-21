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

/** message body → safe HTML (emotes/cheers as <img class="emote">, everything else escaped) */
function bodyHtml(msg: ChatMessage): string {
  let out = ''
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
        out += `<img class="emote" src="${esc(tk.emote.url)}" alt="${esc(tk.emote.code)}">`
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
      case 'mention':
        out += `<b>${esc(tk.name)}</b>`
        break
      case 'cheer':
        out += tk.url ? `<img class="emote" src="${esc(tk.url)}">` : ''
        out += `<b style="color:${esc(tk.color)}">${tk.bits}</b>`
        break
    }
  }
  return out
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
      nick: '',
      color: '',
      badges: [],
      body: '',
      sys: esc(msg.systemText),
      kind: 'info',
      ts: msg.timestamp,
      redeem: !!msg.redeemed,
      mod: !!msg.modAction
    }
  }

  const cosmetic = s.sevenTvNickColors && msg.userId ? ensureSevenTvCosmetic(msg.userId) : undefined
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

  const line: OverlayLineData = {
    id: msg.id,
    user: msg.userId,
    login: msg.login,
    nick: msg.displayName,
    color,
    paint: cosmetic?.paint,
    avatar: ensureAvatar(msg.login),
    badges,
    badgeSets,
    badgeVers,
    body: msg.text ? bodyHtml(msg) : '',
    text: msg.text,
    act: msg.isAction || undefined,
    kind: 'msg',
    ts: msg.timestamp,
    redeem: !!msg.redeemed,
    bits: !!msg.bits,
    sub: msg.system === 'usernotice',
    cmd: /^!/.test(msg.text)
  }
  if (msg.system === 'usernotice' && msg.systemText) line.sys = esc(msg.systemText)
  else if (msg.redeemed && msg.rewardTitle) line.sys = esc(msg.rewardTitle + (msg.rewardCost ? ` · ${msg.rewardCost}` : ''))
  return line
}
