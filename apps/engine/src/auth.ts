import { timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { AUTH_HEADER, BEARER_PREFIX, DEV_EXTENSION_ID } from '@sublight/protocol'
import type { EngineConfig } from './config'

/**
 * Auth & hardening (Protocol §3).
 * - Bearer token, constant-time comparison;
 * - Host header must be loopback (defeats DNS rebinding);
 * - Origin allowlist only (no reflection, never `*`);
 * - every response is JSON (never text/html).
 */
/** Loopback `Host` values for the port the engine actually listens on. */
export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`])
}
/** The Vite dev server's Player: allowed only with `devOrigins` (baseline B2: any Vite app uses :5173). */
export const DEV_PLAYER_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

/** The Player the engine serves (`player.port`, 0 = off). */
export function playerOrigins(playerPort: number): string[] {
  return playerPort > 0 ? [`http://127.0.0.1:${playerPort}`, `http://localhost:${playerPort}`] : []
}

/** The Players this engine trusts: the served one, and the dev one when enabled. */
export function knownPlayers(config: Pick<EngineConfig, 'player' | 'devOrigins'>): string[] {
  return [...playerOrigins(config.player.port), ...(config.devOrigins ? DEV_PLAYER_ORIGINS : [])]
}

/**
 * Every client origin: the unpacked extension (pinned ID), the Players, and
 * `config.allowedOrigins` (packaged/store extension IDs).
 */
export function clientOrigins(
  config: Pick<EngineConfig, 'player' | 'devOrigins' | 'allowedOrigins'>,
): Set<string> {
  return new Set([
    `chrome-extension://${DEV_EXTENSION_ID}`,
    ...knownPlayers(config),
    ...config.allowedOrigins,
  ])
}

export function jsonError(
  c: Context,
  code: string,
  message: string,
  status: number,
  retryable = false,
) {
  return c.json(
    { error: { code, message, retryable, details: {} } },
    status as ContentfulStatusCode,
  )
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/**
 * Host + Origin checks for every route, authenticated or not — the pairing
 * probe must not be readable through a DNS-rebound page either.
 */
export function hostOriginGuard(port: number, origins: Set<string>): MiddlewareHandler {
  const hosts = allowedHosts(port)
  return async (c, next) => {
    const host = c.req.header('host') ?? ''
    if (!hosts.has(host)) {
      return jsonError(c, 'BAD_ORIGIN', 'Host header not allowed (loopback only)', 403)
    }
    const origin = c.req.header('origin')
    if (origin && !origins.has(origin)) {
      return jsonError(c, 'BAD_ORIGIN', 'Origin not allowed', 403)
    }
    await next()
  }
}

export function bearerAuth(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.header(AUTH_HEADER) ?? ''
    const token = raw.startsWith(BEARER_PREFIX) ? raw.slice(BEARER_PREFIX.length) : ''
    if (!token || !safeEqual(token, expectedToken)) {
      return jsonError(c, 'UNAUTHORIZED', 'Missing or invalid bearer token', 401)
    }
    c.set('authenticated', true)
    await next()
  }
}

/** Explicit CORS allowlist + JSON-only safety (Protocol §3.4-3.5). */
export function corsAllowlist(origins: Set<string>): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    if (origin && origins.has(origin)) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Vary', 'Origin')
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      c.header(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Idempotency-Key, X-Source-Name, X-Source-MediaHash',
      )
      c.header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges')
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204)
    await next()
  }
}
