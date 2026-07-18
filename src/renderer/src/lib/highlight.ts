import { ChatMessage, HighlightRule } from '../types'

export interface HighlightContext {
  caseSensitiveNicks: boolean
  /** user ids of my own accounts (for the 'own' category) */
  myAccountIds?: string[]
}

export function highlightRuleMatches(msg: ChatMessage, rule: HighlightRule, ctx: HighlightContext): boolean {
  if (!rule.enabled) return false
  // category rules apply to usernotice messages too (watch streaks arrive as usernotice);
  // plain info/system lines never get highlighted
  if (msg.system && msg.system !== 'usernotice') return false
  switch (rule.kind) {
    case 'nick': {
      // the rule value may be typed in any case — always compare case-insensitively
      if (!rule.value) return false
      const v = rule.value.trim().toLowerCase()
      return v === msg.login || v === msg.displayName.toLowerCase()
    }
    case 'badge':
      return !!rule.value && !msg.system && msg.badges.some((b) => b.setId === rule.value)
    case 'own':
      return !msg.system && !!msg.userId && (ctx.myAccountIds ?? []).includes(msg.userId)
    case 'redeem':
      return !!msg.redeemed
    case 'bits':
      return !!msg.bits
    case 'raider':
      return !!msg.raider
    case 'firstMsg':
      return !!msg.isFirstMsg && !msg.system
    case 'firstStream':
      return !!msg.isFirstInSession && !msg.isFirstMsg && !msg.system
    case 'watchStreak':
      return !!msg.watchStreak
  }
}

/** mention or a badge/nick rule — drives the Chatterino-style highlights sidebar.
 *  Category rules (own/redeem/first…) only color the chat, they'd flood the sidebar. */
export function isHighlightedMessage(msg: ChatMessage, rules: HighlightRule[], ctx: HighlightContext): boolean {
  if (msg.system || msg.deleted) return false
  if (msg.isMention) return true
  return rules.some((r) => (r.kind === 'badge' || r.kind === 'nick') && highlightRuleMatches(msg, r, ctx))
}
