import { useChatStore } from '../store/chat'
import { ChatMessage } from '../types'

// how many recent messages per channel to hand over when a tab moves between windows.
// Enough to preserve on-screen state + a good chunk of scrollback without a huge IPC payload.
const SEED_CAP = 300

/** snapshot the current live buffer for the given channels, to hand to another window */
export function buildChannelSeed(channels: string[]): Record<string, ChatMessage[]> {
  const store = useChatStore.getState()
  const seed: Record<string, ChatMessage[]> = {}
  for (const ch of channels) {
    const msgs = store.messages[ch]
    if (msgs?.length) seed[ch] = msgs.slice(-SEED_CAP)
  }
  return seed
}

/** merge a handed-over snapshot into this window's store, keeping live (non-dimmed) state */
export function injectChannelSeed(seed?: Record<string, ChatMessage[]>): void {
  if (!seed) return
  const store = useChatStore.getState()
  for (const [ch, msgs] of Object.entries(seed)) store.seedMessages(ch, msgs)
}
