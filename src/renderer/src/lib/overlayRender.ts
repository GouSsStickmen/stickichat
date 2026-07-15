import { ChatMessage } from '../types'
import { tokenizeMessage, ensureReadable, fallbackColor } from './tokenize'
import { lookupBadgeUrl, lookupCheermote, lookupEmote } from '../store/emotes'
import { useSettingsStore } from '../store/settings'
import { ensureSevenTvCosmetic } from './seventvCosmetics'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Renders one chat message into the self-contained HTML line the OBS overlay shows.
 * Everything user-controlled is escaped; emote/badge URLs come from our own lookups.
 * Returns null for lines the overlay should skip.
 */
export function renderOverlayHtml(msg: ChatMessage): string | null {
  const s = useSettingsStore.getState().settings
  if (msg.deleted || msg.historical || msg.groupedUnder) return null
  if (s.mutedUsers.some((u) => u.login === msg.login && u.mode === 'hide')) return null
  if (s.overlayHiddenUsers.includes(msg.login)) return null
  if (s.overlayHideCmd && /^!/.test(msg.text)) return null
  if (!s.overlayShowBits && msg.bits) return null
  if (!s.overlayShowRedeems && msg.redeemed) return null

  // system lines (raids, subs, clears…) render italic without a nick
  if (msg.system === 'info') {
    if (msg.redeemed && !s.overlayShowRedeems) return null
    if (msg.modAction && !s.overlayShowModActions) return null
    return msg.systemText ? `<span class="sys">${esc(msg.systemText)}</span>` : null
  }

  let out = ''
  if (msg.system === 'usernotice' && msg.systemText) {
    // subs / resubs / raids etc. — hideable as a group
    if (!s.overlayShowSubs) return null
    out += `<span class="sys">${esc(msg.systemText)}</span>`
    if (!msg.text) return out
    out += '<br>'
  }

  if (s.overlayBadges) {
    for (const b of msg.badges) {
      const url = lookupBadgeUrl(msg.channel, b.setId, b.version)
      if (url) out += `<img class="badge" src="${esc(url)}">`
    }
  }

  // optional 7TV cosmetic nick color / gradient paint (same setting as the chat pane)
  const cosmetic = s.sevenTvNickColors && msg.userId ? ensureSevenTvCosmetic(msg.userId) : undefined
  if (cosmetic?.paint) {
    out += `<span class="nick" style="background:${esc(cosmetic.paint)};-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent">${esc(msg.displayName)}</span>`
  } else {
    const color = ensureReadable(cosmetic?.color || msg.color || fallbackColor(msg.login), true)
    out += `<span class="nick" style="color:${esc(color)}">${esc(msg.displayName)}</span>`
  }
  out += msg.isAction ? ' ' : ': '

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
      case 'emoji':
        out += esc(tk.char)
        break
      case 'link':
        out += esc(tk.label)
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
