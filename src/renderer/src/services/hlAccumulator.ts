import { ChatMessage } from '../types'
import { isHighlightedMessage } from '../lib/highlight'
import { useSettingsStore } from '../store/settings'

/**
 * Central highlights accumulator. The sidebar used to collect entries only while it was
 * MOUNTED — a keyword ping with the panel closed simply vanished. This module ingests every
 * message in the main window (chatService.queue), classifies it once (mention / rule or
 * keyword highlight / redeem / sub event) and persists per channel, so opening the panel or
 * the standalone window later shows the full history.
 */
export interface HlSavedItem extends ChatMessage {
  _men?: boolean
  _hl?: boolean
  _sub?: boolean
}

export const hlSavedKey = (channel: string): string => `sticki:hlSaved:${channel}`
const SAVED_LIMIT = 300

const maps = new Map<string, Map<string, HlSavedItem>>()
const timers = new Map<string, number>()

function readStorage(channel: string): Map<string, HlSavedItem> {
  try {
    const raw = localStorage.getItem(hlSavedKey(channel))
    const list = raw ? (JSON.parse(raw) as HlSavedItem[]) : []
    return new Map(list.map((i) => [i.id, i]))
  } catch {
    return new Map()
  }
}

export function loadSavedMap(channel: string): Map<string, HlSavedItem> {
  let m = maps.get(channel)
  if (!m) {
    m = readStorage(channel)
    maps.set(channel, m)
  }
  return m
}

/** another window wrote the storage key — replace the cache with the fresh contents */
export function reloadSavedMap(channel: string): void {
  maps.set(channel, readStorage(channel))
}

export function persistSaved(channel: string): void {
  if (timers.has(channel)) return
  timers.set(
    channel,
    window.setTimeout(() => {
      timers.delete(channel)
      try {
        const m = loadSavedMap(channel)
        const list = [...m.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-SAVED_LIMIT)
        maps.set(channel, new Map(list.map((i) => [i.id, i])))
        localStorage.setItem(hlSavedKey(channel), JSON.stringify(list))
      } catch {
        /* best-effort */
      }
    }, 500)
  )
}

function matchesKeywords(text: string, words: string[]): boolean {
  if (!words.length || !text) return false
  const tl = text.toLowerCase()
  return words.some((w) => w && tl.includes(w.toLowerCase()))
}

/** classify + record one incoming message (call unconditionally; cheap early-outs) */
export function hlIngest(channel: string, msg: ChatMessage): void {
  // main window only — other windows would double-write the same storage key
  if (window.location.hash) return
  const st = useSettingsStore.getState()
  const men = !!(msg.isMention || msg.replyToMe)
  const red = !!msg.redeemed
  const sub = !!msg.subEvent
  const hl =
    isHighlightedMessage(msg, st.highlightRules, { caseSensitiveNicks: st.settings.caseSensitiveNicks }) ||
    (!msg.system && matchesKeywords(msg.text, st.settings.keywordAlerts))
  if (!men && !red && !hl && !sub) return
  const map = loadSavedMap(channel)
  if (map.has(msg.id)) return
  map.set(msg.id, { ...msg, _men: men, _hl: hl, _sub: sub })
  persistSaved(channel)
  window.dispatchEvent(new CustomEvent('sticki:hlsaved', { detail: { channel } }))
}
