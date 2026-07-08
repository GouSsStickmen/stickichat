import { ChatMessage, HighlightRule } from '../types'

export function highlightRuleMatches(msg: ChatMessage, rule: HighlightRule, caseSensitiveNicks: boolean): boolean {
  if (!rule.enabled || !rule.value || msg.system) return false
  if (rule.kind === 'nick') {
    return caseSensitiveNicks ? rule.value === msg.displayName : rule.value.toLowerCase() === msg.login
  }
  return msg.badges.some((b) => b.setId === rule.value)
}

/** mention or a matching highlight rule — used to drive the Chatterino-style highlights sidebar */
export function isHighlightedMessage(msg: ChatMessage, rules: HighlightRule[], caseSensitiveNicks: boolean): boolean {
  if (msg.system || msg.deleted) return false
  if (msg.isMention) return true
  return rules.some((r) => highlightRuleMatches(msg, r, caseSensitiveNicks))
}
