import { host } from './platform'

export interface HttpResponse {
  ok: boolean
  status: number
  json: unknown
  text: string
  /** rate-limit headers the main process forwards: ratelimit-remaining/reset, retry-after */
  headers?: Record<string, string>
}

/**
 * How long to wait before retrying, in ms, according to the server itself.
 *
 * Twitch answers with `Ratelimit-Reset` (a unix SECOND, not a delay) and sometimes `Retry-After`
 * (a delay in seconds). Returns 0 when the response says nothing — the caller then falls back to
 * its own backoff.
 */
export function retryAfterMs(res: HttpResponse, now = Date.now()): number {
  const h = res.headers ?? {}
  const after = Number(h['retry-after'])
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 15 * 60_000)
  const reset = Number(h['ratelimit-reset'])
  if (Number.isFinite(reset) && reset > 0) {
    const ms = reset * 1000 - now
    if (ms > 0) return Math.min(ms, 15 * 60_000)
  }
  return 0
}

/**
 * All HTTP goes through the host, which answers it from native code.
 *
 * That is not a preference: 7TV, BTTV, FFZ and the link unfurler do not send the headers a page
 * would need, so a plain fetch reaches none of them. The host is Electron's main process on the
 * desktop and Capacitor's native HTTP on Android — same contract, no CORS either way.
 */
export function httpGet(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
  return host().request(url, { headers })
}

export function httpJson(
  method: string,
  url: string,
  headers?: Record<string, string>,
  body?: unknown
): Promise<HttpResponse> {
  return host().request(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

export function httpForm(
  url: string,
  form: Record<string, string>,
  headers?: Record<string, string>
): Promise<HttpResponse> {
  return host().request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString()
  })
}
