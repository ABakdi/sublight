import { execFileSync, spawnSync } from 'node:child_process'
import { createReadStream, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { MediaError, MediaStore } from '../src/media/store'
import { SYSTEM_FFMPEG } from '../src/media/ffmpeg'

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const fixtures = mkdtempSync(join(tmpdir(), 'sublight-media-fx-'))

/** Generate an input with ffmpeg's lavfi sources (no binary fixtures in git). */
function make(name: string, args: string[]): string {
  const out = join(fixtures, name)
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, out])
  return out
}

function store(opts: Partial<{ maxUploadBytes: number; cacheLimitBytes: number }> = {}) {
  return new MediaStore(mkdtempSync(join(tmpdir(), 'sublight-media-')), {
    ffmpeg: SYSTEM_FFMPEG,
    maxUploadBytes: opts.maxUploadBytes ?? 50 * 1024 ** 2,
    cacheLimitBytes: opts.cacheLimitBytes ?? 1024 ** 3,
  })
}

const files: Record<string, string> = {}

describe.skipIf(!hasFfmpeg)('media ingest (Spec 06 §4)', () => {
  beforeAll(() => {
    const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000']
    files.stereoAac = make('stereo.m4a', [...tone, '-ac', '2', '-c:a', 'aac'])
    files.stereoMp3 = make('stereo.mp3', [...tone, '-ac', '2', '-c:a', 'libmp3lame'])
    files.surround = make('surround.mka', [...tone, '-ac', '6', '-c:a', 'pcm_s16le'])
    files.phone = make('phone.wav', [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=300:duration=1:sample_rate=8000',
    ])
    files.silent = make('silent.wav', ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '2'])
    files.videoOnly = make('video.mp4', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x64:rate=5',
      '-t',
      '1',
      '-pix_fmt',
      'yuv420p',
    ])
  })

  it('normalizes any container/codec to 16 kHz mono PCM, keyed by the normalized hash', async () => {
    const media = store()
    for (const key of ['stereoAac', 'surround', 'phone'] as const) {
      const res = await media.ingest(`id-${key}`, createReadStream(files[key]!), `${key}`)
      expect(res.mediaHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      const wav = media.wavPath(res.mediaHash)
      const probe = JSON.parse(
        execFileSync('ffprobe', [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_streams',
          wav,
        ]).toString(),
      ) as { streams: { sample_rate: string; channels: number; codec_name: string }[] }
      expect(probe.streams[0]).toMatchObject({
        sample_rate: '16000',
        channels: 1,
        codec_name: 'pcm_s16le',
      })
      expect(res.normalizedBytes).toBe(statSync(wav).size)
      expect(res.durationMs).toBeGreaterThan(900)
    }
  })

  it('resolves uploads by media id and by hash; the same audio dedupes', async () => {
    const media = store()
    const a = await media.ingest('first', createReadStream(files.surround!), 'a')
    const b = await media.ingest('second', createReadStream(files.surround!), 'b')
    expect(b.mediaHash).toBe(a.mediaHash)
    expect(media.resolve('first')).toBe(a.mediaHash)
    expect(media.resolve(a.mediaHash)).toBe(a.mediaHash)
    expect(media.resolve('missing')).toBeNull()
    expect(media.all()).toHaveLength(1)
  })

  it('rejects silence, video without audio and oversized uploads', async () => {
    const media = store()
    await expect(media.ingest('s', createReadStream(files.silent!), null)).rejects.toMatchObject({
      code: 'AUDIO_EMPTY',
    })
    await expect(media.ingest('v', createReadStream(files.videoOnly!), null)).rejects.toMatchObject(
      { code: 'AUDIO_UNSUPPORTED' },
    )
    const tiny = store({ maxUploadBytes: 10_000 })
    const big = tiny.ingest('big', createReadStream(files.stereoMp3!), null)
    await expect(big).rejects.toBeInstanceOf(MediaError)
    await expect(big).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' })
    expect(media.all()).toHaveLength(0)
    expect(tiny.all()).toHaveLength(0)
  })

  it('rejects unsafe media ids', async () => {
    await expect(
      store().ingest('../escape', createReadStream(files.phone!), null),
    ).rejects.toMatchObject({ code: 'JOB_INVALID' })
  })

  it('evicts the least recently used entries past the cache budget', async () => {
    const media = store({ cacheLimitBytes: 100_000 }) // ~1.5 s of 16 kHz PCM
    const a = await media.ingest('a', createReadStream(files.phone!), null) // ~32 KB
    const b = await media.ingest('b', createReadStream(files.stereoAac!), null) // ~64 KB
    media.wavPath(a.mediaHash) // touch a: b is now least recently used
    const c = await media.ingest('c', createReadStream(files.surround!), null)
    const left = media.all().map((m) => m.mediaHash)
    expect(left).toContain(c.mediaHash)
    expect(left).toContain(a.mediaHash)
    expect(left).not.toContain(b.mediaHash)
  })

  it('deletes by hash, including its id aliases', async () => {
    const media = store()
    const a = await media.ingest('x', createReadStream(files.phone!), null)
    expect(media.delete(a.mediaHash)).toBe(true)
    expect(media.resolve('x')).toBeNull()
    expect(media.delete(a.mediaHash)).toBe(false)
  })
})
