import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import type { EngineConfig } from '../src/config'

const config: EngineConfig = {
  token: 'a'.repeat(64),
  port: 17421,
  defaults: { asrModel: 'whisper-small', translateModel: 'qwen2.5-3b-instruct' },
  autoRetry: true,
  cacheLimits: { mediaBytes: 20 * 1024 ** 3 },
}

const HOST = { host: '127.0.0.1:17421' } as const

describe('engine auth + health (Protocol §2-§3)', () => {
  const app = createApp(config)

  it('rejects /v1/health without a token (401 UNAUTHORIZED)', async () => {
    const res = await app.request('/v1/health', { headers: HOST })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('rejects a wrong token', async () => {
    const res = await app.request('/v1/health', {
      headers: { ...HOST, authorization: 'Bearer ' + 'b'.repeat(64) },
    })
    expect(res.status).toBe(401)
  })

  it('rejects a non-loopback Host header (403 BAD_ORIGIN)', async () => {
    const res = await app.request('/v1/health', {
      headers: { host: 'evil.example.com', authorization: 'Bearer ' + config.token },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('BAD_ORIGIN')
  })

  it('returns { status: "online" } with the token', async () => {
    const res = await app.request('/v1/health', {
      headers: { ...HOST, authorization: `Bearer ${config.token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; version: string; engineUptimeMs: number }
    expect(body.status).toBe('online')
    expect(typeof body.version).toBe('string')
    expect(body.engineUptimeMs).toBeGreaterThanOrEqual(0)
  })

  it('exposes /v1/version with the protocol version', async () => {
    const res = await app.request('/v1/version', {
      headers: { ...HOST, authorization: `Bearer ${config.token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { engine: string; protocol: number }
    expect(body.protocol).toBe(1)
  })

  it('leaves /v1/pair/info unauthenticated (presence probe only)', async () => {
    const res = await app.request('/v1/pair/info', { headers: HOST })
    expect(res.status).toBe(200)
    expect((await res.json()) as { requiresToken: boolean }).toEqual({ requiresToken: true })
  })

  it('answers OPTIONS preflight with the allowlisted origin', async () => {
    const res = await app.request('/v1/health', {
      method: 'OPTIONS',
      headers: { ...HOST, origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('does not allow foreign origins', async () => {
    const res = await app.request('/v1/health', {
      headers: { ...HOST, origin: 'https://evil.example', authorization: `Bearer ${config.token}` },
    })
    expect(res.status).toBe(403)
  })

  it('returns a JSON error envelope for unknown routes', async () => {
    const res = await app.request('/v1/nope', {
      headers: { ...HOST, authorization: `Bearer ${config.token}` },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })
})
