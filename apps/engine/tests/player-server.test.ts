import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findPlayerDir, servePlayer } from '../src/player-server'
import type { Server } from 'node:http'

describe('the Player served by the engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sublight-player-'))
  let server: Server
  let port: number
  const get = (path: string, host = `127.0.0.1:${port}`, method = 'GET') =>
    new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: { host } }, (res) => {
        let body = ''
        res.on('data', (c: Buffer) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }))
      })
      req.end()
    })

  beforeAll(async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Player</title>')
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'app-1234.js'), 'console.log(1)')
    writeFileSync(join(tmpdir(), 'secret.txt'), 'nope')
    server = await servePlayer(dir, 0)
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => server.close())

  it('serves files, and index.html for app routes', async () => {
    const js = await get('/assets/app-1234.js')
    expect(js.status).toBe(200)
    expect(js.headers['content-type']).toContain('text/javascript')
    expect(js.headers['cache-control']).toContain('immutable')
    const route = await get('/open#sl=abc')
    expect(route.status).toBe(200)
    expect(route.body).toContain('<title>Player</title>')
    expect(route.headers['cache-control']).toBe('no-cache')
    expect((await get('/assets/missing.js')).status).toBe(404)
  })

  it('stays inside its folder and on loopback names', async () => {
    expect((await get('/../secret.txt')).status).not.toBe(200)
    expect((await get('/%2e%2e/secret.txt')).status).toBe(404) // the URL parser folds it
    expect((await get('/..%2Fsecret.txt')).status).toBe(403)
    expect((await get('/', 'evil.example:80')).status).toBe(403)
    expect((await get('/', `127.0.0.1:${port}`, 'POST')).status).toBe(405)
  })

  it('finds a configured build and ignores one without index.html', () => {
    expect(findPlayerDir(dir)).toBe(dir)
    expect(findPlayerDir(tmpdir() + '/nothing-here')).toBeNull()
  })
})
