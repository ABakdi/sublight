import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'
import { Hono, type Context } from 'hono'
import type { JobCreation, LiveAnchor, LiveStatus } from '@sublight/protocol'
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
    // --- live capture (Spec 08 §3-§5) ---
    /** Only running/queued live jobs accept audio and anchors. */
    const liveJob = (c: Context) => {
      const job = s.jobs.get(c.req.param('id') ?? '')
      if (!job || job.type !== 'live') return jsonError(c, 'JOB_NOT_FOUND', 'unknown live job', 404)
      if (job.state !== 'queued' && job.state !== 'running') {
        return jsonError(c, 'JOB_INVALID', `live job is ${job.state}`, 409)
      }
      return null
    }
    app.post('/v1/live/:id/audio', async (c) => {
      const refused = liveJob(c)
      if (refused) return refused
      const wallMs = Number(c.req.query('wallMs'))
      if (!Number.isFinite(wallMs))
        return jsonError(c, 'JOB_INVALID', 'wallMs query parameter required', 400)
      const body = Buffer.from(await c.req.arrayBuffer())
      // ≤ 10 s of 16 kHz mono s16le per request.
      if (body.length === 0 || body.length > 16000 * 2 * 10) {
        return jsonError(
          c,
          'JOB_INVALID',
          'audio chunk must be 1 byte to 10 s of 16 kHz s16le mono',
          400,
        )
      }
      const session = s.live.get(c.req.param('id'))
      if (session.stopping) return jsonError(c, 'JOB_INVALID', 'live job is stopping', 409)
      session.append(body, wallMs)
      return c.body(null, 204)
    })
    app.post('/v1/live/:id/anchor', async (c) => {
      const refused = liveJob(c)
      if (refused) return refused
      const a = (await c.req.json().catch(() => null)) as LiveAnchor | null
      if (
        !a ||
        ![a.wallMs, a.mediaMs, a.rate].every(Number.isFinite) ||
        a.rate <= 0 ||
        a.rate > 16 ||
        typeof a.playing !== 'boolean'
      ) {
        return jsonError(
          c,
          'JOB_INVALID',
          'anchor needs wallMs, mediaMs, rate (0-16] and playing',
          400,
        )
      }
      s.live
        .get(c.req.param('id'))
        .anchor({ wallMs: a.wallMs, mediaMs: a.mediaMs, rate: a.rate, playing: a.playing })
      return c.body(null, 204)
    })
    app.post('/v1/live/:id/stop', (c) => {
      const refused = liveJob(c)
      if (refused) return refused
      s.live.get(c.req.param('id')).stopping = true
      return c.json(s.jobs.get(c.req.param('id')), 202)
    })
    // --- captions ahead of playback (ADR-0020) ---
    app.post('/v1/url/:id/focus', async (c) => {
      const job = s.jobs.get(c.req.param('id'))
      if (!job || job.type !== 'url') return jsonError(c, 'JOB_NOT_FOUND', 'unknown url job', 404)
      const body = await c.req.json<{ mediaMs?: unknown }>().catch(() => null)
      const ms = body?.mediaMs
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)
        return jsonError(c, 'JOB_INVALID', 'mediaMs must be a number ≥ 0', 400)
      if (!s.ahead.focus(job.id, ms))
        return jsonError(c, 'JOB_INVALID', `url job is ${job.state}`, 409)
      return c.json({ ok: true })
    })
    app.get('/v1/live/:id', (c) => {
      const job = s.jobs.get(c.req.param('id'))
      if (!job || job.type !== 'live' || !s.live.has(job.id)) {
        return jsonError(c, 'JOB_NOT_FOUND', 'no live session', 404)
      }
      const session = s.live.get(job.id)
      const status: LiveStatus = {
        jobId: job.id,
        receivedMs: Math.round(session.receivedMs),
        lagMs: Math.max(0, Date.now() - session.wallAt(session.totalSamples)),
        committedWords: 0,
        stopping: session.stopping,
      }
      return c.json(status)
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
