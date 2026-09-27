import { aheadRunner } from '../src/asr/ahead'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { beforeAll, describe, expect, it } from 'vitest'
import type {
  JobResult,
  JobSummary,
  MediaResolveResponse,
  ModelsResponse,
  TranscribeJob,
  UploadResult,
} from '@sublight/protocol'
import { createApp } from '../src/app'
import { RelayStore } from '../src/media/relay'
import { transcribeRunner } from '../src/asr/transcribe'
import { WhisperWorker } from '../src/asr/whisper'
import { LlamaWorker } from '../src/llm/llama'
import { GpuResidency } from '../src/workers/gpu'
import { LiveHub } from '../src/live/hub'
import type { EngineConfig } from '../src/config'
import { EventBus } from '../src/events'
import { JobQueue, type JobRunner } from '../src/jobs/queue'
import { JobStore } from '../src/jobs/store'
import { SYSTEM_FFMPEG } from '../src/media/ffmpeg'
import { MediaStore } from '../src/media/store'
import { ModelManager } from '../src/models/manager'
import { enginePaths } from '../src/paths'
import type { EngineServices } from '../src/services'

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

const config: EngineConfig = {
  token: 'a'.repeat(64),
  port: 17421,
  defaults: { asrModel: 'whisper-small', translateModel: 'qwen3-4b-instruct' },
  autoRetry: true,
  allowedOrigins: [],
  cacheLimits: { mediaBytes: 1024 ** 3, uploadBytes: 50 * 1024 ** 2 },
  whisper: { port: 17999, gpu: 'off', threads: 2 },
  llama: { port: 17998, gpu: 'off', threads: 2, contextTokens: 4096 },
  ffmpeg: SYSTEM_FFMPEG,
  player: { port: 0 },
}
const H = { host: '127.0.0.1:17421', authorization: `Bearer ${config.token}` }

function services(runner?: JobRunner): EngineServices {
  const paths = enginePaths(mkdtempSync(join(tmpdir(), 'sublight-routes-')))
  const bus = new EventBus()
  const models = new ModelManager(paths.models, bus)
  const media = new MediaStore(paths.mediaCache, {
    ffmpeg: SYSTEM_FFMPEG,
    maxUploadBytes: config.cacheLimits.uploadBytes,
    cacheLimitBytes: config.cacheLimits.mediaBytes,
  })
  const whisper = new WhisperWorker({
    binary: '/nonexistent',
    port: 17999,
    useGpu: false,
    logDir: paths.logs,
  })
  const jobs = new JobQueue(new JobStore(paths.jobs), bus, { autoRetry: true })
  jobs.register(runner ?? transcribeRunner({ media, models, whisper, ffmpeg: SYSTEM_FFMPEG }))
  jobs.start()
  const llama = new LlamaWorker({
    binary: '/nonexistent',
    port: 17998,
    useGpu: false,
    logDir: paths.logs,
  })
  const gpu = new GpuResidency({ asr: whisper, llm: llama })
  const live = new LiveHub(join(paths.jobs, 'live'))
  const ahead = aheadRunner({ models, whisper, ffmpeg: SYSTEM_FFMPEG, ytDlp: null })
  const relays = new RelayStore()
  return { bus, models, media, jobs, whisper, llama, gpu, live, ahead, relays, ytDlp: null, paths }
}

/** Stand-in for whisper: instant, deterministic output. */
const instantRunner = (media: () => MediaStore): JobRunner<TranscribeJob> => ({
  type: 'transcribe',
  gpu: true,
  validate(req) {
    if (!media().resolve(req.mediaHash)) throw new Error('unexpected: unknown media')
  },
  cacheKey: (req) => `t|${req.mediaHash}`,
  run: async () => ({ tracks: [], language: 'en' }),
})

let clip = ''
beforeAll(() => {
  if (!hasFfmpeg) return
  clip = join(mkdtempSync(join(tmpdir(), 'sublight-routes-fx-')), 'tone.m4a')
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=500:duration=1',
    '-c:a',
    'aac',
    clip,
  ])
})

const json = <T>(res: Response) => res.json() as Promise<T>

