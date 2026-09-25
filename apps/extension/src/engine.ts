import { browser } from 'wxt/browser'
import { ENGINE_BASE_URL, type ErrorEnvelope, type VersionResponse } from '@sublight/protocol'
import type { EngineStatus } from './messages'

/** Token lives in storage.local, readable by the SW/popup/options only — never content scripts. */
export const TOKEN_KEY = 'engineToken'

export async function getToken(): Promise<string | null> {
  const got = await browser.storage.local.get(TOKEN_KEY)
  const token = got[TOKEN_KEY]
  return typeof token === 'string' && token ? token : null
}

export async function setToken(token: string): Promise<void> {
  const trimmed = token.trim()
  if (trimmed) await browser.storage.local.set({ [TOKEN_KEY]: trimmed })
  else await browser.storage.local.remove(TOKEN_KEY)
}

/**
 * Probe the engine (Spec 09 §3 engineFetch, reduced to one call for now).
 * `token` overrides the stored one so options can test before saving.
 */
export async function probeEngine(token?: string, timeoutMs = 2000): Promise<EngineStatus> {
  const bearer = token ?? (await getToken())
  if (!bearer) return { state: 'no-token' }
  let res: Response
  try {
    res = await fetch(`${ENGINE_BASE_URL}/v1/version`, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { state: 'offline', detail: err instanceof Error ? err.message : String(err) }
  }
  if (res.status === 401) return { state: 'unauthorized' }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ErrorEnvelope | null
    return { state: 'refused', detail: body?.error.message ?? `HTTP ${res.status}` }
  }
  const version = (await res.json()) as VersionResponse
  return { state: 'online', version: version.engine, protocol: version.protocol }
}

export class EngineRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Authenticated engine call from the SW or an extension page (never content scripts). */
export async function engineRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken()
  if (!token)
    throw new EngineRequestError(
      'NO_TOKEN',
      'Pair the extension with the engine first (Options).',
      0,
    )
  let res: Response
  try {
    res = await fetch(`${ENGINE_BASE_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  } catch {
    throw new EngineRequestError('OFFLINE', 'The engine isn’t running (pnpm dev:engine).', 0)
  }
  if (res.status === 204) return undefined as T
  const body = (await res.json().catch(() => null)) as (T & ErrorEnvelope) | null
  if (!res.ok) {
    throw new EngineRequestError(
      body?.error?.code ?? `HTTP_${res.status}`,
      body?.error?.message ?? `HTTP ${res.status}`,
      res.status,
    )
  }
  return body as T
}
