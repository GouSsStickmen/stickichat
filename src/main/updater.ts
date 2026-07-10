import { app, ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string; notes: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

function broadcast(status: UpdateStatus): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('updater:status', status)
}

/** release notes arrive as an HTML string (or a list) — flatten to readable plain text */
function notesToText(notes: unknown): string {
  const html = Array.isArray(notes)
    ? notes.map((n) => (typeof n === 'string' ? n : (n?.note ?? ''))).join('\n')
    : typeof notes === 'string'
      ? notes
      : ''
  return html
    .replace(/<li>/gi, '• ')
    .replace(/<\/(li|p|ul|ol|h\d)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function initAutoUpdater(): void {
  // dev builds have no update feed and aren't code-signed — skip entirely
  if (!app.isPackaged) return

  // the USER decides when to download: show version + changelog first
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    broadcast({ state: 'available', version: info.version, notes: notesToText(info.releaseNotes) })
  )
  autoUpdater.on('update-not-available', () => broadcast({ state: 'not-available' }))
  autoUpdater.on('download-progress', (p) => broadcast({ state: 'downloading', percent: p.percent }))
  autoUpdater.on('update-downloaded', (info) => broadcast({ state: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => broadcast({ state: 'error', message: String(err?.message ?? err) }))

  ipcMain.handle('updater:check', () => autoUpdater.checkForUpdates().catch(() => null))
  ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate().catch(() => null))
  ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall())

  // check on startup, then every 2 hours while the app stays open
  autoUpdater.checkForUpdates().catch(() => null)
  setInterval(() => autoUpdater.checkForUpdates().catch(() => null), 2 * 60 * 60 * 1000)
}
