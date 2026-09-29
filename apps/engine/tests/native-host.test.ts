import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEV_EXTENSION_ID, type NativeRequest, type NativeResponse } from '@sublight/protocol'
import { frame, unframe } from '../src/native-host'

/** The native host the extension starts the engine through (M06b.3). */

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

const home = mkdtempSync(join(tmpdir(), 'sublight-native-'))
const EXTENSION = `chrome-extension://${DEV_EXTENSION_ID}/`

/** Run the host as the browser does: the caller's origin as argument, framed messages on stdin. */
function host(origin: string, requests: NativeRequest[]): Promise<NativeResponse[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/main.ts', 'native-host', origin],
      { env: { ...process.env, SUBLIGHT_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] },
    )
    let out: Buffer = Buffer.alloc(0)
    child.stdout.on('data', (d: Buffer) => (out = Buffer.concat([out, d])))
    child.on('error', reject)
    child.on('close', () => {
      const replies: unknown[] = []
      const rest = unframe(out, replies)
      if (rest.length) reject(new Error(`stray output: ${rest.toString()}`))
      else resolve(replies as NativeResponse[])
    })
    for (const r of requests) child.stdin.write(frame(r))
    child.stdin.end()
  })
}

describe('native host', () => {
  afterAll(() => host(EXTENSION, [{ command: 'stop' }]))

  it('frames messages with a little-endian length, and refuses oversized ones', () => {
    const f = frame({ command: 'status' })
    expect(f.readUInt32LE(0)).toBe(f.length - 4)
    const got: unknown[] = []
    // Two messages, the second cut short: one parsed, the rest kept for later.
    const rest = unframe(Buffer.concat([f, f.subarray(0, 7)]), got)
    expect(got).toEqual([{ command: 'status' }])
    expect(rest.length).toBe(7)
    const huge = Buffer.alloc(4)
    huge.writeUInt32LE(10 * 1024 * 1024, 0)
    expect(() => unframe(huge, [])).toThrow(/too large/)
  })

  it('answers only the sublight extension', async () => {
    const [reply] = await host('chrome-extension://someotherextensionid/', [{ command: 'token' }])
    expect(reply).toEqual({ ok: false, error: 'not an allowed extension' })
  }, 30_000)

  it('starts the engine, reports it, hands over the token, and stops it', async () => {
    const [port, whisper, llama] = [await freePort(), await freePort(), await freePort()]
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        token: 'b'.repeat(64),
        port,
        whisper: { port: whisper, gpu: 'off', threads: 1 },
        llama: { port: llama, gpu: 'off', threads: 1, contextTokens: 1024 },
        player: { port: 0 },
      }),
    )
    const before = await host(EXTENSION, [
      { id: '1', command: 'status' },
      { id: '2', command: 'version' },
      { id: '3', command: 'token' },
    ])
    expect(before).toEqual([
      expect.objectContaining({ id: '1', ok: true, command: 'status', running: false, port }),
      expect.objectContaining({ id: '2', ok: true, command: 'version', protocol: 1 }),
      { id: '3', ok: true, command: 'token', token: 'b'.repeat(64), port },
    ])

    const [started] = await host(EXTENSION, [{ command: 'start' }])
    expect(started).toEqual({ ok: true, command: 'start', started: true, port })
    const [status] = await host(EXTENSION, [{ command: 'status' }])
    expect(status).toMatchObject({ ok: true, running: true, activeJobs: 0 })
    const [again] = await host(EXTENSION, [{ command: 'start' }])
    expect(again).toMatchObject({ ok: true, started: false })

    const [stopped] = await host(EXTENSION, [{ command: 'stop' }])
    expect(stopped).toEqual({ ok: true, command: 'stop', stopped: true })
    const [after] = await host(EXTENSION, [{ command: 'status' }])
    expect(after).toMatchObject({ running: false })
  }, 60_000)
})
