/**
 * Renderer-side diagnostics.
 *
 * The log used to record only uncaught exceptions and console output — nothing about what the
 * app was DOING. A real report about the chat freezing for five minutes came back as three
 * hundred lines of ResizeObserver notices and not one line about the connection, because the
 * IRC client logged nothing at all. These helpers exist so the interesting events — sockets
 * opening, dying, retrying — end up in the file a user can actually send.
 *
 * Only lifecycle events go through here. Nothing per-message: this crosses an IPC boundary.
 */

type Level = 'info' | 'warn' | 'error'

/** the standalone windows share the log file; the tag says which one wrote the line */
const win = window.location.hash ? window.location.hash.slice(1).split('=')[0] : 'main'

export function diag(level: Level, source: string, message: string): void {
  void window.sticki?.diagLog?.(level, source, `[${win}] ${message}`)
}

export const diagInfo = (source: string, message: string): void => diag('info', source, message)
export const diagWarn = (source: string, message: string): void => diag('warn', source, message)

/**
 * A socket's life story in one line each. `label` names the connection ("irc", "eventsub"…)
 * so four sockets reconnecting at once are still readable.
 */
export function diagSocket(label: string, event: string, detail?: string): void {
  diagInfo('socket', `${label}: ${event}${detail ? ` — ${detail}` : ''}`)
}
