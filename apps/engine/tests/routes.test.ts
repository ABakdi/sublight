import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type {
  JobResult,
  JobSummary,
  ModelsResponse,
  TranscribeJob,
  UploadResult,
} from '@sublight/protocol'
import { createApp } from '../src/app'
import { transcribeRunner } from '../src/asr/transcribe'
import { WhisperWorker } from '../src/asr/whisper'
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
  defaults: { asrModel: 'whisper-small', translateModel: 'qwen2.5-3b-instruct' },
  autoRetry: true,
  allowedOrigins: [],
  cacheLimits: { mediaBytes: 1024 ** 3, uploadBytes: 50 * 1024 ** 2 },
  whisper: { port: 17999, gpu: 'off', threads: 2 },
  ffmpeg: SYSTEM_FFMPEG,
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
  return { bus, models, media, jobs, whisper, paths }
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
