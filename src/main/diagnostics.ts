import { app, BrowserWindow, crashReporter } from 'electron'
import { readConfig } from './storage'
import { join } from 'path'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'

/**
 * Local diagnostics: a rolling log plus whatever Chromium leaves behind when a renderer dies.
 *
 * The point is that a user can answer "what happened?" without a debugger attached. Everything
 * stays on the machine — nothing is uploaded, and the crash reporter is started with no upload
 * URL precisely so Electron writes the .dmp locally instead of posting it somewhere.
 *
 * The log is deliberately boring: timestamp, level, source, message. It is going to be pasted
 * into a bug report by someone who is annoyed, so it has to be readable as text.
 */

const MAX_BYTES = 2 * 1024 * 1024
const KEEP_FILES = 3

export function logDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function logPath(): string {
  return join(logDir(), 'stickichat.log')
}

function ensureDir(): void {
  const d = logDir()
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
}

/** roll the file over once it gets big, and keep only the last few */
function rollIfNeeded(): void {
  try {
    const p = logPath()
    if (!existsSync(p) || statSync(p).size < MAX_BYTES) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const rolled = join(logDir(), `stickichat-${stamp}.log`)
    appendFileSync(rolled, readFileSync(p))
    unlinkSync(p)
    const old = readdirSync(logDir())
      .filter((f) => f.startsWith('stickichat-') && f.endsWith('.log'))
      .sort()
      .slice(0, -KEEP_FILES)
    for (const f of old) unlinkSync(join(logDir(), f))
  } catch {
    /* logging must never be the thing that breaks the app */
  }
}

export type LogLevel = 'info' | 'warn' | 'error'

/**
 * Messages that say nothing and arrive by the hundred.
 *
 * "ResizeObserver loop completed with undelivered notifications" is a Chromium notice, not an
 * app fault: no stack, no file, no line. It fires whenever an observer needs a second pass —
 * which, in a chat that is constantly relayouting, is all the time. A real user's report came
 * back as 300 lines of it and not one line about anything else, which is the opposite of what
 * a diagnostics log is for. It is counted, not written.
 */
const NOISE = [/ResizeObserver loop/i]
let noiseCount = 0
let noiseSince = 0

/**
 * Consecutive identical messages collapse into one line with a count. A failing token refresh
 * repeats on every single request; without this it buries everything around it.
 */
let lastKey = ''
let lastCount = 0

function write(line: string): void {
  ensureDir()
  rollIfNeeded()
  appendFileSync(logPath(), line, 'utf8')
}

function stamp(level: LogLevel, source: string, message: string): string {
  return `${new Date().toISOString()}  ${level.toUpperCase().padEnd(5)}  ${source.padEnd(10)}  ${message}\n`
}

/** emit the "…and it happened N more times" line for whatever was being collapsed */
function flushRepeat(): void {
  if (lastCount > 1) write(stamp('info', 'log', `↑ previous line repeated ${lastCount - 1}x`))
  lastCount = 0
  lastKey = ''
}

export function log(level: LogLevel, source: string, message: string): void {
  try {
    if (NOISE.some((re) => re.test(message))) {
      if (!noiseCount) noiseSince = Date.now()
      noiseCount++
      // one line a minute, so the fact that it is happening is still visible
      if (Date.now() - noiseSince >= 60_000) {
        flushRepeat()
        write(stamp('info', 'noise', `${noiseCount}x "${message.slice(0, 60)}…" in the last minute`))
        noiseCount = 0
      }
      return
    }
    const key = `${level}|${source}|${message}`
    if (key === lastKey) {
      lastCount++
      return
    }
    flushRepeat()
    lastKey = key
    lastCount = 1
    write(stamp(level, source, message))
  } catch {
    /* see above */
  }
}

