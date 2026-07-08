import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { initAutoUpdater } from './updater'

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
