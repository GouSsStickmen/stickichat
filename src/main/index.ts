import { app, shell, session, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { initAutoUpdater } from './updater'

// The dev build and the installed app resolve to the SAME userData dir (Windows paths are
// case-insensitive), and two Electron instances fight over Chromium's cache locks — the loser
// runs with NO http cache at all ("Unable to create cache: Access is denied"), so every emote
// image re-downloads constantly. Keep the config file shared, but give dev its own session dir.
if (!app.isPackaged) {
  app.setPath('sessionData', join(app.getPath('userData'), 'dev-session'))
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
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
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

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

app.whenReady().then(() => {
  // spellcheck for the message input — Ukrainian + English (Chromium downloads
  // the Hunspell dictionaries on demand)
  try {
    session.defaultSession.setSpellCheckerLanguages(['uk', 'en-US'])
  } catch {
    /* unsupported language on this platform — keep defaults */
  }
  registerIpc()
  createWindow()
  initAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
