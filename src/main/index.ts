import { app, shell, screen, session, BrowserWindow, Menu, Rectangle } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { initAutoUpdater } from './updater'
import { readConfig, readWindowState, writeWindowState, compactConfig } from './storage'
import { registerAssetScheme, serveAssetProtocol } from './assets'
import { overlayConfigure } from './overlayServer'
import { startDiagnostics, watchWindow } from './diagnostics'

// The dev build and the installed app resolve to the SAME userData dir (Windows paths are
// case-insensitive), and two Electron instances fight over Chromium's cache locks — the loser
// runs with NO http cache at all ("Unable to create cache: Access is denied"), so every emote
// image re-downloads constantly. Keep the config file shared, but give dev its own session dir.
registerAssetScheme()

if (!app.isPackaged) {
  app.setPath('sessionData', join(app.getPath('userData'), 'dev-session'))
}

startDiagnostics()

let mainWindow: BrowserWindow | null = null

// Fullscreen games change the display resolution; saved/current window coordinates can end
// up entirely off-screen — the window "opens" from the taskbar but is invisible and seems
// impossible to bring back. Treat bounds as visible only if a real chunk of the title bar
// area intersects a display's work area.
function boundsVisible(b: { x?: number; y?: number; width: number; height: number }): boolean {
  if (typeof b.x !== 'number' || typeof b.y !== 'number') return false
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    const overlapX = Math.min(b.x! + b.width, a.x + a.width) - Math.max(b.x!, a.x)
    const overlapY = Math.min(b.y! + 60, a.y + a.height) - Math.max(b.y!, a.y)
    return overlapX > 60 && overlapY > 20
  })
}

/** clamp the window back into view if a resolution switch pushed it off-screen */
function ensureOnScreen(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized()) return
  const b = win.getBounds() as Rectangle
  if (!boundsVisible(b)) win.center()
}

function createWindow(): void {
  // restore the last size/position when the user hasn't turned that off
  const cfg = readConfig() as { settings?: { rememberWindowSize?: boolean } } | null
  const remember = cfg?.settings?.rememberWindowSize !== false
  let saved = remember ? readWindowState() : null
  // a stale position from another monitor/resolution must not spawn the window off-screen
  if (saved && !boundsVisible(saved)) saved = { ...saved, x: undefined, y: undefined }

  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 480,
    minHeight: 360,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0e0e10',
    title: 'StickiChat',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // this is a chat client meant to keep receiving/updating while the user works in
      // other windows — don't let Chromium throttle it just because it's unfocused
      backgroundThrottling: false,
      // the stream player is a <webview>: the twitch embed insists its `parent` matches the page
      // holding it, and a packaged build is served from file://, which has no host to match
      webviewTag: true
    }
  })

  watchWindow(mainWindow)

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // returning from a fullscreen game: make sure the restored window is actually visible
  // and above the other windows instead of silently sitting off-screen / underneath
  mainWindow.on('restore', () => {
    if (!mainWindow) return
    ensureOnScreen(mainWindow)
    mainWindow.moveTop()
  })
  mainWindow.on('show', () => {
    if (mainWindow) ensureOnScreen(mainWindow)
  })
  // when always-on-top is on, a fullscreen app can steal the top window level; regaining focus
  // must re-assert our high level so the chat comes back to the front instead of sinking
  mainWindow.on('focus', () => {
    if (mainWindow && mainWindow.isAlwaysOnTop()) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver')
      mainWindow.moveTop()
    }
  })

  // persist size/position (debounced) so the next launch reopens exactly the same
  let saveTimer: NodeJS.Timeout | null = null
  const saveBounds = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
      writeWindowState(mainWindow.getBounds())
    }, 500)
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)

  // All external links open in the default browser, never inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// cut/copy/paste context menu for text fields and selections in every window;
// stays out of the way of the app's own right-click actions (emotes, nicks…)
app.on('web-contents-created', (_e, contents) => {
  contents.on('context-menu', (_ev, params) => {
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { role: 'cut', label: 'Вирізати' },
        { role: 'copy', label: 'Копіювати' },
        { role: 'paste', label: 'Вставити' },
        { type: 'separator' },
        { role: 'selectAll', label: 'Вибрати все' }
      ]).popup()
    } else if (params.selectionText.trim()) {
      Menu.buildFromTemplate([{ role: 'copy', label: 'Копіювати' }]).popup()
    }
  })
})

// Single instance: launching the app again (icon/shortcut) while a window is "lost" behind
// a fullscreen game recovers it instead of spawning a second copy fighting for the config.
// Packaged only — dev shares the userData dir with the installed app and must coexist.
if (app.isPackaged) {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  }
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    ensureOnScreen(mainWindow)
    mainWindow.show()
    mainWindow.focus()
  })
}

/**
 * Open the overlay port before anything else needs to happen.
 *
 * The renderer used to be the first thing to mention overlays, so between the app starting and its
 * window finishing its first render — seconds, on a cold start — the port was simply closed. A
 * browser source that reloads in that window (OBS reloads them when a scene becomes active, and
 * the streamer reloads them by hand) gets a refused connection, and a document that failed to load
 * never retries: the source stays blank until somebody notices and refreshes it again.
 *
 * The config on disk already holds every overlay, so the server can be up before the window is.
 * The renderer still pushes the same styles moments later, with the uploaded fonts and the
 * compiled scenes that only it can produce; this is the same map, minus those.
 */
function serveOverlaysEarly(): void {
  try {
    const cfg = readConfig() as {
      settings?: { overlayEnabled?: boolean; overlayPort?: number; chatOverlays?: { id: string }[] }
    } | null
    const s = cfg?.settings
    if (!s || s.overlayEnabled === false) return
    const styles: Record<string, unknown> = {}
    for (const o of s.chatOverlays ?? []) styles[o.id] = o
    overlayConfigure(true, Math.max(1024, Math.min(65535, s.overlayPort || 4715)), styles as never)
  } catch {
    /* a config we cannot read is the renderer's problem to report, not a reason to fail startup */
  }
}

/*
 * Keep the stream playing when the app is not the window in front.
 *
 * backgroundThrottling:false already keeps our own timers running, but the video lives in a
 * webview, and Chromium has a second set of rules for a window it thinks nobody is looking at: an
 * occluded or minimised window has its renderer backgrounded and its media suspended. That is why
 * the stream paused itself on switching to another app or folding the chat away. These three
 * switches turn that behaviour off for the whole process; they have to be set before ready.
 */
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

app.whenReady().then(() => {
  // no application menu at all: with autoHideMenuBar the default File/Edit/View bar still
  // pops in on Alt, which the user doesn't want (and we have our own context menus)
  Menu.setApplicationMenu(null)

  // spellcheck for the message input — Ukrainian + English (Chromium downloads
  // the Hunspell dictionaries on demand)
  try {
    session.defaultSession.setSpellCheckerLanguages(['uk', 'en-US'])
  } catch {
    /* unsupported language on this platform — keep defaults */
  }
  // Electron grants renderer permissions by default; make that explicit so the
  // Local Font Access API (font picker) keeps working across Electron upgrades
  session.defaultSession.setPermissionCheckHandler(() => true)
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true))
  serveAssetProtocol()
  // shrink whatever the config still carries inline before any window can save it back
  compactConfig()
  registerIpc()
  serveOverlaysEarly()
  createWindow()
  initAutoUpdater()

  // a game toggling the display resolution can strand windows outside every screen —
  // pull them back once the metrics settle
  screen.on('display-metrics-changed', () => {
    setTimeout(() => {
      for (const w of BrowserWindow.getAllWindows()) ensureOnScreen(w)
    }, 1000)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
