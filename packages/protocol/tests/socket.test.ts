import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineSocket } from '../src/socket'

/** A WebSocket the test drives: what the socket sent, and what the engine answers. */
class FakeWs {
  static OPEN = 1
  static all: FakeWs[] = []
  readyState = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeWs.all.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  message(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
}

describe('the shared engine socket (code quality Q-3: Q3, Q4)', () => {
  beforeEach(() => {
    FakeWs.all = []
    vi.stubGlobal('WebSocket', FakeWs)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const make = () => {
    const events: string[] = []
    const errors: unknown[] = []
    let reconnects = 0
    const socket = new EngineSocket({
      url: () => 'ws://127.0.0.1:17421/ws',
      token: () => 'T',
      onReconnect: () => reconnects++,
      onError: (e) => errors.push(e),
    })
    socket.on((e) => {
      events.push(e.type)
    })
    return { socket, events, errors, reconnects: () => reconnects }
  }

  it('authenticates, subscribes, and delivers events', async () => {
    const { socket, events } = make()
    socket.subscribe('job-1')
    await socket.connect()
    const ws = FakeWs.all[0]!
    ws.open()
    expect(ws.sent).toEqual([{ type: 'auth', token: 'T' }])
    ws.message({ type: 'auth.ok' })
    expect(ws.sent[1]).toEqual({ type: 'subscribe', jobIds: ['job-1'] })
    ws.message({ type: 'job.progress', jobId: 'job-1', progress: 0.5 })
    ws.message('not json') // ignored
    expect(events).toEqual(['job.progress'])
  })

  it('reconnects with backoff after a drop, resubscribes, and says so', async () => {
    const { socket, reconnects } = make()
    socket.subscribe('job-1')
    await socket.connect()
    FakeWs.all[0]!.open()
    FakeWs.all[0]!.message({ type: 'auth.ok' })
    expect(reconnects()).toBe(0)
    FakeWs.all[0]!.close() // the engine restarted
    expect(FakeWs.all).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWs.all).toHaveLength(2)
    const again = FakeWs.all[1]!
    again.open()
    again.message({ type: 'auth.ok' })
    expect(again.sent).toContainEqual({ type: 'subscribe', jobIds: ['job-1'] })
    expect(reconnects()).toBe(1)
    // Closed on purpose: no more reconnecting.
    socket.close()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(FakeWs.all).toHaveLength(2)
  })

  it('backs off up to a cap while the engine stays away', async () => {
    const { socket } = make()
    await socket.connect()
    let t = 0
    for (let i = 0; i < 8; i++) {
      FakeWs.all.at(-1)!.close()
      const before = FakeWs.all.length
      const step = Math.min(10_000, 500 * 2 ** i)
      await vi.advanceTimersByTimeAsync(step)
      t += step
      expect(FakeWs.all.length).toBe(before + 1)
    }
    expect(t).toBeLessThan(60_000)
    socket.close()
  })

  it('reports a listener’s error instead of dropping it, sync or async', async () => {
    const { socket, errors } = make()
    socket.on(() => {
      throw new Error('sync boom')
    })
    socket.on(async () => {
      throw new Error('async boom')
    })
    await socket.connect()
    FakeWs.all[0]!.open()
    FakeWs.all[0]!.message({ type: 'job.state', jobId: 'j', state: 'done' })
    await vi.runAllTimersAsync()
    expect(errors.map((e) => (e as Error).message)).toEqual(['sync boom', 'async boom'])
    socket.close()
  })
})
