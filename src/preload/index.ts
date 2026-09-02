import { contextBridge, ipcRenderer } from 'electron'

const api = {
  encrypt: (plain: string): Promise<string> => ipcRenderer.invoke('secure:encrypt', plain),
  decrypt: (stored: string): Promise<string | null> => ipcRenderer.invoke('secure:decrypt', stored),
  getConfig: (): Promise<unknown> => ipcRenderer.invoke('config:get'),
  setConfig: (cfg: unknown): Promise<boolean> => ipcRenderer.invoke('config:set', cfg),
  inlineAssets: (value: unknown): Promise<unknown> => ipcRenderer.invoke('config:inline', value),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
  pickScreenColor: (): Promise<string | null> => ipcRenderer.invoke('eyedropper:pick'),
  eyedropperResult: (hex: string | null): void => ipcRenderer.send('eyedropper:result', hex),
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  detach: (hash: string): Promise<void> => ipcRenderer.invoke('app:detach', hash),
  reattach: (payload: string): Promise<void> => ipcRenderer.invoke('app:reattach', payload),
  onReattach: (cb: (payload: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: string): void => cb(payload)
    ipcRenderer.on('app:reattach', listener)
    return () => ipcRenderer.removeListener('app:reattach', listener)
  },
  openEmotePickerWindow: (hash: string): Promise<void> => ipcRenderer.invoke('app:openEmotePicker', hash),
  openStreamWindow: (hash: string, lockAspect?: boolean): Promise<void> =>
    ipcRenderer.invoke('app:openStream', hash, lockAspect),
  playerPort: (): Promise<number> => ipcRenderer.invoke('player:port'),
  extLoad: (paths: string[]): Promise<{ loaded: { name: string; version: string; path: string }[]; failed: { path: string; error: string }[] }> =>
    ipcRenderer.invoke('ext:load', paths),
  extPick: (): Promise<string | null> => ipcRenderer.invoke('ext:pick'),
  extRemove: (path: string): Promise<void> => ipcRenderer.invoke('ext:remove', path),
  twitchSignIn: (): Promise<void> => ipcRenderer.invoke('app:twitchSignIn'),
  twitchSignOut: (): Promise<void> => ipcRenderer.invoke('app:twitchSignOut'),
  returnStream: (channel: string): Promise<void> => ipcRenderer.invoke('app:returnStream', channel),
  onReturnStream: (cb: (channel: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, channel: string): void => cb(channel)
    ipcRenderer.on('app:returnStream', listener)
    return () => ipcRenderer.removeListener('app:returnStream', listener)
  },
  openSettingsWindow: (hash: string): Promise<void> => ipcRenderer.invoke('app:openSettings', hash),
  openWhispersWindow: (hash: string): Promise<void> => ipcRenderer.invoke('app:openWhispers', hash),
  openHighlightsWindow: (hash: string): Promise<void> => ipcRenderer.invoke('app:openHighlights', hash),
  openUserCardWindow: (hash: string): Promise<void> => ipcRenderer.invoke('app:openUserCard', hash),
  sendEmotePick: (payload: string): Promise<void> => ipcRenderer.invoke('app:sendEmotePick', payload),
  onEmotePicked: (cb: (payload: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: string): void => cb(payload)
    ipcRenderer.on('app:emotePicked', listener)
    return () => ipcRenderer.removeListener('app:emotePicked', listener)
  },
  setAlwaysOnTop: (flag: boolean): Promise<void> => ipcRenderer.invoke('window:setAlwaysOnTop', flag),
  setImageAnimation: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('window:setImageAnimation', enabled),
  setZoom: (factor: number): Promise<void> => ipcRenderer.invoke('window:setZoom', factor),
  diagReport: (): Promise<string> => ipcRenderer.invoke('diag:report'),
  diagTail: (lines?: number): Promise<string> => ipcRenderer.invoke('diag:tail', lines),
  diagOpenFolder: (): Promise<string> => ipcRenderer.invoke('diag:openFolder'),
  diagLog: (level: 'info' | 'warn' | 'error', source: string, message: string): Promise<void> =>
    ipcRenderer.invoke('diag:log', level, source, message),
  suspendAlwaysOnTop: (): Promise<void> => ipcRenderer.invoke('window:suspendAlwaysOnTop'),
  resumeAlwaysOnTop: (): Promise<void> => ipcRenderer.invoke('window:resumeAlwaysOnTop'),
  focusSelf: (): Promise<void> => ipcRenderer.invoke('window:focusSelf'),
  jumpToMessage: (payload: string): Promise<void> => ipcRenderer.invoke('app:jumpTo', payload),
  onJumpTo: (cb: (payload: string) => void): (() => void) => {
    const listener = (_e: unknown, payload: string): void => cb(payload)
    ipcRenderer.on('app:jumpTo', listener)
    return () => ipcRenderer.removeListener('app:jumpTo', listener)
  },
  overlayConfigure: (enabled: boolean, port: number, style?: unknown): Promise<void> =>
    ipcRenderer.invoke('overlay:configure', enabled, port, style),
  overlayPush: (channel: string, line: unknown): Promise<void> =>
    ipcRenderer.invoke('overlay:push', channel, line),
  openOverlayEditor: (overlayId: string): Promise<void> =>
    ipcRenderer.invoke('app:openOverlayEditor', overlayId),
  overlayDelete: (channel: string, del: { id?: string; user?: string; all?: boolean }): Promise<void> =>
    ipcRenderer.invoke('overlay:delete', channel, del),
  overlayRestart: (): Promise<void> => ipcRenderer.invoke('overlay:restart'),
  overlayClients: (): Promise<Record<string, number>> => ipcRenderer.invoke('overlay:clients'),
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
  /** clipboard through the main process — navigator.clipboard is undefined on file:// */
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  fetchJson: (
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<{
    ok: boolean
    status: number
    json: unknown
    text: string
    contentType: string
    headers: Record<string, string>
  }> => ipcRenderer.invoke('net:fetch', url, options)
}

contextBridge.exposeInMainWorld('sticki', api)

export type StickiApi = typeof api
