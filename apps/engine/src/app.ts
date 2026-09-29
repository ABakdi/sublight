import { PLAYABLE_FORMAT, relayResponse } from './media/relay'
import { PairingStore, pairingPage, type PairingRequest } from './pairing'
import { assertNotProtected, isManifest, resolveRemote } from './media/remote'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'
import { bodyLimit } from 'hono/body-limit'
import { Hono, type Context } from 'hono'
import type {
  JobCreation,
  LiveAnchor,
  LiveStatus,
  MediaResolveRequest,
  MediaResolveResponse,
  PairClaimResponse,
  PairRequestResponse,
  RelayStatusResponse,
} from '@sublight/protocol'
import { COOKIE_BROWSERS, IDEMPOTENCY_KEY_HEADER } from '@sublight/protocol'
import { rotateToken, saveSettings, type EngineConfig } from './config'
import {
  bearerAuth,
  clientOrigins,
  corsAllowlist,
  hostOriginGuard,
  jsonError,
  knownPlayers,
} from './auth'
import { probeGpu } from './gpu'
import { buildHealth, buildVersion } from './health'
import { JobError } from './jobs/queue'
import { MediaError } from './media/store'
import { ModelError } from './models/manager'
import { applyDevice, gpuBuild, type EngineServices } from './services'

export interface AppOptions {
  /** Omitted in tests of the auth/health surface alone. */
  services?: EngineServices
  /** GPU probe override (tests). */
  gpu?: typeof probeGpu
  /** A pairing request arrived (the engine prints where to approve it). */
  onPairingRequest?: (req: PairingRequest, approveUrl: string) => void
  /** Makes and saves a new token (default: config.json); tests pass their own. */
  rotateToken?: () => string
  /** The token changed: drop connections made with the old one. */
  onTokenRotated?: () => void
}

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  MODEL_NOT_INSTALLED: 409,
  MODEL_INSTALL_FAILED: 409,
  DISK_FULL: 507,
  MODEL_IN_USE: 409,
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
/** Does this job need that model (its main model, or a live job's refine model)? */
function usesModel(request: JobCreation | null, id: string): boolean {
  if (!request) return false
  if ('model' in request && request.model === id) return true
  return request.type === 'live' && request.params?.refineModel === id
}

