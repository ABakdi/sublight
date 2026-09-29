import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Where the built Player is: `config.player.dir`, else `player/` next to the
 * engine bundle (a release), else the repository's `apps/player/dist`
 * (the same relative path from `src/` and from `dist/`).
 */
export function findPlayerDir(configured?: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = configured
    ? [configured]
    : [join(here, 'player'), join(here, '..', '..', 'player', 'dist')]
  return candidates.find((d) => existsSync(join(d, 'index.html'))) ?? null
}

/**
 * The Player as static files on 127.0.0.1:<port> (Spec 06 §1). An origin of its
 * own, not the engine's: it pairs like any client and can't approve pairings.
 * Unknown paths get index.html (client-side routes); hashed assets cache for good.
 */
/**
 * The Player's CSP (security pass 2, S4): its own scripts only, never framed.
 * Media and hls.js/dash.js requests go to any site (page videos), the API to
 * the engine.
 */
export function playerCsp(enginePort: number): string {
  const engine = [`127.0.0.1:${enginePort}`, `localhost:${enginePort}`]
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' blob: data: http: https:",
    `connect-src 'self' ${engine.map((h) => `http://${h} ws://${h}`).join(' ')} http: https:`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export function servePlayer(dir: string, port: number, enginePort = 17421): Promise<Server> {
  const csp = playerCsp(enginePort)
  const root = resolve(dir)
  let hosts = new Set<string>()
  const server = createServer((req, res) => {
    // Loopback names only: a DNS-rebound name can't read the Player through us.
    if (!hosts.has(req.headers.host ?? '') || !['GET', 'HEAD'].includes(req.method ?? '')) {
      res.writeHead(req.method === 'GET' || req.method === 'HEAD' ? 403 : 405).end()
      return
    }
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    } catch {
      res.writeHead(400).end()
      return
    }
    let file = normalize(join(root, path))
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end()
      return
    }
    const isFile = existsSync(file) && statSync(file).isFile()
    if (!isFile) {
      // A missing asset is a 404; anything else is a route of the app.
      if (extname(path)) {
        res.writeHead(404).end()
        return
      }
      file = join(root, 'index.html')
    }
    const immutable = file.startsWith(join(root, 'assets') + sep)
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(extname(file).toLowerCase() === '.html'
        ? { 'content-security-policy': csp, 'x-frame-options': 'DENY' }
        : {}),
    })
    if (req.method === 'HEAD') res.end()
    else createReadStream(file).pipe(res)
  })
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const bound = (server.address() as AddressInfo).port
      hosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`])
      resolveListen(server)
    })
  })
}
