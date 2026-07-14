import { ipcMain, safeStorage, shell, app, BrowserWindow } from 'electron'
import { join } from 'path'
import { readConfig, writeConfig, readWindowState, writeWindowState } from './storage'
import { overlayConfigure, overlayDelete, overlayPush, OverlayDelete, OverlayStyle } from './overlayServer'

function rememberEnabled(): boolean {
  const cfg = readConfig() as { settings?: { rememberWindowSize?: boolean } } | null
  return cfg?.settings?.rememberWindowSize !== false
}

function createChildWindow(
  hash: string,
  opts: { width: number; height: number; title?: string; parent?: BrowserWindow | null; stateKey?: string }
): BrowserWindow {
  const saved = opts.stateKey && rememberEnabled() ? readWindowState(opts.stateKey) : null
  const win = new BrowserWindow({
    width: saved?.width ?? opts.width,
    height: saved?.height ?? opts.height,
    x: saved?.x,
    y: saved?.y,
    minWidth: 320,
    minHeight: 240,
    autoHideMenuBar: true,
    backgroundColor: '#0e0e10',
    title: opts.title ?? 'StickiChat',
    // utility windows become children of the chat window that opened them: they always stay
    // ABOVE it, even when that chat window itself is set to always-on-top
    parent: opts.parent ?? undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // these are secondary windows the user tabs away from constantly (typing in the main
      // window while a picker sits unfocused) — without this Chromium throttles their timers
      // and repaints, which looks exactly like "content stops updating until I reopen it"
      backgroundThrottling: false
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
  if (opts.stateKey) {
    const key = opts.stateKey
    let t: NodeJS.Timeout | null = null
    const save = (): void => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        if (!win.isDestroyed() && !win.isMinimized()) writeWindowState(win.getBounds(), key)
      }, 500)
    }
    win.on('resize', save)
    win.on('move', save)
  }
  return win
}

