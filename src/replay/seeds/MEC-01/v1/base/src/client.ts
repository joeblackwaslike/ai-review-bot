export interface ClientOptions {
  baseUrl: string
  timeoutMs: number
  headers: Record<string, string>
}

export const defaultOptions: ClientOptions = {
  baseUrl: 'https://api.example.com/v2',
  timeoutMs: 30000,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
}

export async function request(path: string, opts: Partial<ClientOptions> = {}) {
  const o = { ...defaultOptions, ...opts }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs)
  try {
    const res = await fetch(o.baseUrl + path, { headers: o.headers, signal: ctrl.signal })
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}
