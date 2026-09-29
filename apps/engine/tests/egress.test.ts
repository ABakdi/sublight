import { spawnSync } from 'node:child_process'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configureEgress, EgressProxy, guardedFetch } from '../src/media/egress'
import { run } from '../src/media/ffmpeg'

/**
 * Security pass 2, S3: media traffic reaches only public addresses, checked
 * at each connection (a name that changes its answer, a redirect, an HLS
 * segment), not once up front.
 */
const hasFfmpeg = spawnSync('ffprobe', ['-version']).status === 0

describe('egress to the internet only', () => {
  let local: Server
  let port = 0
  const proxy = new EgressProxy()

  beforeAll(async () => {
    local = createServer((req, res) => {
      if (req.url === '/hop') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end('local secret')
    })
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r))
    port = (local.address() as AddressInfo).port
    await proxy.start()
  })
  afterAll(() => {
    local.close()
    proxy.stop()
    configureEgress({ allowPrivate: false })
  })

  it('refuses private addresses, by literal and by name', async () => {
    configureEgress({ allowPrivate: false })
    await expect(guardedFetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
      code: 'MEDIA_UNREACHABLE',
    })
    // A name that resolves to this computer (what DNS rebinding turns a public name into).
    await expect(guardedFetch(`http://localhost:${port}/`)).rejects.toMatchObject({
      code: 'MEDIA_UNREACHABLE',
    })
  })

  it('follows redirects itself, so each hop is checked', async () => {
    configureEgress({ allowPrivate: true })
    const res = await guardedFetch(`http://127.0.0.1:${port}/hop`)
    expect(await res.text()).toBe('local secret') // allowed here: allowPrivateNetworks
    configureEgress({ allowPrivate: false })
  })

  it('the proxy refuses to tunnel or forward to private addresses', async () => {
    const tunnel = await new Promise<string>((resolve) => {
      const s = connect(Number(new URL(proxy.url!).port), '127.0.0.1', () =>
        s.write(`CONNECT localhost:${port} HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`),
      )
      s.once('data', (d) => {
        resolve(d.toString().split('\r\n')[0]!)
        s.destroy()
      })
    })
    expect(tunnel).toBe('HTTP/1.1 403 Forbidden')
    const forwarded = await new Promise<number>((resolve) => {
      const u = new URL(proxy.url!)
      request(
        { host: u.hostname, port: u.port, path: `http://127.0.0.1:${port}/`, method: 'GET' },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      ).end()
    })
    expect(forwarded).toBe(403)
  })

  it.skipIf(!hasFfmpeg)('ffprobe through the proxy can’t read a local server', async () => {
    // Async: the proxy runs in this process and must keep answering.
    const r = await run(
      'ffprobe',
      ['-v', 'error', '-http_proxy', proxy.url!, `http://127.0.0.1:${port}/`],
      20_000,
    )
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/403|Forbidden/)
  })
})

describe('private address ranges (security pass 2, S9)', () => {
  it('refuses IPv4 hidden in IPv6: compatible, NAT64, 6to4', async () => {
    const { isPrivateAddress } = await import('../src/media/net')
    for (const a of ['::7f00:1', '::1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fec0::1', '100::1'])
      expect(isPrivateAddress(a), a).toBe(true)
    for (const a of ['2606:4700::6810:84e5', '8.8.8.8']) expect(isPrivateAddress(a), a).toBe(false)
  })
})

describe('the proxy under bad input (security review R1, R2)', () => {
  it('answers a CONNECT to an impossible port instead of crashing', async () => {
    const proxy = new EgressProxy()
    await proxy.start()
    const line = await new Promise<string>((resolve) => {
      const s = connect(Number(new URL(proxy.url!).port), '127.0.0.1', () =>
        s.write('CONNECT example.com:99999 HTTP/1.1\r\nHost: example.com:99999\r\n\r\n'),
      )
      s.once('data', (d) => {
        resolve(d.toString().split('\r\n')[0]!)
        s.destroy()
      })
    })
    expect(line).toBe('HTTP/1.1 400 Bad Request')
    // Still serving.
    expect(proxy.url).not.toBeNull()
    proxy.stop()
  })

  it('starts ffmpeg and yt-dlp without the user’s proxy settings', async () => {
    const { mediaEnv } = await import('../src/media/egress')
    process.env.no_proxy = 'localhost,127.0.0.1'
    process.env.HTTPS_PROXY = 'http://elsewhere:3128'
    const env = mediaEnv()
    expect(env.no_proxy).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.PATH).toBe(process.env.PATH)
    delete process.env.no_proxy
    delete process.env.HTTPS_PROXY
  })
})
