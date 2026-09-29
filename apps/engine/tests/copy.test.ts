import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UrlJob } from '@sublight/protocol'
import { aheadRunner } from '../src/asr/ahead'
import type { WhisperWorker } from '../src/asr/whisper'
import type { VerboseJson } from '../src/asr/words'
import { SAMPLE_RATE, wavBytes } from '../src/live/session'
import { relayResponse, RelayStore, type Download } from '../src/media/relay'
import { resolveRemote, type RemoteMedia } from '../src/media/remote'
import type { ModelManager } from '../src/models/manager'

/**
 * Sites whose video links stop working soon after their page stops playing
 * (the Beta-1 checkpoint, B8: vinovo.to). The engine saves a copy while the
 * link works, serves and captions it, and says why when the link is refused.
 */
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const tmp = () => mkdtempSync(join(tmpdir(), 'sublight-copy-'))
const FFMPEG = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }

describe.skipIf(!hasFfmpeg)('a page video whose link expires', () => {
  let video: Buffer
  let server: Server
  let base = ''
  /** The site's link: works until `expired`, then 403 like vinovo's CDN. */
  let expired = false

  beforeAll(async () => {
    const path = join(tmp(), 'clip.mp4')
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-f',
      'lavfi',
      '-i',
      'color=size=64x64:duration=4',
      '-shortest',
      '-movflags',
      '+faststart',
      path,
    ])
    video = readFileSync(path)
    server = createServer((req, res) => {
      if (expired || req.url !== '/stream/token') {
        res.writeHead(403).end('Forbidden')
        return
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': video.length })
      res.end(video)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  const until = async (check: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('saves a copy while the link works, and serves it after the link dies', async () => {
    expired = false
    const store = new RelayStore(tmp())
    const media: RemoteMedia = {
      input: `${base}/stream/token`,
      headers: {},
      durationMs: 4000,
      title: null,
      via: 'direct',
    }
    const id = store.add(media, Date.now(), { copyWith: 'ffmpeg' })
    expect(store.status(id)).toMatchObject({ state: 'ready', copy: { state: 'downloading' } })
    await until(() => store.localCopy(id)?.state === 'ready')
    expect(store.status(id)).toMatchObject({
      state: 'ready',
      copy: { state: 'ready', progress: 1 },
    })

    expired = true
    const r = await relayResponse(
      store.get(id)!,
      new Request('http://127.0.0.1/v1/relay/x', { headers: { range: 'bytes=0-99' } }),
    )
    expect(r.status).toBe(206)
    expect(r.headers.get('content-type')).toBe('video/mp4')
  })

  it('says the site refused its link, not "Unsupported URL"', async () => {
    expired = true
    // A yt-dlp that doesn't know the site, as for vinovo.to.
    const ytDlp = join(tmp(), 'yt-dlp')
    writeFileSync(
      ytDlp,
      '#!/bin/sh\necho "ERROR: Unsupported URL: https://vinovo.test/e/1" >&2\nexit 1\n',
    )
    chmodSync(ytDlp, 0o755)
    const failure = resolveRemote(
      { ffmpeg: FFMPEG, ytDlp, allowPrivateNetworks: true },
      'https://vinovo.test/e/1',
      `${base}/stream/token`,
    )
    await expect(failure).rejects.toMatchObject({ code: 'MEDIA_UNREACHABLE' })
    const message = await failure.catch((e: Error) => e.message)
    expect(message).toMatch(/the site refused its link to this video \(.*403/)
    expect(message).not.toMatch(/Unsupported URL/)
    expect(message).not.toContain(base) // no link in the message (or the log)
  })

  it('captions the saved copy instead of the dead link', async () => {
    const file = join(tmp(), 'copy.mp4')
    writeFileSync(file, video)
    const copy: Download = { path: file, state: 'downloading', progress: 0.4 }
    const inputs: string[] = []
    const details: string[] = []
    const runner = aheadRunner({
      models: {
        entry: () => ({ role: 'asr', tasks: ['transcribe'] }),
        isInstalled: () => true,
        pathOf: () => '/m.bin',
      } as unknown as ModelManager,
      whisper: {
        ensure: async () => {},
        infer: async (): Promise<VerboseJson> => ({
          task: 'transcribe',
          language: 'english',
          duration: 4,
          text: '',
          segments: [{ id: 0, text: '', words: [{ word: ' hello', start: 0.5, end: 1 }] }],
        }),
      } as unknown as WhisperWorker,
      ffmpeg: FFMPEG,
      ytDlp: null,
      relays: { localCopy: (id) => (id === 'a'.repeat(32) ? copy : null) },
      resolve: async () => {
        throw new Error('the dead link must not be used')
      },
      slice: async (m, out, _s, durationMs) => {
        inputs.push(m.input)
        const pcm = new Int16Array(Math.round((durationMs * SAMPLE_RATE) / 1000))
        for (let i = 0; i < pcm.length; i++)
          pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE))
        writeFileSync(out, wavBytes(pcm))
      },
    })
    const job: UrlJob = {
      type: 'url',
      pageUrl: 'https://vinovo.test/e/1',
      mediaUrl: `${base}/stream/token`,
      relayId: 'a'.repeat(32),
      model: 'whisper-small',
      params: { language: 'en' },
    }
    expect(() => runner.validate(job)).not.toThrow()
    expect(() => runner.validate({ ...job, relayId: '../x' })).toThrow(/relayId/)
    setTimeout(() => (copy.state = 'ready'), 300)
    const out = await runner.run(job, {
      jobId: 'c1',
      signal: new AbortController().signal,
      progress: (_p, d) => d && details.push(d),
      partial: () => {},
      chunkDir: () => tmp(),
    })
    expect(details).toContain('saving the video (40 %)')
    expect(inputs.length).toBeGreaterThan(0)
    expect(inputs.every((i) => i === file)).toBe(true)
    expect(out.tracks[0]!.cues.map((c) => c.text.trim())).toEqual(['hello'])
  })
})