/** the last `lines` lines of the current log, for showing in the app */
export function tailLog(lines = 400): string {
  try {
    if (!existsSync(logPath())) return ''
    return readFileSync(logPath(), 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

/** environment block that goes at the top of every report — the questions always asked first */
export function environmentReport(): string {
  const mem = process.getSystemMemoryInfo?.()
  return [
    `StickiChat ${app.getVersion()}`,
    `Electron  ${process.versions.electron}   Chromium ${process.versions.chrome}   Node ${process.versions.node}`,
    `OS        ${process.platform} ${process.arch} ${process.getSystemVersion?.() ?? ''}`,
    mem ? `Memory    ${Math.round(mem.total / 1024)} MB total, ${Math.round(mem.free / 1024)} MB free` : '',
    `Locale    ${app.getLocale()}`,
    `Started   ${new Date(Date.now() - process.uptime() * 1000).toISOString()}`
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The handful of settings that change how the chat behaves, so a report stands on its own.
 *
 * The first real report arrived as two files because the log alone said nothing — and the
 * settings that mattered (history on? buffer size? smooth scroll?) were in the other one.
 * Deliberately a short list: this is a bug report, not a config dump, and it must never
 * carry tokens.
 */
function settingsDigest(): string {
  try {
    const cfg = readConfig() as {
      settings?: Record<string, unknown>
      accounts?: unknown[]
      tabs?: { panes?: unknown[] }[]
    } | null
    const s = cfg?.settings ?? {}
    const panes = (cfg?.tabs ?? []).reduce((n, t) => n + (t.panes?.length ?? 0), 0)
    const keys = [
      'loadHistory',
      'messageLimit',
      'smoothChatScroll',
      'pauseEmotesUnfocused',
      'sevenTvNickColors',
      'linkPreviews',
      'showHighlightSidebar',
      'fontSize',
      'tabScale'
    ]
    return [
      `Accounts  ${(cfg?.accounts ?? []).length}`,
      `Tabs      ${(cfg?.tabs ?? []).length} (${panes} pane(s))`,
      `Settings  ${keys.map((k) => `${k}=${JSON.stringify(s[k])}`).join('  ')}`
    ].join('\n')
  } catch {
    return 'Settings  (unreadable)'
  }
}

/** everything a bug report needs, as one pasteable block */
export function buildReport(): string {
  return [
    '=== StickiChat diagnostics ===',
    environmentReport(),
    settingsDigest(),
    '',
    `Crash dumps: ${app.getPath('crashDumps')}`,
    `Log file:    ${logPath()}`,
    '',
    '=== recent log ===',
    tailLog(300) || '(empty)'
  ].join('\n')
}

/**
 * Wire up the collectors. Called once from the main process before any window exists, so a
 * failure during startup is still caught.
 */
export function startDiagnostics(): void {
  ensureDir()
  // no submitURL: Electron then keeps the dump next to the app data instead of uploading it
  try {
    crashReporter.start({ submitURL: '', uploadToServer: false, compress: false })
  } catch {
    /* older platforms without a crash handler still get the log */
  }

  log('info', 'app', `start — ${environmentReport().replace(/\n/g, ' | ')}`)

  process.on('uncaughtException', (err) => {
    log('error', 'main', `uncaught: ${err?.stack || err}`)
  })
  process.on('unhandledRejection', (reason) => {
    log('error', 'main', `unhandled rejection: ${String(reason)}`)
  })

  app.on('render-process-gone', (_e, wc, details) => {
    const url = (() => {
      try {
        return wc.getURL()
      } catch {
        return '?'
      }
    })()
    log('error', 'renderer', `gone: reason=${details.reason} exitCode=${details.exitCode} url=${url}`)
  })
  app.on('child-process-gone', (_e, details) => {
    log('error', 'child', `gone: type=${details.type} reason=${details.reason} name=${details.name ?? ''}`)
  })
}

/** attach per-window collectors — renderer console errors and unresponsive windows */
export function watchWindow(win: BrowserWindow): void {
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // 2 = warning, 3 = error in Chromium's level enum; anything quieter is noise here
    if (level < 2) return
    const where = sourceId ? ` (${sourceId.split('/').pop()}:${line})` : ''
    log(level === 3 ? 'error' : 'warn', 'console', `${message}${where}`)
  })
  win.on('unresponsive', () => log('warn', 'window', 'unresponsive'))
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    log('error', 'window', `load failed ${code} ${desc} ${url}`)
  )
}