export function registerIpc(): void {
  ipcMain.handle('secure:encrypt', (_e, plain: string): string => {
    if (!safeStorage.isEncryptionAvailable()) return 'plain:' + Buffer.from(plain, 'utf8').toString('base64')
    return 'enc:' + safeStorage.encryptString(plain).toString('base64')
  })

  ipcMain.handle('secure:decrypt', (_e, stored: string): string | null => {
    try {
      if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
      if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
      return null
    } catch {
      return null
    }
  })

  ipcMain.handle('config:get', () => readConfig())
  ipcMain.handle('config:set', (_e, cfg: unknown) => writeConfig(cfg))

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url)
  })

  ipcMain.handle('app:version', () => app.getVersion())

  // detached window asks to move its tab back — forward to the other (main) windows
  ipcMain.handle('app:reattach', (e, payload: string) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.id !== e.sender.id) w.webContents.send('app:reattach', payload)
    }
  })

  // opens a detached chat window (same app, hash tells the renderer what to show)
  ipcMain.handle('app:detach', (_e, hash: string) => {
    createChildWindow(hash, { width: 900, height: 720 })
  })

  // standalone emote picker window
  ipcMain.handle('app:openEmotePicker', (e, hash: string) => {
    createChildWindow(hash, {
      width: 420,
      height: 580,
      title: 'StickiChat — Emotes',
      stateKey: 'emotepicker',
      parent: BrowserWindow.fromWebContents(e.sender)
    })
  })

  // standalone user card window (resizable, can be moved anywhere incl. other displays)
  ipcMain.handle('app:openUserCard', (e, hash: string) => {
    createChildWindow(hash, {
      width: 480,
      height: 640,
      title: 'StickiChat — User',
      stateKey: 'usercard',
      parent: BrowserWindow.fromWebContents(e.sender)
    })
  })

  // standalone whispers window
  ipcMain.handle('app:openWhispers', (e, hash: string) => {
    createChildWindow(hash, {
      width: 380,
      height: 560,
      title: 'StickiChat — Whispers',
      stateKey: 'whispers',
      parent: BrowserWindow.fromWebContents(e.sender)
    })
  })

  // standalone highlights window
  ipcMain.handle('app:openHighlights', (e, hash: string) => {
    createChildWindow(hash, {
      width: 340,
      height: 620,
      title: 'StickiChat — Highlights',
      stateKey: 'highlights',
      parent: BrowserWindow.fromWebContents(e.sender)
    })
  })

  // standalone settings window
  ipcMain.handle('app:openSettings', (e, hash: string) => {
    createChildWindow(hash, {
      width: 980,
      height: 680,
      title: 'StickiChat — Settings',
      stateKey: 'settings',
      parent: BrowserWindow.fromWebContents(e.sender)
    })
  })

  // an emote picked in the standalone picker window needs to land in the main window's input
  ipcMain.handle('app:sendEmotePick', (e, payload: string) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.id !== e.sender.id) w.webContents.send('app:emotePicked', payload)
    }
  })

  // "jump to this message" clicked in a standalone highlights window → main chat scrolls there
  ipcMain.handle('app:jumpTo', (e, payload: string) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.id !== e.sender.id) w.webContents.send('app:jumpTo', payload)
    }
  })

  // any window that just saved config tells the others to reload it from disk
  ipcMain.handle('app:notifyConfigChanged', (e) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.id !== e.sender.id) w.webContents.send('app:configChanged')
    }
  })

  ipcMain.handle('window:setAlwaysOnTop', (e, flag: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    // 'screen-saver' is a HIGHER level than the default 'floating' one — without it a
    // fullscreen game (which itself runs at a high window level) ends up above our window,
    // and switching back leaves the chat stranded underneath. Re-assert + raise as well.
    if (flag) {
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
    } else {
      win.setAlwaysOnTop(false)
    }
  })

  ipcMain.handle('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })

  // bring the calling window to the OS foreground (e.g. after picking an emote in the
  // standalone picker the chat input should be ready for Enter immediately)
  ipcMain.handle('window:focusSelf', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  // eyedropper: the OS magnifier loupe renders BELOW any always-on-top window (settings can be
  // a separate window while the main chat is pinned), so drop every pinned window for the pick
  // and restore them afterwards
  let suspendedOnTop: BrowserWindow[] = []
  ipcMain.handle('window:suspendAlwaysOnTop', () => {
    suspendedOnTop = BrowserWindow.getAllWindows().filter((w) => w.isAlwaysOnTop())
    for (const w of suspendedOnTop) w.setAlwaysOnTop(false)
  })
  ipcMain.handle('window:resumeAlwaysOnTop', () => {
    for (const w of suspendedOnTop) if (!w.isDestroyed()) w.setAlwaysOnTop(true, 'screen-saver')
    suspendedOnTop = []
  })

  // OBS chat overlay: renderer streams pre-rendered lines; main serves them over SSE
  ipcMain.handle(
    'overlay:configure',
    (_e, enabled: boolean, port: number, styles?: Record<string, OverlayStyle>) => {
      overlayConfigure(!!enabled, Math.max(1024, Math.min(65535, port || 4715)), styles)
    }
  )
  ipcMain.handle('overlay:push', (_e, channel: string, html: string, id: string, user: string, login: string) => {
    overlayPush(channel, html, id ?? '', user ?? '', login ?? '')
  })
  ipcMain.handle('overlay:delete', (_e, channel: string, del: OverlayDelete) => {
    overlayDelete(channel, del ?? {})
  })

  // All HTTP goes through the main process so the renderer never hits CORS walls
  ipcMain.handle(
    'net:fetch',
    async (
      _e,
      url: string,
      options?: { method?: string; headers?: Record<string, string>; body?: string }
    ) => {
      try {
        const res = await fetch(url, {
          method: options?.method ?? 'GET',
          headers: options?.headers,
          body: options?.body
        })
        const text = await res.text()
        let json: unknown = null
        try {
          json = JSON.parse(text)
        } catch {
          /* not json */
        }
        return { ok: res.ok, status: res.status, json, text }
      } catch (err) {
        return { ok: false, status: 0, json: null, text: String(err) }
      }
    }
  )
}