describe('engine routes (Protocol §2)', () => {
  it('lists the pinned models, none installed', async () => {
    const app = createApp(config, {
      services: services(),
      gpu: async () => ({ available: false, name: null, vramTotal: null, vramFree: null }),
    })
    const res = await app.request('/v1/models', { headers: H })
    const body = await json<ModelsResponse>(res)
    expect(body.models.map((m) => m.id)).toContain('whisper-small')
    expect(body.models.every((m) => m.state === 'not-installed')).toBe(true)
    expect((await app.request('/v1/models/nope', { headers: H })).status).toBe(404)
    expect(
      (await app.request('/v1/models/nope/install', { method: 'POST', headers: H })).status,
    ).toBe(404)
  })

  it('requires the token on every data route', async () => {
    const app = createApp(config, { services: services() })
    for (const [method, path] of [
      ['GET', '/v1/models'],
      ['GET', '/v1/jobs'],
      ['POST', '/v1/jobs'],
      ['PUT', '/v1/media/x'],
    ]) {
      const res = await app.request(path!, { method, headers: { host: H.host } })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })

  it('refuses jobs for unknown media and uninstalled models', async () => {
    const s = services()
    const app = createApp(config, { services: s })
    const post = (body: unknown) =>
      app.request('/v1/jobs', {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const unknown = await post({
      type: 'transcribe',
      mediaHash: 'nope',
      model: 'whisper-small',
      params: { language: null, maxCueDurationMs: 7000 },
    })
    expect(unknown.status).toBe(404)
    expect((await post({ type: 'bogus' })).status).toBe(400)
    expect(
      (await app.request('/v1/jobs', { method: 'POST', headers: H, body: '{nope' })).status,
    ).toBe(400)
    if (!hasFfmpeg) return
    const up = await app.request('/v1/media/clip-1', {
      method: 'PUT',
      headers: H,
      body: readFileSync(clip),
    })
    const { mediaHash } = await json<UploadResult>(up)
    const missing = await post({
      type: 'transcribe',
      mediaHash,
      model: 'whisper-small',
      params: { language: null, maxCueDurationMs: 7000 },
    })
    expect(missing.status).toBe(409)
    expect(await json<{ error: { code: string } }>(missing)).toMatchObject({
      error: { code: 'MODEL_NOT_INSTALLED' },
    })
    const turbo = await post({
      type: 'transcribe',
      mediaHash,
      model: 'whisper-large-v3-turbo-q5',
      params: { language: null, task: 'translate', maxCueDurationMs: 7000 },
    })
    expect(await json<{ error: { code: string; message: string } }>(turbo)).toMatchObject({
      error: { code: 'JOB_INVALID' },
    })
  })

  it.skipIf(!hasFfmpeg)(
    'uploads media, runs a job, honours idempotency and serves the result',
    async () => {
      const holder: { s?: EngineServices } = {}
      const s = (holder.s = services(instantRunner(() => holder.s!.media)))
      const app = createApp(config, { services: s })
      const up = await app.request('/v1/media/clip-1', {
        method: 'PUT',
        headers: { ...H, 'x-source-name': 'tone.m4a' },
        body: readFileSync(clip),
      })
      expect(up.status).toBe(200)
      const uploaded = await json<UploadResult>(up)
      expect((await app.request('/v1/media/clip-1', { headers: H })).status).toBe(200)

      const body = JSON.stringify({
        type: 'transcribe',
        mediaHash: 'clip-1',
        model: 'whisper-small',
        params: { language: null, maxCueDurationMs: 7000 },
      })
      const headers = { ...H, 'content-type': 'application/json', 'idempotency-key': 'k-1' }
      const created = await json<JobSummary>(
        await app.request('/v1/jobs', { method: 'POST', headers, body }),
      )
      const replay = await json<JobSummary>(
        await app.request('/v1/jobs', { method: 'POST', headers, body }),
      )
      expect(replay.id).toBe(created.id)

      for (
        let i = 0;
        i < 100 &&
        (await json<JobSummary>(await app.request(`/v1/jobs/${created.id}`, { headers: H })))
          .state !== 'done';
        i++
      ) {
        await new Promise((r) => setTimeout(r, 10))
      }
      const result = await json<JobResult>(
        await app.request(`/v1/jobs/${created.id}/result`, { headers: H }),
      )
      expect(result).toMatchObject({ id: created.id, state: 'done', language: 'en' })
      const listed = await json<{ jobs: JobSummary[] }>(
        await app.request('/v1/jobs?status=done', { headers: H }),
      )
      expect(listed.jobs.map((j) => j.id)).toEqual([created.id])

      expect(
        (await app.request(`/v1/media/${uploaded.mediaHash}`, { method: 'DELETE', headers: H }))
          .status,
      ).toBe(200)
      expect((await app.request('/v1/jobs/nope', { headers: H })).status).toBe(404)
      expect(
        (await app.request('/v1/jobs/nope/cancel', { method: 'POST', headers: H })).status,
      ).toBe(404)
    },
  )

  it.skipIf(!hasFfmpeg)('rejects uploads over the size cap from Content-Length', async () => {
    const app = createApp(
      { ...config, cacheLimits: { ...config.cacheLimits, uploadBytes: 10 } },
      { services: services() },
    )
    const res = await app.request('/v1/media/x', {
      method: 'PUT',
      headers: { ...H, 'content-length': '11' },
      body: 'x'.repeat(11),
    })
    expect(res.status).toBe(413)
  })

  it('reports queue, cache and GPU in /v1/health', async () => {
    const app = createApp(config, {
      services: services(),
      gpu: async () => ({ available: true, name: 'Test GPU', vramTotal: 4096, vramFree: 3000 }),
    })
    const health = await json<Record<string, unknown>>(
      await app.request('/v1/health', { headers: H }),
    )
    expect(health).toMatchObject({
      status: 'online',
      queuedJobs: 0,
      residentModel: null,
      mediaCacheBytes: 0,
      gpu: { name: 'Test GPU' },
    })
  })
})

describe('page videos for the Player (M05b)', () => {
  it.skipIf(!hasFfmpeg)(
    'resolves a direct video and relays byte ranges without a token',
    { timeout: 20_000 },
    async () => {
      const bytes = readFileSync(join(import.meta.dirname, 'fixtures', 'jfk.wav'))
      const server = createServer((req, res) => {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
        const start = m ? Number(m[1]) : 0
        const end = m?.[2] ? Number(m[2]) : bytes.length - 1
        res.writeHead(m ? 206 : 200, {
          'content-type': 'audio/wav',
          'accept-ranges': 'bytes',
          'content-length': end - start + 1,
          ...(m ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
        })
        res.end(bytes.subarray(start, end + 1))
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      try {
        const app = createApp(config, { services: services() })
        const refused = await app.request('/v1/media/resolve', {
          method: 'POST',
          headers: { host: H.host, 'content-type': 'application/json' },
          body: JSON.stringify({ pageUrl: 'https://example.test/watch' }),
        })
        expect(refused.status).toBe(401)
        const res = await app.request('/v1/media/resolve', {
          method: 'POST',
          headers: { ...H, 'content-type': 'application/json' },
          body: JSON.stringify({
            pageUrl: 'https://example.test/watch',
            mediaUrl: `http://127.0.0.1:${port}/clip.wav`,
          }),
        })
        expect(res.status).toBe(200)
        const resolved = await json<MediaResolveResponse>(res)
        expect(resolved.via).toBe('direct')
        expect(resolved.durationMs).toBeGreaterThan(10_000)
        // A <video> asks for ranges and sends no token.
        const part = await app.request(resolved.relayPath, {
          headers: { host: H.host, range: 'bytes=0-99' },
        })
        expect(part.status).toBe(206)
        expect(part.headers.get('content-range')).toBe(`bytes 0-99/${bytes.length}`)
        expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(0, 100))).toBe(true)
        const unknown = await app.request('/v1/relay/0123456789abcdef0123456789abcdef', {
          headers: { host: H.host },
        })
        expect(unknown.status).toBe(404)
      } finally {
        server.close()
      }
    },
  )
})

describe('HLS pages in the Player (M05b.4)', () => {
  // ffmpeg encodes the fixture and copies the stream: slow on a shared CI runner.
  it.skipIf(!hasFfmpeg)(
    'copies an HLS stream into one seekable mp4 for the relay',
    { timeout: 30_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sublight-hls-'))
      execFileSync('ffmpeg', [
        ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi'],
        ...['-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
        ...['-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod'],
        join(dir, 'index.m3u8'),
      ])
      const server = createServer((req, res) => {
        try {
          res.end(readFileSync(join(dir, (req.url ?? '/').slice(1).split('?')[0]!)))
        } catch {
          res.writeHead(404).end()
        }
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      const store = services()
      store.relays = new RelayStore(mkdtempSync(join(tmpdir(), 'sublight-relays-')))
      try {
        const app = createApp(config, { services: store })
        const res = await app.request('/v1/media/resolve', {
          method: 'POST',
          headers: { ...H, 'content-type': 'application/json' },
          body: JSON.stringify({
            pageUrl: 'https://example.test/watch',
            mediaUrl: `http://127.0.0.1:${port}/index.m3u8`,
          }),
        })
        const resolved = await json<MediaResolveResponse>(res)
        expect(resolved.state).toBe('downloading')
        let status = { state: 'downloading' }
        for (let i = 0; i < 100 && status.state === 'downloading'; i++) {
          await new Promise((r) => setTimeout(r, 100))
          status = await json(
            await app.request(`/v1/media/relay/${resolved.mediaId}`, { headers: H }),
          )
        }
        expect(status.state).toBe('ready')
        const part = await app.request(resolved.relayPath, {
          headers: { host: H.host, range: 'bytes=0-7' },
        })
        expect(part.status).toBe(206)
        expect(
          Buffer.from(await part.arrayBuffer())
            .subarray(4, 8)
            .toString(),
        ).toBe('ftyp')
      } finally {
        server.close()
      }
    },
  )
})
