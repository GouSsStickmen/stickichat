/**
 * Deferred, coalesced localStorage writes.
 *
 * `localStorage.setItem` is synchronous and disk-backed, and the cost scales with the value.
 * Measured in the running app: one save of the avatar cache spent 108 ms in `JSON.stringify` and
 * 56 ms in `setItem` — a sixth of a second with the main thread blocked, on a save that ran every
 * time a batch of avatars resolved, which while scrolling through history is every 400 ms. That is
 * what the reader felt as the chat "catching" mid-scroll; the profile put seven of a thirty-four
 * second trace inside that one function.
 *
 * None of these caches need to reach disk this instant. They need to reach it before the window
 * closes. So writes are coalesced per key, the value is serialised at flush time rather than at
 * call time, and the flush waits for an idle moment — the cost lands between frames instead of
 * inside one.
 */

/** pending writes, newest serializer per key wins */
const pending = new Map<string, () => string>()
let scheduled = false

type IdleHost = {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
}

function runFlush(): void {
  scheduled = false
  for (const [key, build] of pending) {
    try {
      localStorage.setItem(key, build())
    } catch {
      /* quota or a serializer that threw — these are all caches, none of them is critical */
    }
  }
  pending.clear()
}

function schedule(): void {
  if (scheduled) return
  scheduled = true
  const host = window as unknown as IdleHost
  // the timeout matters more than the idle part: it bounds how much can be lost to a hard exit
  if (host.requestIdleCallback) host.requestIdleCallback(runFlush, { timeout: 4000 })
  else window.setTimeout(runFlush, 1500)
}

/**
 * Write `key` once the browser is idle. `build` runs at flush time, so calling this repeatedly
 * with a changing structure costs one serialization, not one per call.
 */
export function queueWrite(key: string, build: () => string): void {
  pending.set(key, build)
  schedule()
}

/** write everything pending right now — for shutdown, where there is no later */
export function flushWrites(): void {
  if (pending.size) runFlush()
}

// a closing window is the one moment the deferral must not win
window.addEventListener('pagehide', flushWrites)
window.addEventListener('beforeunload', flushWrites)
