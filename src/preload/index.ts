import { contextBridge, ipcRenderer } from 'electron'

const api = {
  encrypt: (plain: string): Promise<string> => ipcRenderer.invoke('secure:encrypt', plain),
  decrypt: (stored: string): Promise<string | null> => ipcRenderer.invoke('secure:decrypt', stored),
  getConfig: (): Promise<unknown> => ipcRenderer.invoke('config:get'),
  setConfig: (cfg: unknown): Promise<boolean> => ipcRenderer.invoke('config:set', cfg),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  detach: (hash: string): Promise<void> => ipcRenderer.invoke('app:detach', hash),
  reattach: (payload: string): Promise<void> => ipcRenderer.invoke('app:reattach', payload),
  onReattach: (cb: (payload: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: string): void => cb(payload)
    ipcRenderer.on('app:reattach', listener)
    return () => ipcRenderer.removeListener('app:reattach', listener)
  },
  openEmotePickerWindow: (hash: string): Promise<void> => ipcRenderer.invoke('app:openEmotePicker', hash),
  openSettingsWindow: (hash: string): Promise<void> => ipcRenderer.invoke('app:openSettings', hash),
  openUserCardWindow: (hash: string): Promise<void> => ipcRenderer.invoke('app:openUserCard', hash),
  sendEmotePick: (payload: string): Promise<void> => ipcRenderer.invoke('app:sendEmotePick', payload),
  onEmotePicked: (cb: (payload: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: string): void => cb(payload)
    ipcRenderer.on('app:emotePicked', listener)
    return () => ipcRenderer.removeListener('app:emotePicked', listener)
  },
  setAlwaysOnTop: (flag: boolean): Promise<void> => ipcRenderer.invoke('window:setAlwaysOnTop', flag),
  suspendAlwaysOnTop: (): Promise<void> => ipcRenderer.invoke('window:suspendAlwaysOnTop'),
  resumeAlwaysOnTop: (): Promise<void> => ipcRenderer.invoke('window:resumeAlwaysOnTop'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  notifyConfigChanged: (): Promise<void> => ipcRenderer.invoke('app:notifyConfigChanged'),
  onConfigChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('app:configChanged', listener)
    return () => ipcRenderer.removeListener('app:configChanged', listener)
  },
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('updater:check'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('updater:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('updater:install'),
  onUpdateStatus: (cb: (status: unknown) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, status: unknown): void => cb(status)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  },
  fetchJson: (
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<{ ok: boolean; status: number; json: unknown; text: string }> =>
    ipcRenderer.invoke('net:fetch', url, options)
}

contextBridge.exposeInMainWorld('sticki', api)

export type StickiApi = typeof api
