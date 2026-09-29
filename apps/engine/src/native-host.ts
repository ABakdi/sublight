import {
  PROTOCOL_VERSION,
  type NativeCommand,
  type NativeRequest,
  type NativeResponse,
} from '@sublight/protocol'
import { clientOrigins } from './auth'
import { loadConfig } from './config'
import { ENGINE_VERSION } from './health'
import { health, startDetached, stopEngine } from './lifecycle'

/**
 * `sublight-engine native-host`: what the browser runs when the extension
 * calls `runtime.sendNativeMessage('sublight.engine', …)` (M06b.3). install.sh
 * registers it for the extension's pinned ID only, and the browser passes the
 * caller's origin as the first argument, which must be an allowed extension.
 *
 * Chrome's framing: each message is a 32-bit length (native byte order,
 * little-endian here) followed by that much UTF-8 JSON, both ways. stdout is
 * the protocol, so nothing else may print there.
 */

const COMMANDS: NativeCommand[] = ['status', 'start', 'stop', 'token', 'version']
/** Requests are tiny; anything bigger is not from the extension. */
const MAX_MESSAGE = 64 * 1024

export async function answer(req: NativeRequest): Promise<NativeResponse> {
  const id = typeof req.id === 'string' ? { id: req.id.slice(0, 64) } : {}
  const { port, token } = loadConfig()
  switch (req.command) {
    case 'status': {
      const h = await health()
      return {
        ...id,
        ok: true,
        command: 'status',
        running: !!h,
        version: h?.version ?? ENGINE_VERSION,
        port,
        ...(h
          ? { activeJobs: h.activeJobs, queuedJobs: h.queuedJobs ?? 0, uptimeMs: h.engineUptimeMs }
          : {}),
      }
    }
    case 'start': {
      const r = await startDetached()
      return r.ok
        ? { ...id, ok: true, command: 'start', started: !r.already, port }
        : { ...id, ok: false, error: r.error }
    }
    case 'stop': {
      const r = await stopEngine()
      return r.ok
        ? { ...id, ok: true, command: 'stop', stopped: r.wasRunning }
        : { ...id, ok: false, error: r.error }
    }
    case 'token':
      return { ...id, ok: true, command: 'token', token, port }
    case 'version':
      return {
        ...id,
        ok: true,
        command: 'version',
        version: ENGINE_VERSION,
        protocol: PROTOCOL_VERSION,
      }
    default:
      return { ...id, ok: false, error: `unknown command (one of ${COMMANDS.join(', ')})` }
  }
}

export function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

/** Split framed messages off `buffer`; returns the rest. Throws on an oversized frame. */
export function unframe(buffer: Buffer, out: unknown[]): Buffer {
  let rest = buffer
  while (rest.length >= 4) {
    const size = rest.readUInt32LE(0)
    if (size > MAX_MESSAGE) throw new Error('message too large')
    if (rest.length < 4 + size) break
    out.push(JSON.parse(rest.subarray(4, 4 + size).toString('utf8')))
    rest = rest.subarray(4 + size)
  }
  return rest
}

/** Is the browser's caller (argv[0] here) an extension this engine trusts? */
export function allowedCaller(args: string[]): boolean {
  const origin = args.find((a) => a.startsWith('chrome-extension://'))?.replace(/\/$/, '')
  return !!origin && clientOrigins(loadConfig()).has(origin)
}

export async function nativeHost(args: string[]): Promise<number> {
  // Anything logged by accident must not corrupt the protocol.
  console.log = console.info = console.debug = console.error
  const write = (m: NativeResponse) =>
    new Promise<void>((r) => process.stdout.write(frame(m), () => r()))
  if (!allowedCaller(args)) {
    await write({ ok: false, error: 'not an allowed extension' })
    return 1
  }
  let buffer: Buffer = Buffer.alloc(0)
  let queue = Promise.resolve()
  return new Promise<number>((resolve) => {
    process.stdin.on('data', (chunk: Buffer) => {
      const messages: unknown[] = []
      try {
        buffer = unframe(Buffer.concat([buffer, chunk]), messages)
      } catch {
        void write({ ok: false, error: 'bad message' }).then(() => resolve(1))
        return
      }
      for (const m of messages) {
        const req = m as NativeRequest
        queue = queue.then(async () =>
          write(
            req && typeof req === 'object' && typeof req.command === 'string'
              ? await answer(req)
              : { ok: false, error: 'bad message' },
          ),
        )
      }
    })
    // The browser closes stdin when it's done with us.
    process.stdin.on('end', () => void queue.then(() => resolve(0)))
  })
}
