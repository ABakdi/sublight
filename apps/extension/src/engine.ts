import { browser } from 'wxt/browser'
import {
  ENGINE_BASE_URL,
  NATIVE_HOST_NAME,
  type ErrorEnvelope,
  type NativeCommand,
  type NativeResponse,
  type PairClaimResponse,
  type PairRequestResponse,
  type VersionResponse,
} from '@sublight/protocol'
import type { EngineStatus } from './messages'

/** A token pasted or paired by hand (Settings → Advanced): storage.local. */
export const TOKEN_KEY = 'engineToken'
/**
 * The token the native host hands over (M06b.3). storage.session: content
 * scripts can't read it (security pass 2, S1), and it's fetched again after a
 * browser restart.
 */
export const HOST_TOKEN_KEY = 'engineTokenFromHost'
/** Set while the engine is being started, for the popup's "Starting…". */
export const ENGINE_STARTING_KEY = 'engineStarting'

/**
 * Ask the native host install.sh registered (`sublight-engine native-host`).
 * null when it isn't installed, or doesn't answer.
 */
export async function native(command: NativeCommand): Promise<NativeResponse | null> {
  try {
    const r = (await browser.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      command,
    })) as NativeResponse | undefined
    return r ?? null
  } catch {
    return null
  }
}

/** The engine's current token, from the native host; null without one. */
export async function tokenFromHost(): Promise<string | null> {
  const r = await native('token')
  if (!r?.ok || r.command !== 'token') return null
  await browser.storage.session.set({ [HOST_TOKEN_KEY]: r.token })
  return r.token
}

export async function getToken(): Promise<string | null> {
  const session = await browser.storage.session.get(HOST_TOKEN_KEY)
  if (typeof session[HOST_TOKEN_KEY] === 'string' && session[HOST_TOKEN_KEY])
    return session[HOST_TOKEN_KEY]
  const got = await browser.storage.local.get(TOKEN_KEY)
  const token = got[TOKEN_KEY]
  if (typeof token === 'string' && token) return token
  return tokenFromHost()
}

let starting: Promise<boolean> | null = null

/** Start the engine through the native host (M06b.4); false when that isn't possible. */
export function startEngine(): Promise<boolean> {
  starting ??= (async () => {
    await browser.storage.session.set({ [ENGINE_STARTING_KEY]: true })
    try {
      const r = await native('start')
      return !!r?.ok
    } finally {
      await browser.storage.session.remove(ENGINE_STARTING_KEY)
      starting = null
    }
  })()
  return starting
}

/** Stop the engine through the native host (the popup's switch). */
export async function stopEngine(): Promise<boolean> {
  const r = await native('stop')
  return !!r?.ok
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
  if ((await browser.storage.session.get(ENGINE_STARTING_KEY))[ENGINE_STARTING_KEY])
    return { state: 'starting' }
  const bearer = token ?? (await getToken())
  if (!bearer) return { state: 'no-token' }
  const ask = (t: string) =>
    fetch(`${ENGINE_BASE_URL}/v1/version`, {
      headers: { authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  let res: Response
  try {
    res = await ask(bearer)
  } catch (err) {
    // Installed but off: it starts by itself when something needs it.
    const host = await native('status')
    if (host?.ok) return { state: 'stopped' }
    return { state: 'offline', detail: err instanceof Error ? err.message : String(err) }
  }
  if (res.status === 401 && token === undefined) {
    // The token was replaced: the native host knows the new one.
    const fresh = await tokenFromHost()
    if (fresh && fresh !== bearer) res = await ask(fresh).catch(() => res)
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
      'sublight isn’t installed on this computer yet: run install.sh (or pair in Settings).',
      0,
    )
  const send = (t: string) =>
    fetch(`${ENGINE_BASE_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${t}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    }).catch(() => null)
  let res = await send(token)
  // Off (idle, or not started yet): start it and try again (M06b.4).
  if (!res && (await startEngine())) res = await send(token)
  if (!res)
    throw new EngineRequestError('OFFLINE', 'The engine isn’t running and couldn’t be started.', 0)
  if (res.status === 401) {
    const fresh = await tokenFromHost()
    if (fresh && fresh !== token) res = (await send(fresh)) ?? res
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

/** Where one-click pairing is (storage.session), for the popup and Options to show. */
export const PAIRING_KEY = 'pairing'
export interface PairingStatus {
  state: 'waiting' | 'paired' | 'denied' | 'failed'
  /** Shown here and on the engine's page: the same code means the same request. */
  code?: string
  error?: string
}

let pairing: Promise<void> | null = null

/**
 * One-click pairing (ADR-0022), run by the service worker (a popup closes
 * when the approval tab opens): ask the engine, open its approval page, wait
 * up to 5 minutes for the approval, then keep the token.
 */
export function pairWithEngine(): Promise<void> {
  pairing ??= run().finally(() => (pairing = null))
  return pairing
  async function run() {
    const save = (status: PairingStatus) => browser.storage.session.set({ [PAIRING_KEY]: status })
    let asked: PairRequestResponse
    try {
      const res = await fetch(`${ENGINE_BASE_URL}/v1/pair/request`, { method: 'POST' })
      if (!res.ok) throw new Error(`the engine answered HTTP ${res.status}`)
      asked = (await res.json()) as PairRequestResponse
    } catch (err) {
      await save({
        state: 'failed',
        error: `The engine isn’t reachable (${err instanceof Error ? err.message : String(err)}). Start it, then try again.`,
      })
      return
    }
    await save({ state: 'waiting', code: asked.code })
    await browser.tabs.create({ url: asked.approveUrl })
    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000))
      const res = await fetch(`${ENGINE_BASE_URL}/v1/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: asked.requestId }),
      }).catch(() => null)
      if (!res) continue
      if (res.status === 404) break
      const claim = (await res.json()) as PairClaimResponse
      if (claim.token) {
        await setToken(claim.token)
        await save({ state: 'paired' })
        return
      }
      if (claim.state === 'denied') {
        await save({ state: 'denied' })
        return
      }
    }
    await save({ state: 'failed', error: 'No approval arrived in time. Start pairing again.' })
  }
}
