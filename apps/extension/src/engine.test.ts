import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeRequest, NativeResponse } from '@sublight/protocol'

/**
 * The extension talks to the engine through install.sh's native host
 * (M06b.3-4): the token comes from it, and the engine is started when off.
 */

const stores = { local: new Map<string, unknown>(), session: new Map<string, unknown>() }
const area = (m: Map<string, unknown>) => ({
  get: async (key: string) => (m.has(key) ? { [key]: m.get(key) } : {}),
  set: async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) m.set(k, v)
  },
  remove: async (key: string) => void m.delete(key),
})
/** The native host: null = not installed. */
let host: ((req: NativeRequest) => NativeResponse) | null = null
const sendNativeMessage = vi.fn(async (_name: string, req: NativeRequest) => {
  if (!host) throw new Error('Specified native messaging host not found.')
  return host(req)
})

vi.mock('wxt/browser', () => ({
  browser: {
    storage: { local: area(stores.local), session: area(stores.session) },
    runtime: {
      sendNativeMessage: (name: string, req: NativeRequest) => sendNativeMessage(name, req),
    },
  },
}))

const { engineRequest, getToken, probeEngine, HOST_TOKEN_KEY, TOKEN_KEY } = await import('./engine')

/** The engine: up or down, accepting one token. */
let engine = { up: false, token: 'A' }
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  if (!engine.up) throw new TypeError('Failed to fetch')
  const auth = (init?.headers as Record<string, string>).authorization
  if (auth !== `Bearer ${engine.token}`)
    return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no' } }), {
      status: 401,
    })
  return new Response(JSON.stringify({ engine: '0.1.0', protocol: 1, ok: true }), { status: 200 })
})
vi.stubGlobal('fetch', fetchMock)

/** An installed host that knows the engine's token and can start it. */
const installedHost = (req: NativeRequest): NativeResponse => {
  switch (req.command) {
    case 'token':
      return { ok: true, command: 'token', token: engine.token, port: 17421 }
    case 'start':
      engine.up = true
      return { ok: true, command: 'start', started: true, port: 17421 }
    case 'status':
      return { ok: true, command: 'status', running: engine.up, version: '0.1.0', port: 17421 }
    default:
      return { ok: false, error: 'no' }
  }
}

beforeEach(() => {
  stores.local.clear()
  stores.session.clear()
  engine = { up: false, token: 'A' }
  host = null
  sendNativeMessage.mockClear()
})

describe('the engine without pairing (M06b.3)', () => {
  it('takes the token from the native host, kept where content scripts can’t read it', async () => {
    host = installedHost
    expect(await getToken()).toBe('A')
    expect(stores.session.get(HOST_TOKEN_KEY)).toBe('A')
    expect(stores.local.has(TOKEN_KEY)).toBe(false)
    // Asked once: the session copy serves later calls.
    await getToken()
    expect(sendNativeMessage).toHaveBeenCalledTimes(1)
  })

  it('follows a replaced token', async () => {
    host = installedHost
    engine.up = true
    stores.local.set(TOKEN_KEY, 'OLD') // paired by hand before
    engine.token = 'B'
    await expect(engineRequest('/v1/models')).resolves.toMatchObject({ ok: true })
    expect(stores.session.get(HOST_TOKEN_KEY)).toBe('B')
    expect((await probeEngine()).state).toBe('online')
  })

  it('without the host or a token, says sublight isn’t installed', async () => {
    await expect(engineRequest('/v1/models')).rejects.toMatchObject({ code: 'NO_TOKEN' })
    expect(await probeEngine()).toEqual({ state: 'no-token' })
  })
})

describe('starting the engine on demand (M06b.4)', () => {
  it('starts an engine that is off, then makes the request', async () => {
    host = installedHost
    expect(await probeEngine()).toEqual({ state: 'stopped' })
    await expect(engineRequest('/v1/models')).resolves.toMatchObject({ ok: true })
    expect(sendNativeMessage).toHaveBeenCalledWith('sublight.engine', { command: 'start' })
    expect((await probeEngine()).state).toBe('online')
  })

  it('reports offline when the engine is off and nothing can start it', async () => {
    stores.local.set(TOKEN_KEY, 'A')
    await expect(engineRequest('/v1/models')).rejects.toMatchObject({ code: 'OFFLINE' })
    expect((await probeEngine()).state).toBe('offline')
  })
})