export function createApp(config: EngineConfig, opts: AppOptions = {}): Hono {
  const app = new Hono()
  const bootedAt = Date.now()
  // The engine's own pages (the pairing page) talk to it from its own origin.
  const selfOrigins = [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]
  const origins = new Set([...clientOrigins(config), ...selfOrigins])
  const players = knownPlayers(config)
  const pairing = new PairingStore()
  const gpu = opts.gpu ?? probeGpu
  const s = opts.services

  app.use('*', hostOriginGuard(config.port, origins))
  app.use('*', corsAllowlist(origins))
  // Bodies are bounded before anything reads them (baseline A6); uploads cap themselves while streaming.
  app.use('/v1/*', async (c, next) => {
    if (c.req.method === 'PUT' && c.req.path.startsWith('/v1/media/')) return next()
    const path = c.req.path
    const maxSize = path.startsWith('/v1/pair/')
      ? 4 * 1024
      : path.startsWith('/v1/jobs')
        ? 32 * 1024 ** 2 // a translate job carries a whole track
        : 1024 ** 2
    return bodyLimit({
      maxSize,
      onError: (c) => jsonError(c, 'BODY_TOO_LARGE', `request body over ${maxSize} bytes`, 413),
    })(c, next)
  })
  // Nothing the API answers belongs in a cache (security baseline A5); the relay sets its own.
  app.use('/v1/*', async (c, next) => {
    await next()
    if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store')
  })

  // Requests are activity for smart idle (M06b.5). Status reads (what a
  // forgotten page polls) are not; watching a relayed video is.
  app.use('/v1/*', async (c, next) => {
    const probe =
      c.req.method === 'GET' &&
      /^\/v1\/(health|version|pair\/info|models|media\/relay\/[^/]+)$/.test(c.req.path)
    if (!probe) s?.idle?.touch()
    await next()
  })

  // Unauthenticated pairing probe (Protocol §2) — only advertises *presence*.
  app.get('/v1/pair/info', (c) => c.json({ requiresToken: true }))

  // --- one-click pairing (ADR-0022) ---
  app.post('/v1/pair/request', (c) => {
    const origin = c.req.header('origin') ?? ''
    // The extension or the Player asks; the engine's own pages don't need a token.
    if (!origins.has(origin) || selfOrigins.includes(origin))
      return jsonError(c, 'BAD_ORIGIN', 'pairing is for the sublight extension and Player', 403)
    const req = pairing.request(origin)
    const approveUrl = `http://127.0.0.1:${config.port}/pair?request=${req.id}`
    opts.onPairingRequest?.(req, approveUrl)
    return c.json({ requestId: req.id, code: req.code, approveUrl } satisfies PairRequestResponse)
  })
  app.get('/pair', (c) => {
    const req = pairing.get(c.req.query('request') ?? '')
    c.header('cache-control', 'no-store')
    c.header('x-frame-options', 'DENY') // no clickjacking the Approve button
    return c.html(pairingPage(req, players))
  })
  app.post('/v1/pair/decide', async (c) => {
    // Only the engine's own pairing page decides: no other site can approve.
    if (!selfOrigins.includes(c.req.header('origin') ?? ''))
      return jsonError(c, 'BAD_ORIGIN', 'approve from the engine’s pairing page', 403)
    const body = await c.req.json<{ requestId?: string; approve?: boolean }>().catch(() => null)
    const req = pairing.decide(body?.requestId ?? '', body?.approve === true)
    if (!req) return jsonError(c, 'NOT_FOUND', 'no such pending pairing request', 404)
    return c.json({ state: req.state })
  })
  app.post('/v1/pair/claim', async (c) => {
    const body = await c.req.json<{ requestId?: string }>().catch(() => null)
    const claimed = pairing.claim(body?.requestId ?? '', c.req.header('origin') ?? '')
    if (!claimed)
      return jsonError(c, 'NOT_FOUND', 'no such pairing request (it may have expired)', 404)
    const res: PairClaimResponse = claimed.fresh
      ? { state: 'approved', token: config.token }
      : { state: claimed.request.state }
    return c.json(res)
  })

  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/pair/info' || c.req.path.startsWith('/v1/pair/')) return next()
    // A <video> can't send the token: relay ids are unguessable and expire (M05b).
    if (c.req.path.startsWith('/v1/relay/') && ['GET', 'HEAD'].includes(c.req.method)) return next()
    return bearerAuth(config.token)(c, next)
  })

  // Settings the extension changes (M06b.7): the idle delays, in minutes (0 = never).
  const settings = () => ({
    idle: config.idle,
    device: config.whisper.gpu === 'off' ? 'cpu' : 'auto',
    // What each model server can do and does now (developer mode).
    ...(s
      ? {
          gpu: {
            whisper: { built: gpuBuild('whisper', config, s.paths), inUse: s.whisper.usesGpu },
            llama: { built: gpuBuild('llama', config, s.paths), inUse: s.llama.usesGpu },
          },
        }
      : {}),
  })
  app.get('/v1/settings', (c) => c.json(settings()))
  app.put('/v1/settings', async (c) => {
    const body = await c.req
      .json<{ idle?: Record<string, unknown>; device?: unknown }>()
      .catch(() => null)
    if (body?.device !== undefined && body.device !== 'auto' && body.device !== 'cpu')
      return jsonError(c, 'JOB_INVALID', 'device must be "auto" or "cpu"', 400)
    const idle: Partial<{ unloadMinutes: number; exitMinutes: number }> = {}
    for (const key of ['unloadMinutes', 'exitMinutes'] as const) {
      const v = body?.idle?.[key]
      if (v === undefined) continue
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 24 * 60)
        return jsonError(c, 'JOB_INVALID', `idle.${key} must be 0-1440 minutes`, 400)
      idle[key] = v
    }
    const device = body?.device as 'auto' | 'cpu' | undefined
    saveSettings(config, { idle, ...(device ? { device } : {}) })
    if (device && s) applyDevice(s, config)
    return c.json(settings())
  })
  app.get('/v1/health', async (c) => c.json(buildHealth(bootedAt, s, s ? await gpu() : undefined)))
  app.get('/v1/version', (c) => c.json(buildVersion()))

  // "Unpair everything" (M06.3): a new token; every client, the caller too, pairs again.
  app.post('/v1/token/rotate', (c) => {
    ;(opts.rotateToken ?? (() => rotateToken(config)))()
    opts.onTokenRotated?.()
    return c.json({ ok: true })
  })

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
        s.models.assertRoom(id)
      } catch (err) {
        return toResponse(c, err)
      }
      // Runs in the background; progress over WS `model.install.progress`.
      s.models
        .install(id)
        .catch((err: unknown) => console.error(`[engine] install ${id} failed:`, String(err)))
      return c.json({ ok: true, model: s.models.info(id) }, 202)
    })
    app.post('/v1/models/:id/remove', async (c) => {
      const id = c.req.param('id')
      // A job waiting for this model or running on it would fail halfway.
      const user = s.jobs
        .list()
        .find(
          (j) =>
            (j.state === 'queued' || j.state === 'running') && usesModel(s.jobs.request(j.id), id),
        )
      if (user)
        return jsonError(
          c,
          'MODEL_IN_USE',
          `a ${user.type} job is using ${id}: wait or cancel it`,
          409,
        )
      try {
        // Loaded but idle: give its GPU memory back first.
        for (const worker of [s.whisper, s.llama])
          if (worker.residentModel === id) await worker.stop()
        return c.json({ ok: true, freedBytes: s.models.remove(id) })
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
    // "Clear the audio cache" (baseline C2): everything no queued or running job needs.
    app.post('/v1/media/clear', (c) => {
      const inUse = new Set(
        s.jobs
          .list()
          .filter((j) => j.state === 'queued' || j.state === 'running')
          .map((j) => s.jobs.request(j.id))
          .flatMap((r) => (r && 'mediaHash' in r && r.mediaHash ? [r.mediaHash] : []))
          // A job may name its media by upload id: compare hashes.
          .map((ref) => s.media.resolve(ref) ?? ref),
      )
      let freedBytes = 0
      for (const m of s.media.all())
        if (!inUse.has(m.mediaHash) && s.media.delete(m.mediaHash)) freedBytes += m.normalizedBytes
      return c.json({ ok: true, freedBytes })
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
    // Leased jobs (`lease: true`) are cancelled after 90 s without this.
    app.post('/v1/jobs/:id/keepalive', (c) => {
      if (!s.jobs.keepalive(c.req.param('id')))
        return jsonError(c, 'JOB_NOT_FOUND', 'no open job with that id', 404)
      return c.body(null, 204)
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
    // --- page videos in the Player (M05b) ---
    app.post('/v1/media/resolve', async (c) => {
      const body = await c.req.json<Partial<MediaResolveRequest>>().catch(() => null)
      if (!body?.pageUrl || !/^https?:\/\//i.test(body.pageUrl))
        return jsonError(c, 'JOB_INVALID', 'pageUrl must be an http(s) URL', 400)
      if (
        body.cookiesFromBrowser &&
        !(COOKIE_BROWSERS as readonly string[]).includes(body.cookiesFromBrowser)
      )
        return jsonError(c, 'JOB_INVALID', 'unsupported cookiesFromBrowser', 400)
      const deps = {
        ffmpeg: config.ffmpeg,
        ytDlp: s.ytDlp,
        allowPrivateNetworks: config.allowPrivateNetworks,
      }
      const reply = (mediaId: string, r: Omit<MediaResolveResponse, 'mediaId' | 'relayPath'>) =>
        c.json({ mediaId, relayPath: `/v1/relay/${mediaId}`, ...r } satisfies MediaResolveResponse)
      try {
        // One file with video and audio: stream it straight through.
        const media = await resolveRemote(
          deps,
          body.pageUrl,
          body.mediaUrl,
          body.userAgent,
          body.cookiesFromBrowser,
          PLAYABLE_FORMAT,
        )
        if (isManifest(media.input)) {
          // An HLS/DASH playlist: copy the stream into one seekable file first.
          await assertNotProtected(media.input, media.headers)
          return reply(s.relays.remux(media, config.ffmpeg.ffmpeg), {
            durationMs: media.durationMs,
            title: media.title,
            via: media.via,
            state: 'downloading',
          })
        }
        // The page's own link may stop working once its page stops playing: keep a copy.
        const copy = media.via === 'direct' ? { copyWith: config.ffmpeg.ffmpeg } : {}
        return reply(s.relays.add(media, Date.now(), copy), {
          durationMs: media.durationMs,
          title: media.title,
          via: media.via,
          state: 'ready',
        })
      } catch (err) {
        const noSingleFile = err instanceof Error && /format is not available/i.test(err.message)
        if (!noSingleFile || !s.ytDlp) return toResponse(c, err)
      }
      try {
        // Separate video + audio only (YouTube): check it can be fetched at
        // all (DRM, live, login), then download and merge in the background.
        const audio = await resolveRemote(
          deps,
          body.pageUrl,
          undefined,
          body.userAgent,
          body.cookiesFromBrowser,
        )
        const mediaId = s.relays.download(body.pageUrl, {
          ytDlp: s.ytDlp!,
          ffmpeg: config.ffmpeg.ffmpeg,
          ...(body.cookiesFromBrowser ? { cookiesFromBrowser: body.cookiesFromBrowser } : {}),
          title: audio.title,
          durationMs: audio.durationMs,
        })
        return reply(mediaId, {
          durationMs: audio.durationMs,
          title: audio.title,
          via: 'yt-dlp',
          state: 'downloading',
        })
      } catch (err) {
        return toResponse(c, err)
      }
    })
    app.get('/v1/media/relay/:id', (c) => {
      const status = s.relays.status(c.req.param('id'))
      if (!status) return jsonError(c, 'NOT_FOUND', 'unknown or expired relay', 404)
      return c.json(status satisfies RelayStatusResponse)
    })
    app.on(['GET', 'HEAD'], '/v1/relay/:id', async (c) => {
      const relay = s.relays.get(c.req.param('id'))
      if (!relay) return jsonError(c, 'NOT_FOUND', 'unknown or expired relay', 404)
      try {
        return await relayResponse(relay, c.req.raw)
      } catch (err) {
        return jsonError(c, 'MEDIA_UNREACHABLE', `relay failed: ${String(err)}`, 502)
      }
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
