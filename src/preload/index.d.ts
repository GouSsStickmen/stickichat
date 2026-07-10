export interface StickiApi {
  encrypt(plain: string): Promise<string>
  decrypt(stored: string): Promise<string | null>
  getConfig(): Promise<unknown>
  setConfig(cfg: unknown): Promise<boolean>
  openExternal(url: string): Promise<void>
  getVersion(): Promise<string>
  detach(hash: string): Promise<void>
  reattach(payload: string): Promise<void>
  onReattach(cb: (payload: string) => void): () => void
  openEmotePickerWindow(hash: string): Promise<void>
  openSettingsWindow(hash: string): Promise<void>
  openUserCardWindow(hash: string): Promise<void>
  sendEmotePick(payload: string): Promise<void>
  onEmotePicked(cb: (payload: string) => void): () => void
  setAlwaysOnTop(flag: boolean): Promise<void>
  closeWindow(): Promise<void>
  notifyConfigChanged(): Promise<void>
  onConfigChanged(cb: () => void): () => void
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  onUpdateStatus(cb: (status: unknown) => void): () => void
  fetchJson(
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<{ ok: boolean; status: number; json: unknown; text: string }>
}

declare global {
  interface Window {
    sticki: StickiApi
  }
}

export {}
