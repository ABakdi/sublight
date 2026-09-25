import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'
import { Hono, type Context } from 'hono'
import type { JobCreation } from '@sublight/protocol'
import { IDEMPOTENCY_KEY_HEADER } from '@sublight/protocol'
import type { EngineConfig } from './config'
import { allowedOrigins, bearerAuth, corsAllowlist, hostOriginGuard, jsonError } from './auth'
import { probeGpu } from './gpu'
import { buildHealth, buildVersion } from './health'
import { JobError } from './jobs/queue'
import { MediaError } from './media/store'
import { ModelError } from './models/manager'
import type { EngineServices } from './services'

export interface AppOptions {
  /** Omitted in tests of the auth/health surface alone. */
  services?: EngineServices
  /** GPU probe override (tests). */
  gpu?: typeof probeGpu
}

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  MODEL_NOT_INSTALLED: 409,
  MODEL_INSTALL_FAILED: 409,
  MEDIA_TOO_LARGE: 413,
  AUDIO_EMPTY: 422,
  AUDIO_UNSUPPORTED: 415,
  WORKER_UNAVAILABLE: 503,
}

/** `X-Source-Name` is percent-encoded by clients (header values are Latin-1 only). */
function sourceName(header: string | undefined): string | null {
  if (!header) return null
  try {
    return decodeURIComponent(header).slice(0, 512)
  } catch {
    return header.slice(0, 512)
  }
}

/** Map service errors onto the single error envelope (Protocol §6). */
function toResponse(c: Context, err: unknown) {
  if (err instanceof JobError) return jsonError(c, err.code, err.message, err.status, err.retryable)
  if (err instanceof MediaError) return jsonError(c, err.code, err.message, err.status)
  if (err instanceof ModelError) return jsonError(c, err.code, err.message, STATUS[err.code] ?? 400)
  throw err
}

/**
 * Engine HTTP app (Spec 06, Protocol §2). Composable so tests drive it with
 * `app.request()`; route groups beyond health/version need `services`.
 */
export function createApp(config: EngineConfig, opts: AppOptions = {}): Hono {
  const app = new Hono()
  const bootedAt = Date.now()
  const origins = allowedOrigins(config.allowedOrigins)
  const gpu = opts.gpu ?? probeGpu
  const s = opts.services

  app.use('*', hostOriginGuard(config.port, origins))
  app.use('*', corsAllowlist(origins))

  // Unauthenticated pairing probe (Protocol §2) — only advertises *presence*.
  app.get('/v1/pair/info', (c) => c.json({ requiresToken: true }))

  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/pair/info') return next()
    return bearerAuth(config.token)(c, next)
  })

  app.get('/v1/health', async (c) => c.json(buildHealth(bootedAt, s, s ? await gpu() : undefined)))
  app.get('/v1/version', (c) => c.json(buildVersion()))

  if (s) {
    // --- models (Spec 06 §3) ---
    app.get('/v1/models', (c) => c.json(s.models.list()))
    app.get('/v1/models/:id', (c) => {
      try {
        return c.json(s.models.info(c.req.param('id')))
      } catch (err) {
        return toResponse(c, err)
      }
    })
    app.post('/v1/models/:id/install', (c) => {
      const id = c.req.param('id')
      try {
        s.models.entry(id)
      } catch (err) {
        return toResponse(c, err)
      }
      // Runs in the background; progress over WS `model.install.progress`.
      s.models
        .install(id)
        .catch((err: unknown) => console.error(`[engine] install ${id} failed:`, String(err)))
      return c.json({ ok: true, model: s.models.info(id) }, 202)
    })
    app.post('/v1/models/:id/remove', (c) => {
      try {
        return c.json({ ok: true, freedBytes: s.models.remove(c.req.param('id')) })
      } catch (err) {
        return toResponse(c, err)
      }
    })

    // --- media (Spec 06 §4) ---
    app.put('/v1/media/:mediaId', async (c) => {
      const length = Number(c.req.header('content-length'))
      if (Number.isFinite(length) && length > config.cacheLimits.uploadBytes) {
        return jsonError(
          c,
          'MEDIA_TOO_LARGE',
          `upload exceeds ${config.cacheLimits.uploadBytes} bytes`,
          413,
        )
      }
      const body = c.req.raw.body
      if (!body) return jsonError(c, 'AUDIO_UNSUPPORTED', 'empty upload', 415)
      try {
        const result = await s.media.ingest(
          c.req.param('mediaId'),
          Readable.fromWeb(body as unknown as NodeWebStream),
          sourceName(c.req.header('x-source-name')),
        )
        return c.json(result)
      } catch (err) {
        return toResponse(c, err)
      }
    })
    app.get('/v1/media/:ref', (c) => {
      const hash = s.media.resolve(c.req.param('ref'))
      const meta = hash ? s.media.meta(hash) : null
      return meta ? c.json(meta) : jsonError(c, 'NOT_FOUND', 'unknown media', 404)
    })
    app.delete('/v1/media/:mediaHash', (c) =>
      s.media.delete(c.req.param('mediaHash'))
        ? c.json({ ok: true })
        : jsonError(c, 'NOT_FOUND', 'unknown media', 404),
    )

    // --- jobs (Protocol §2, §5) ---
    app.post('/v1/jobs', async (c) => {
      let body: JobCreation
      try {
        body = await c.req.json<JobCreation>()
      } catch {
        return jsonError(c, 'JOB_INVALID', 'body must be JSON', 400)
      }
      if (!body || typeof body !== 'object' || typeof body.type !== 'string') {
        return jsonError(c, 'JOB_INVALID', 'body.type is required', 400)
      }
      try {
        const job = s.jobs.create(body, c.req.header(IDEMPOTENCY_KEY_HEADER) ?? undefined)
        return c.json(job, 202)
      } catch (err) {
        return toResponse(c, err)
      }
    })
    app.get('/v1/jobs', (c) => c.json({ jobs: s.jobs.list(c.req.query('status')) }))
    app.get('/v1/jobs/:id', (c) => {
      const job = s.jobs.get(c.req.param('id'))
      return job ? c.json(job) : jsonError(c, 'JOB_NOT_FOUND', 'unknown job', 404)
    })
    app.post('/v1/jobs/:id/cancel', (c) => {
      const job = s.jobs.cancel(c.req.param('id'))
      return job ? c.json(job) : jsonError(c, 'JOB_NOT_FOUND', 'unknown job', 404)
    })
    app.get('/v1/jobs/:id/result', (c) => {
      const id = c.req.param('id')
      const job = s.jobs.get(id)
      if (!job) return jsonError(c, 'JOB_NOT_FOUND', 'unknown job', 404)
      const result = s.jobs.result(id)
      return result
        ? c.json(result)
        : jsonError(c, 'JOB_INVALID', `job is ${job.state}, no result yet`, 409)
    })
  }

  app.notFound((c) => jsonError(c, 'NOT_FOUND', `No ${c.req.method} ${c.req.path}`, 404))

  app.onError((err, c) => {
    console.error('[engine] unhandled error', err)
    return jsonError(c, 'INTERNAL', err instanceof Error ? err.message : 'Internal error', 500)
  })

  return app
}
