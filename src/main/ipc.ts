import { ipcMain, safeStorage, shell, app, BrowserWindow, desktopCapturer, screen } from 'electron'
import { join } from 'path'
import { readConfig, writeConfig, readWindowState, writeWindowState } from './storage'
import { overlayConfigure, overlayDelete, overlayPush, overlayRestart, OverlayDelete, OverlayStyle, OverlayLine } from './overlayServer'

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

  // OBS overlay editor — a big window: control panels left, live preview center
  ipcMain.handle('app:openOverlayEditor', (e, overlayId: string) => {
    createChildWindow(`overlayeditor=${encodeURIComponent(overlayId)}`, {
      width: 1360,
      height: 820,
      title: 'StickiChat — Overlay Editor',
      stateKey: 'overlayeditor',
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
  let eyedropperWin: BrowserWindow | null = null
  // ---- own screen eyedropper: per-display screenshots + fullscreen topmost magnifiers ----
  // (Chromium's built-in EyeDropper loupe kept sinking behind our other windows)
  let eyedropperResolve: ((hex: string | null) => void) | null = null
  ipcMain.on('eyedropper:result', (_e, hex: string | null) => {
    eyedropperResolve?.(hex)
    eyedropperResolve = null
  })
  ipcMain.handle('eyedropper:pick', async () => {
    const displays = screen.getAllDisplays()
    const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * (d.scaleFactor || 1))))
    const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * (d.scaleFactor || 1))))
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxW, height: maxH }
    })
    if (!sources.length) return null
    const wins: BrowserWindow[] = []
    const closeAll = (): void => {
      for (const w of wins) if (!w.isDestroyed()) w.close()
    }
    const pageFor = (dataUrl: string): string => `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;overflow:hidden;cursor:crosshair;background:#000}
      img{position:absolute;inset:0;width:100%;height:100%}
      #loupe{position:fixed;width:120px;height:120px;border-radius:50%;border:2px solid #fff;
        box-shadow:0 0 0 1px #000,0 4px 14px rgba(0,0,0,.6);pointer-events:none;display:none;
        background-repeat:no-repeat;image-rendering:pixelated;overflow:hidden}
      #loupe::after{content:'';position:absolute;left:50%;top:50%;width:10px;height:10px;
        transform:translate(-50%,-50%);border:1px solid #fff;box-shadow:0 0 0 1px #000}
      #hex{position:fixed;padding:2px 8px;border-radius:4px;background:#000;color:#fff;
        font:12px monospace;pointer-events:none;display:none}
    </style></head><body>
    <img id="shot" src="${dataUrl}">
    <div id="loupe"></div><div id="hex"></div>
    <canvas id="cv" style="display:none"></canvas>
    <script>
      const img = document.getElementById('shot')
      const loupe = document.getElementById('loupe')
      const hexEl = document.getElementById('hex')
      const cv = document.getElementById('cv')
      let ctx = null
      img.onload = () => {
        cv.width = img.naturalWidth; cv.height = img.naturalHeight
        ctx = cv.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0)
      }
      if (img.complete) img.onload()
      const Z = 8
      function pixelAt(e){
        if (!ctx) return null
        // proportional mapping — immune to DPI scale differences between displays
        const x = Math.min(cv.width - 1, Math.max(0, Math.round((e.clientX / window.innerWidth) * cv.width)))
        const y = Math.min(cv.height - 1, Math.max(0, Math.round((e.clientY / window.innerHeight) * cv.height)))
        const d = ctx.getImageData(x, y, 1, 1).data
        return { hex: '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('') }
      }
      document.addEventListener('mousemove', (e) => {
        const p = pixelAt(e)
        if (!p) return
        loupe.style.display = 'block'
        hexEl.style.display = 'block'
        const lx = Math.min(e.clientX + 20, window.innerWidth - 130)
        const ly = Math.min(e.clientY + 20, window.innerHeight - 150)
        loupe.style.left = lx + 'px'
        loupe.style.top = ly + 'px'
        hexEl.style.left = (lx + 4) + 'px'
        hexEl.style.top = (ly + 126) + 'px'
        hexEl.textContent = p.hex
        loupe.style.backgroundImage = 'url(' + img.src + ')'
        loupe.style.backgroundSize = (window.innerWidth * Z) + 'px ' + (window.innerHeight * Z) + 'px'
        loupe.style.backgroundPosition = (-(e.clientX * Z) + 60) + 'px ' + (-(e.clientY * Z) + 60) + 'px'
      })
      document.addEventListener('mousedown', (e) => {
        const p = pixelAt(e)
        window.sticki.eyedropperResult(p ? p.hex : null)
      })
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') window.sticki.eyedropperResult(null)
      })
    <\/script></body></html>`
    // display↔source matching: display_id first; otherwise closest aspect ratio among the
    // UNUSED sources (the enumeration order of getSources does not always match
    // getAllDisplays — that's how the third monitor ended up without a picker)
    const usedSources = new Set<string>()
    const pickSource = (disp: Electron.Display): Electron.DesktopCapturerSource | undefined => {
      let hit = sources.find((s2) => !usedSources.has(s2.id) && String(s2.display_id) === String(disp.id))
      if (!hit) {
        const ar = disp.bounds.width / disp.bounds.height
        let bestD = Infinity
        for (const s2 of sources) {
          if (usedSources.has(s2.id)) continue
          const sz = s2.thumbnail.getSize()
          const d = Math.abs(sz.width / Math.max(1, sz.height) - ar)
          if (d < bestD) {
            bestD = d
            hit = s2
          }
        }
      }
      if (hit) usedSources.add(hit.id)
      return hit
    }
    displays.forEach((disp) => {
      const src = pickSource(disp)
      if (!src) return
      const win = new BrowserWindow({
        x: disp.bounds.x,
        y: disp.bounds.y,
        width: disp.bounds.width,
        height: disp.bounds.height,
        frame: false,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        backgroundColor: '#000000', // no white flash before the screenshot paints
        webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: false }
      })
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setBounds(disp.bounds)
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pageFor(src.thumbnail.toDataURL())))
      win.once('ready-to-show', () => {
        win.show()
        win.setBounds(disp.bounds)
      })
      // safety net: data-URL pages occasionally skip ready-to-show — show anyway
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) {
          win.show()
          win.setBounds(disp.bounds)
        }
      }, 600)
      wins.push(win)
    })
    return await new Promise<string | null>((resolve) => {
      eyedropperResolve = (hex) => {
        resolve(hex)
        closeAll()
      }
      for (const w of wins) {
        w.on('closed', () => {
          if (wins.every((x) => x.isDestroyed()) && eyedropperResolve) {
            eyedropperResolve = null
            resolve(null)
          }
        })
      }
    })
  })

  ipcMain.handle('window:suspendAlwaysOnTop', (e) => {
    suspendedOnTop = BrowserWindow.getAllWindows().filter((w) => w.isAlwaysOnTop())
    for (const w of suspendedOnTop) w.setAlwaysOnTop(false)
    // the WINDOW THAT PICKS goes topmost: Chromium's eyedropper loupe is owned by it, so
    // this keeps the loupe above every other chat window (it used to vanish behind them)
    eyedropperWin = BrowserWindow.fromWebContents(e.sender)
    eyedropperWin?.setAlwaysOnTop(true, 'screen-saver')
  })
  ipcMain.handle('window:resumeAlwaysOnTop', () => {
    if (eyedropperWin && !eyedropperWin.isDestroyed()) eyedropperWin.setAlwaysOnTop(false)
    eyedropperWin = null
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
  ipcMain.handle('overlay:push', (_e, channel: string, line: OverlayLine) => {
    if (line && typeof line === 'object') overlayPush(channel, line)
  })
  ipcMain.handle('overlay:delete', (_e, channel: string, del: OverlayDelete) => {
    overlayDelete(channel, del ?? {})
  })
  ipcMain.handle('overlay:restart', () => {
    overlayRestart()
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
