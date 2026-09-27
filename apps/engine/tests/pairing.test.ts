import { describe, expect, it } from 'vitest'
import type { PairClaimResponse, PairRequestResponse } from '@sublight/protocol'
import { DEV_EXTENSION_ID } from '@sublight/protocol'
import { createApp } from '../src/app'
import type { EngineConfig } from '../src/config'
import { PairingStore } from '../src/pairing'

const config = {
  token: 'p'.repeat(64),
  port: 17421,
  allowedOrigins: [],
  player: { port: 17420 },
  devOrigins: true,
} as unknown as EngineConfig
const EXT = `chrome-extension://${DEV_EXTENSION_ID}`
const SELF = 'http://127.0.0.1:17421'
const post = (app: ReturnType<typeof createApp>, path: string, origin: string, body: object) =>
  app.request(path, {
    method: 'POST',
    headers: { host: '127.0.0.1:17421', origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('one-click pairing (ADR-0022)', () => {
  it('asks, gets approved on the engine page, and hands the token over once', async () => {
    const app = createApp(config)
    const asked = (await (
      await post(app, '/v1/pair/request', EXT, {})
    ).json()) as PairRequestResponse
    expect(asked.code).toMatch(/^\d{4}$/)
    expect(asked.approveUrl).toBe(`${SELF}/pair?request=${asked.requestId}`)

    const page = await app.request(`/pair?request=${asked.requestId}`, {
      headers: { host: '127.0.0.1:17421' },
    })
    const html = await page.text()
    expect(html).toContain(asked.code)
    expect(html).toContain('sublight browser extension')
    expect(page.headers.get('x-frame-options')).toBe('DENY')

    const pending = (await (
      await post(app, '/v1/pair/claim', EXT, { requestId: asked.requestId })
    ).json()) as PairClaimResponse
    expect(pending).toEqual({ state: 'pending' })

    // Another website can't approve: only the engine's own page can.
    expect(
      (
        await post(app, '/v1/pair/decide', 'https://evil.test', {
          requestId: asked.requestId,
          approve: true,
        })
      ).status,
    ).toBe(403)
    expect(
      (await post(app, '/v1/pair/decide', SELF, { requestId: asked.requestId, approve: true }))
        .status,
    ).toBe(200)

    // Only the origin that asked can claim, and only once.
    expect(
      (await post(app, '/v1/pair/claim', 'http://localhost:5173', { requestId: asked.requestId }))
        .status,
    ).toBe(404)
    const got = (await (
      await post(app, '/v1/pair/claim', EXT, { requestId: asked.requestId })
    ).json()) as PairClaimResponse
    expect(got).toEqual({ state: 'approved', token: config.token })
    const again = (await (
      await post(app, '/v1/pair/claim', EXT, { requestId: asked.requestId })
    ).json()) as PairClaimResponse
    expect(again).toEqual({ state: 'claimed' })
  })

  it('refuses requests from unknown sites and expires old ones', async () => {
    const app = createApp(config)
    expect((await post(app, '/v1/pair/request', 'https://evil.test', {})).status).toBe(403)
    const store = new PairingStore()
    const r = store.request(EXT, 0)
    expect(store.get(r.id, 4 * 60 * 1000)).not.toBeNull()
    expect(store.get(r.id, 6 * 60 * 1000)).toBeNull()
  })

  it('lets the Player the engine serves pair, from its own origin', async () => {
    const app = createApp(config)
    const res = await post(app, '/v1/pair/request', 'http://127.0.0.1:17420', {})
    expect(res.status).toBe(200)
    const { requestId } = (await res.json()) as { requestId: string }
    const page = await app.request(`/pair?request=${requestId}`, {
      headers: { host: '127.0.0.1:17421' },
    })
    expect(await page.text()).toContain('The Sublight Player')
  })
})
