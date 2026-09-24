import { Hono } from 'hono'
import type { EngineConfig } from './config'
import { bearerAuth, corsAllowlist, jsonError } from './auth'
import { buildHealth, buildVersion, createEngineState, type EngineState } from './health'

/**
 * Engine HTTP app (Spec 06). M00 scope: /v1/health, /v1/version,
 * unauthenticated /v1/pair/info + the token auth middleware (Protocol §3).
 * Composable so tests drive it with `app.request()`, no socket needed.
 */
export function createApp(config: EngineConfig): Hono {
  const app = new Hono()
  const state: EngineState = createEngineState()

  app.use('*', corsAllowlist())

  // Unauthenticated pairing probe (Protocol §2) — only advertises *presence*.
  app.get('/v1/pair/info', (c) => c.json({ requiresToken: true }))

  app.use('/v1/health', bearerAuth(config.token))
  app.use('/v1/version', bearerAuth(config.token))

  app.get('/v1/health', (c) => c.json(buildHealth(state)))

  app.get('/v1/version', (c) => c.json(buildVersion()))

  app.notFound((c) => jsonError(c, 'NOT_FOUND', `No ${c.req.method} ${c.req.path}`, 404))

  app.onError((err, c) => {
    console.error('[engine] unhandled error', err)
    return jsonError(c, 'INTERNAL', err instanceof Error ? err.message : 'Internal error', 500)
  })

  return app
}
