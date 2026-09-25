import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { EventBus } from '../src/events'
import { attachWebSocket } from '../src/ws'

const TOKEN = 't'.repeat(64)
const bus = new EventBus()
let server: Server
let port = 0

beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(404).end())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  attachWebSocket(server, { port, token: TOKEN, origins: new Set(['http://localhost:5173']), bus })
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

function connect(headers: Record<string, string> = {}): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers })
}

function collect(ws: WebSocket) {
  const messages: { type: string; [k: string]: unknown }[] = []
  ws.on('message', (d) => messages.push(JSON.parse(String(d)) as { type: string }))
  return messages
}

const closed = (ws: WebSocket) =>
  new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
const opened = (ws: WebSocket) => new Promise<void>((resolve) => ws.on('open', () => resolve()))
const until = async (check: () => boolean) => {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('WS event stream (Spec 03 §4)', () => {
  it('authenticates with the first message and then streams events', async () => {
    const ws = connect()
    const msgs = collect(ws)
    await opened(ws)
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))
    await until(() => msgs.some((m) => m.type === 'auth.ok'))
    bus.emit({ type: 'job.progress', jobId: 'j1', progress: 0.5 })
    await until(() => msgs.some((m) => m.type === 'job.progress'))
    ws.close()
  })

  it('closes a socket that sends a wrong token', async () => {
    const ws = connect()
    const msgs = collect(ws)
    await opened(ws)
    ws.send(JSON.stringify({ type: 'auth', token: 'nope' }))
    expect(await closed(ws)).toBe(4401)
    expect(msgs[0]).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' })
  })

  it('drops an unauthenticated socket within about a second', async () => {
    const ws = connect()
    const started = Date.now()
    await opened(ws)
    expect(await closed(ws)).toBe(4401)
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('refuses upgrades from a foreign Origin or a rebound Host', async () => {
    const foreign = connect({ origin: 'https://evil.example' })
    await expect(new Promise((_, reject) => foreign.on('error', reject))).rejects.toThrow(/403/)
    const rebound = connect({ host: `evil.example:${port}` })
    await expect(new Promise((_, reject) => rebound.on('error', reject))).rejects.toThrow(/403/)
  })

  it('filters job events to subscribed jobs but keeps engine/model events', async () => {
    const ws = connect()
    const msgs = collect(ws)
    await opened(ws)
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))
    await until(() => msgs.some((m) => m.type === 'auth.ok'))
    ws.send(JSON.stringify({ type: 'subscribe', jobIds: ['mine'] }))
    await new Promise((r) => setTimeout(r, 50))
    bus.emit({ type: 'job.progress', jobId: 'other', progress: 0.1 })
    bus.emit({ type: 'job.progress', jobId: 'mine', progress: 0.2 })
    bus.emit({ type: 'model.state', modelId: 'whisper-small', state: 'installed' })
    await until(() => msgs.some((m) => m.type === 'model.state'))
    const jobIds = msgs.filter((m) => m.type === 'job.progress').map((m) => m.jobId)
    expect(jobIds).toEqual(['mine'])
    ws.close()
  })
})
