export interface HttpResponse {
  ok: boolean
  status: number
  json: unknown
  text: string
}

/** All HTTP goes through the Electron main process (no CORS restrictions there). */
export function httpGet(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
  return window.sticki.fetchJson(url, { headers })
}

export function httpJson(
  method: string,
  url: string,
  headers?: Record<string, string>,
  body?: unknown
): Promise<HttpResponse> {
  return window.sticki.fetchJson(url, {
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
  return window.sticki.fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString()
  })
}
