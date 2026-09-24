import { test, expect } from '@playwright/test'
import { E2E_ENGINE_URL, E2E_TOKEN } from '../constants'

test.describe('engine skeleton (M00.4)', () => {
  test('health requires the bearer token and reports online', async ({ request }) => {
    const denied = await request.get(`${E2E_ENGINE_URL}/v1/health`)
    expect(denied.status()).toBe(401)

    const ok = await request.get(`${E2E_ENGINE_URL}/v1/health`, {
      headers: { authorization: `Bearer ${E2E_TOKEN}` },
    })
    expect(ok.status()).toBe(200)
    const body = (await ok.json()) as { status: string; version: string; engineUptimeMs: number }
    expect(body.status).toBe('online')
    expect(typeof body.engineUptimeMs).toBe('number')
  })

  test('version endpoint advertises protocol 1', async ({ request }) => {
    const res = await request.get(`${E2E_ENGINE_URL}/v1/version`, {
      headers: { authorization: `Bearer ${E2E_TOKEN}` },
    })
    expect(res.status()).toBe(200)
    expect(((await res.json()) as { protocol: number }).protocol).toBe(1)
  })
})
