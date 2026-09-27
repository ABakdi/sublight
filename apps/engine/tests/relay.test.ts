import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { relayResponse, RelayStore, type Relay } from '../src/media/relay'

const file = (bytes: Buffer, state: 'ready' | 'downloading' = 'ready'): Relay => {
  const path = join(mkdtempSync(join(tmpdir(), 'sublight-relay-')), 'v.mp4')
  writeFileSync(path, bytes)
  return {
    kind: 'file',
    path,
    state,
    progress: 1,
    title: null,
    durationMs: null,
    expiresAt: Infinity,
  }
}
const req = (range?: string) =>
  new Request('http://127.0.0.1/v1/relay/x', range ? { headers: { range } } : {})

describe('serving a downloaded page video (M05b)', () => {
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i))
  it('answers byte ranges so the player can seek', async () => {
    const r = await relayResponse(file(bytes), req('bytes=10-19'))
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes.subarray(10, 20))
    const tail = await relayResponse(file(bytes), req('bytes=-5'))
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(bytes.subarray(95))
    expect((await relayResponse(file(bytes), req('bytes=500-'))).status).toBe(416)
    const whole = await relayResponse(file(bytes), req())
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-length')).toBe('100')
  })
  it('says "not yet" while downloading, and forgets expired ids', async () => {
    expect((await relayResponse(file(bytes, 'downloading'), req())).status).toBe(503)
    const store = new RelayStore()
    const id = store.add(
      { input: 'https://x.test/a.mp4', headers: {}, durationMs: 1, title: null, via: 'direct' },
      0,
    )
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(store.get(id, 1)).not.toBeNull()
    expect(store.get(id, 7 * 60 * 60 * 1000)).toBeNull()
  })
})
