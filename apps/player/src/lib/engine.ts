import type { HealthResponse } from '@sublight/protocol'

const ENGINE_URL_KEY = 'sublight.engineUrl'
const TOKEN_KEY = 'sublight.token'
export const DEFAULT_ENGINE_URL = 'http://127.0.0.1:17421'

export function engineBaseUrl(): string {
  return localStorage.getItem(ENGINE_URL_KEY) ?? DEFAULT_ENGINE_URL
}

export function engineToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export interface HealthResult {
  state: 'online' | 'offline'
  health?: HealthResponse
  error?: string
}

/** Bail out quickly when the engine isn't running (spec 04 §8). */
export async function fetchEngineHealth(timeoutMs = 1500): Promise<HealthResult> {
  const token = engineToken()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  try {
    const res = await fetch(`${engineBaseUrl()}/v1/health`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { state: 'offline', error: `HTTP ${res.status}` }
    const health = (await res.json()) as HealthResponse
    return { state: 'online', health }
  } catch (err) {
    return { state: 'offline', error: err instanceof Error ? err.message : String(err) }
  }
}
