import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect, isIP, type LookupFunction, type Socket } from 'node:net'
import { Readable } from 'node:stream'
import { JobError } from '../jobs/queue'
import { isPrivateAddress } from './net'

/**
 * Where the engine's media traffic may go (security pass 2, S3). Checking a
 * page-supplied URL once isn't enough: the fetchers resolve the name again
 * (a DNS answer can change, "rebinding") and follow redirects. So every
 * connection is checked at the address it actually connects to:
 *
 * - ffmpeg and yt-dlp go through `EgressProxy`, a local HTTP proxy that
 *   refuses private addresses on every connection (redirects and HLS
 *   segments included);
 * - the engine's own requests use `guardedFetch`, whose lookup refuses them
 *   and which follows redirects itself, checking each one.
 *
 * With `allowPrivateNetworks` (a home media server) none of this applies.
 */

const REFUSED =
  'sublight only fetches videos from the internet, not from this computer or the local network (allowPrivateNetworks in config.json changes that)'

/** A DNS lookup that fails for names resolving to a private address. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0)
    const list = addresses
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      const e = Object.assign(new Error(REFUSED), { code: 'EPRIVATE' })
      return callback(e, '', 0)
    }
    if ((options as { all?: boolean }).all)
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list)
    callback(null, list[0]!.address, list[0]!.family)
  })
}

/** Refuse a literal private address (names are checked by `guardedLookup`). */
function assertHostAllowed(host: string): void {
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIP(bare) && isPrivateAddress(bare))
    throw new JobError('MEDIA_UNREACHABLE', REFUSED, false, 422)
}

/**
 * `fetch` for page-supplied URLs: the connection's address is checked
 * (`guardedLookup`), and redirects are followed here, each checked again.
 */
export async function guardedFetch(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    signal?: AbortSignal
    allowPrivate?: boolean
  } = {},
  redirects = 5,
): Promise<Response> {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new JobError('MEDIA_UNREACHABLE', 'only http(s) links can be fetched', false, 422)
  const allowPrivate = init.allowPrivate ?? allowPrivateDefault
  if (!allowPrivate) assertHostAllowed(u.hostname)
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      {
        method: init.method ?? 'GET',
        headers: init.headers,
        ...(allowPrivate ? {} : { lookup: guardedLookup }),
        signal: init.signal,
      },
      resolve,
    )
    req.on('error', reject)
    req.end()
  }).catch((err: unknown) => {
    if ((err as { code?: string }).code === 'EPRIVATE')
      throw new JobError('MEDIA_UNREACHABLE', REFUSED, false, 422)
    throw err
  })
  const status = res.statusCode ?? 502
  if (status >= 300 && status < 400 && res.headers.location) {
    res.resume()
    if (redirects <= 0) throw new JobError('MEDIA_UNREACHABLE', 'too many redirects', false, 422)
    return guardedFetch(new URL(res.headers.location, u).toString(), init, redirects - 1)
  }
  const headers = new Headers()
  for (const [k, v] of Object.entries(res.headers))
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
  const body =
    init.method === 'HEAD' || status === 204 || status === 304
      ? null
      : (Readable.toWeb(res) as ReadableStream<Uint8Array>)
  return new Response(body, { status, headers })
}

/**
 * A local HTTP proxy for ffmpeg (`-http_proxy`) and yt-dlp (`--proxy`): plain
 * requests and CONNECT tunnels, each to the address it resolves to, only when
 * that address is public. Listens on 127.0.0.1 only; it reaches nothing any
 * local program couldn't reach itself.
 */
export class EgressProxy {
  private server: Server | null = null
  private port = 0

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      // A plain http:// request, in absolute form.
      let target: URL
      try {
        target = new URL(req.url ?? '')
      } catch {
        res.writeHead(400).end()
        return
      }
      if (target.protocol !== 'http:') {
        res.writeHead(400).end()
        return
      }
      try {
        assertHostAllowed(target.hostname)
      } catch {
        res.writeHead(403).end(REFUSED)
        return
      }
      const upstream = httpRequest(
        target,
        { method: req.method, headers: req.headers, lookup: guardedLookup },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers)
          up.pipe(res)
        },
      )
      upstream.on('error', (err: NodeJS.ErrnoException) => {
        if (!res.headersSent) res.writeHead(err.code === 'EPRIVATE' ? 403 : 502)
        res.end()
      })
      req.pipe(upstream)
    })
    // https:// through a CONNECT tunnel.
    server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
      const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? '')
      if (!m) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        return
      }
      const [, host, port] = m
      const refuse = () => client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      try {
        assertHostAllowed(host!)
      } catch {
        refuse()
        return
      }
      const upstream = connect({ host: host!, port: Number(port), lookup: guardedLookup })
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPRIVATE') refuse()
        else client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      })
      client.on('error', () => upstream.destroy())
    })
    server.on('clientError', (_err, socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    this.port = (server.address() as { port: number }).port
    activeProxy = `http://127.0.0.1:${this.port}`
  }

  get url(): string | null {
    return this.server ? `http://127.0.0.1:${this.port}` : null
  }

  stop(): void {
    this.server?.close()
    this.server = null
    activeProxy = null
  }
}

/** The running engine's proxy, for ffmpeg and yt-dlp (null: none, e.g. in tests or with allowPrivateNetworks). */
let activeProxy: string | null = null
export const egressProxy = (): string | null => activeProxy

/** `allowPrivateNetworks`: the engine's own requests may reach private addresses too. */
let allowPrivateDefault = false
export function configureEgress(opts: { allowPrivate: boolean }): void {
  allowPrivateDefault = opts.allowPrivate
}
