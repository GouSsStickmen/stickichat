export interface StickiApi {
  encrypt(plain: string): Promise<string>
  decrypt(stored: string): Promise<string | null>
  getConfig(): Promise<unknown>
  /** expand asset references back into data URLs — for export only */
  inlineAssets(value: unknown): Promise<unknown>
  setConfig(cfg: unknown): Promise<boolean>
  openExternal(url: string): Promise<void>
  pickScreenColor(): Promise<string | null>
  eyedropperResult(hex: string | null): void
  getVersion(): Promise<string>
  detach(hash: string): Promise<void>
  reattach(payload: string): Promise<void>
  onReattach(cb: (payload: string) => void): () => void
  openEmotePickerWindow(hash: string): Promise<void>
  /** the stream player in its own window — deliberately not a child, so it can live on another monitor */
  openStreamWindow(hash: string): Promise<void>
  /** port of the local one-page server that hosts the Twitch embed SDK (starts on first ask) */
  playerPort(): Promise<number>
  /** open twitch.tv/login in the PLAYER's cookie jar; nothing is read back out of it */
  twitchSignIn(): Promise<void>
  /** clear that jar */
  twitchSignOut(): Promise<void>
  /** the detached stream window asking the chat to take the player back, then closing itself */
  returnStream(channel: string): Promise<void>
  onReturnStream(cb: (channel: string) => void): () => void
  openSettingsWindow(hash: string): Promise<void>
  openWhispersWindow(hash: string): Promise<void>
  openHighlightsWindow(hash: string): Promise<void>
  openUserCardWindow(hash: string): Promise<void>
  sendEmotePick(payload: string): Promise<void>
  onEmotePicked(cb: (payload: string) => void): () => void
  setAlwaysOnTop(flag: boolean): Promise<void>
  setImageAnimation(enabled: boolean): Promise<void>
  setZoom(factor: number): Promise<void>
  diagReport(): Promise<string>
  diagTail(lines?: number): Promise<string>
  diagOpenFolder(): Promise<string>
  diagLog(level: 'info' | 'warn' | 'error', source: string, message: string): Promise<void>
  suspendAlwaysOnTop(): Promise<void>
  resumeAlwaysOnTop(): Promise<void>
  focusSelf(): Promise<void>
  jumpToMessage(payload: string): Promise<void>
  onJumpTo(cb: (payload: string) => void): () => void
  overlayConfigure(enabled: boolean, port: number, style?: unknown): Promise<void>
  overlayPush(channel: string, line: unknown): Promise<void>
  openOverlayEditor(overlayId: string): Promise<void>
  overlayRestart(): Promise<void>
  /** how many OBS browser sources are connected to each overlay id right now */
  overlayClients(): Promise<Record<string, number>>
  overlayDelete(channel: string, del: { id?: string; user?: string; all?: boolean }): Promise<void>
  closeWindow(): Promise<void>
  notifyConfigChanged(): Promise<void>
  onConfigChanged(cb: () => void): () => void
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  onUpdateStatus(cb: (status: unknown) => void): () => void
  copyText(text: string): Promise<void>
  fetchJson(
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<{
    ok: boolean
    status: number
    json: unknown
    text: string
    contentType: string
    /** rate-limit headers only (ratelimit-remaining/reset, retry-after) */
    headers: Record<string, string>
  }>
}

declare global {
  interface Window {
    sticki: StickiApi
  }
}

export {}
