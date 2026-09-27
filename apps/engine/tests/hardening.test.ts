import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import type { EngineConfig } from '../src/config'
import { MAX_ACTIVE_DOWNLOADS, relayResponse, RelayStore } from '../src/media/relay'
import { assertPublicUrl, isPrivateAddress } from '../src/media/net'
import { headerArgs } from '../src/media/remote'

/** Security baseline pass 1 fixes (docs/audits/2026-09-Security-Baseline.md). */
const config = {
  token: 'h'.repeat(64),
  port: 17421,
  allowedOrigins: ['http://localhost:3000'],
  player: { port: 17420 },
  devOrigins: false,
} as unknown as EngineConfig
const HOST = { host: '127.0.0.1:17421' }

describe('security baseline fixes', () => {
  let upstream: Server
  let port: number
  beforeAll(async () => {
    upstream = createServer((_req, res) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end('<script>alert(1)</script>'),
    )
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    port = (upstream.address() as AddressInfo).port
  })
  afterAll(() => upstream.close())

  it('A5: a relayed upstream is never served as a page', async () => {
    const res = await relayResponse(
      {
        kind: 'stream',
        media: { input: `http://127.0.0.1:${port}/`, headers: {} },
        expiresAt: Infinity,
      } as never,
      new Request('http://127.0.0.1:17421/v1/relay/x'),
    )
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })

  it('A6: bodies are bounded before they are read', async () => {
    const app = createApp(config)
    const res = await app.request('/v1/pair/claim', {
      method: 'POST',
      headers: { ...HOST, origin: 'http://127.0.0.1:17420', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'x'.repeat(10_000) }),
    })
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BODY_TOO_LARGE')
  })

  it('A8: ffmpeg inputs stay remote and headers stay single', () => {
    const args = headerArgs({ 'user-agent': 'x\r\nX-Evil: 1', cookie: 'secret' })
    expect(args.slice(0, 2)).toEqual([
      '-protocol_whitelist',
      'http,https,tls,tcp,crypto,data,httpproxy',
    ])
    expect(args[3]).toBe('user-agent: x X-Evil: 1\r\n')
    expect(args.join(' ')).not.toContain('secret')
  })

  it('B2: the dev Player port is trusted only when developing', async () => {
    const ask = (app: ReturnType<typeof createApp>, origin: string) =>
      app.request('/v1/pair/request', { method: 'POST', headers: { ...HOST, origin } })
    expect((await ask(createApp(config), 'http://localhost:5173')).status).toBe(403)
    expect(
      (await ask(createApp({ ...config, devOrigins: true }), 'http://localhost:5173')).status,
    ).toBe(200)
  })

  it('B2: only known Players are called the Sublight Player', async () => {
    const app = createApp(config)
    const res = await app.request('/v1/pair/request', {
      method: 'POST',
      headers: { ...HOST, origin: 'http://localhost:3000' },
    })
    const { requestId } = (await res.json()) as { requestId: string }
    const page = await (await app.request(`/pair?request=${requestId}`, { headers: HOST })).text()
    expect(page).toContain('The web page at http://localhost:3000')
    expect(page).not.toContain('The Sublight Player')
  })

  it('A10: page and media URLs can’t reach this computer or the local network', async () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.10',
      '172.20.0.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '0.0.0.0',
    ])
      expect(isPrivateAddress(a), a).toBe(true)
    for (const a of ['8.8.8.8', '2606:4700::1111', '172.32.0.1'])
      expect(isPrivateAddress(a), a).toBe(false)
    await expect(assertPublicUrl('http://localhost:8080/v.mp4', false)).rejects.toMatchObject({
      code: 'MEDIA_UNREACHABLE',
    })
    await expect(assertPublicUrl('http://[::1]/v.mp4', false)).rejects.toMatchObject({
      code: 'MEDIA_UNREACHABLE',
    })
    await expect(assertPublicUrl('http://192.168.0.5/', false)).rejects.toMatchObject({
      code: 'MEDIA_UNREACHABLE',
    })
    await expect(assertPublicUrl('http://192.168.0.5/', true)).resolves.toBeUndefined()
  })

  it('A10: the resolve route refuses a local page URL', async () => {
    const res = await createApp(config, { services: {} as never }).request('/v1/media/resolve', {
      method: 'POST',
      headers: {
        ...HOST,
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pageUrl: 'http://127.0.0.1:9/page' }),
    })
    expect(res.status).toBe(422)
  })

  it('relay downloads are capped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sublight-cap-'))
    const slow = join(dir, 'slow-yt-dlp')
    writeFileSync(slow, '#!/bin/sh\nsleep 3\n')
    chmodSync(slow, 0o755)
    const relays = new RelayStore(join(dir, 'relay'))
    const start = () =>
      relays.download('https://example.com/v', {
        ytDlp: slow,
        ffmpeg: 'ffmpeg',
        title: null,
        durationMs: null,
      })
    for (let i = 0; i < MAX_ACTIVE_DOWNLOADS; i++) start()
    expect(start).toThrow(/already being prepared/)
  })
})
