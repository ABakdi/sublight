import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SubtitleTrack } from '@sublight/core'
import type { UrlJob } from '@sublight/protocol'
import {
  aheadRunner,
  canonicalPageUrl,
  composeWords,
  overlapEnd,
  quietestMs,
  coverageOf,
  FIRST_PIECE_MS,
  nextRange,
} from '../src/asr/ahead'
import type { WhisperWorker } from '../src/asr/whisper'
import type { VerboseJson } from '../src/asr/words'
import type { RunContext } from '../src/jobs/queue'
import { SAMPLE_RATE, wavBytes } from '../src/live/session'
import type { RemoteMedia } from '../src/media/remote'
import type { ModelManager } from '../src/models/manager'

const tmp = () => mkdtempSync(join(tmpdir(), 'sublight-ahead-'))
const w = (word: string, startMs: number, endMs: number) => ({ word, startMs, endMs })

describe('planning pieces around the playhead', () => {
  it('starts at the playhead, goes forward, then fills in before it', () => {
    const dur = 600_000
    expect(nextRange([], dur, 200_000, 30_000)).toEqual({ startMs: 200_000, endMs: 230_000 })
    const done = [{ startMs: 200_000, endMs: 230_000 }]
    expect(nextRange(done, dur, 200_000, 120_000)).toEqual({ startMs: 230_000, endMs: 350_000 })
    const later = [...done, { startMs: 230_000, endMs: 600_000 }]
    expect(nextRange(later, dur, 200_000, 120_000)).toEqual({ startMs: 0, endMs: 120_000 })
    expect(nextRange([{ startMs: 0, endMs: dur }], dur, 0, 30_000)).toBeNull()
    // Only the part before the playhead is left: all of it, never an empty range.
    expect(nextRange([{ startMs: 50_000, endMs: dur }], dur, 50_000, 120_000)).toEqual({
      startMs: 0,
      endMs: 50_000,
    })
  })
  it("doesn't leave slivers", () => {
    // Playhead 4 s in: start at 0. Rest under 10 s: take it now.
    expect(nextRange([], 300_000, 4000, 30_000)).toEqual({ startMs: 0, endMs: 30_000 })
    expect(nextRange([], 36_000, 0, 30_000)).toEqual({ startMs: 0, endMs: 36_000 })
  })
})

describe('joining pieces', () => {
  it('drops words a touching earlier piece already has', () => {
    const words = composeWords([
      { startMs: 30_000, endMs: 60_000, words: [w('b', 29_980, 30_400), w('c', 31_000, 31_300)] },
      { startMs: 0, endMs: 30_000, words: [w('a', 29_600, 30_390)] },
    ])
    expect(words.map((x) => x.word)).toEqual(['a', 'c'])
    expect(
      coverageOf([
        { startMs: 30_000, endMs: 60_000 },
        { startMs: 0, endMs: 30_000 },
        { startMs: 90_000, endMs: 95_000 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 60_000 },
      { startMs: 90_000, endMs: 95_000 },
    ])
  })
  it('keys the cache on the video, not the start time', () => {
    expect(canonicalPageUrl('https://www.youtube.com/watch?v=abc&t=120s#x')).toBe(
      'https://www.youtube.com/watch?v=abc',
    )
  })
})

describe('url runner', () => {
  const models = {
    entry: () => ({ role: 'asr', tasks: ['transcribe', 'translate'] }),
    isInstalled: () => true,
    pathOf: () => '/m.bin',
  } as unknown as ModelManager
  const media: RemoteMedia = {
    input: 'https://example.test/a.mp4',
    headers: {},
    durationMs: 100_000,
    title: 'Clip',
    via: 'direct',
  }
  /** A loud tone for every slice, so nothing is skipped as silence. */
  const slice = async (_m: RemoteMedia, out: string, _s: number, durationMs: number) => {
    const n = Math.round((durationMs * SAMPLE_RATE) / 1000)
    const pcm = new Int16Array(n)
    for (let i = 0; i < n; i++)
      pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE))
    writeFileSync(out, wavBytes(pcm))
  }
  /** One word per second of audio. */
  const whisper = {
    ensure: async () => {},
    infer: async (wav: Buffer): Promise<VerboseJson> => {
      const ms = ((wav.length - 44) / 2 / SAMPLE_RATE) * 1000
      const words = []
      for (let t = 0; t + 600 <= ms; t += 1000)
        words.push({ word: ` w`, start: t / 1000, end: (t + 600) / 1000 })
      return {
        task: 'transcribe',
        language: 'english',
        duration: ms / 1000,
        text: '',
        segments: [{ id: 0, text: '', words }],
      }
    },
  } as unknown as WhisperWorker
  const job: UrlJob = {
    type: 'url',
    pageUrl: 'https://example.test/watch',
    model: 'whisper-small',
    params: { language: 'en', fromMs: 50_000 },
  }

  it('captions the playhead first, then the whole video, with coverage on drafts', async () => {
    const runner = aheadRunner({
      models,
      whisper,
      ffmpeg: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      ytDlp: null,
      resolve: async () => media,
      slice,
    })
    const partials: SubtitleTrack[] = []
    const ctx: RunContext = {
      jobId: 'u1',
      signal: new AbortController().signal,
      progress: () => {},
      partial: (t) => partials.push(t),
      chunkDir: () => tmp(),
    }
    const out = await runner.run(job, ctx)
    expect(partials[0]!.coverage).toEqual([{ startMs: 50_000, endMs: 50_000 + FIRST_PIECE_MS }])
    expect(partials[0]!.cues[0]!.startMs).toBeGreaterThanOrEqual(50_000)
    const final = out.tracks[0]!
    expect(final.draft).toBeUndefined()
    const starts = final.cues.flatMap((c) => c.words ?? []).map((x) => x.startMs)
    expect(starts[0]).toBeLessThan(2000) // the start was filled in too
    expect(starts.at(-1)).toBeGreaterThan(98_000)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })

  it('moves to a new playhead after a seek', async () => {
    const runner = aheadRunner({
      models,
      whisper,
      ffmpeg: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      ytDlp: null,
      resolve: async () => media,
      slice: async (m, out, s, d) => {
        await slice(m, out, s, d)
        if (s < 40_000) runner.focus('u2', 20_000) // seek during the first piece
      },
    })
    const partials: SubtitleTrack[] = []
    await runner.run(
      { ...job, params: { language: 'en', fromMs: 0 } },
      {
        jobId: 'u2',
        signal: new AbortController().signal,
        progress: () => {},
        partial: (t) => partials.push(t),
        chunkDir: () => tmp(),
      },
    )
    expect(partials[1]!.coverage).toEqual([{ startMs: 0, endMs: 60_000 }])
  })
})

describe('url runner failures', () => {
  it('reports audio that could not be fetched instead of an empty track', async () => {
    const runner = aheadRunner({
      models: {
        entry: () => ({ role: 'asr', tasks: ['transcribe'] }),
        isInstalled: () => true,
        pathOf: () => '/m.bin',
      } as unknown as ModelManager,
      whisper: { ensure: async () => {} } as unknown as WhisperWorker,
      ffmpeg: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      ytDlp: null,
      resolve: async () => ({
        input: 'x',
        headers: {},
        durationMs: 60_000,
        title: null,
        via: 'direct',
      }),
      slice: async (_m, out) => writeFileSync(out, wavBytes(new Int16Array(1600))), // 0.1 s
    })
    await expect(
      runner.run(
        { type: 'url', pageUrl: 'https://example.test/', model: 'm', params: { language: 'en' } },
        {
          jobId: 'f1',
          signal: new AbortController().signal,
          progress: () => {},
          partial: () => {},
          chunkDir: () => tmp(),
        },
      ),
    ).rejects.toMatchObject({ code: 'MEDIA_UNREACHABLE' })
  })
})

describe('bilingual url job', () => {
  it('returns the English translation and the original, drafts carry both', async () => {
    const calls: boolean[] = []
    const runner = aheadRunner({
      models: {
        entry: () => ({ role: 'asr', tasks: ['transcribe', 'translate'] }),
        isInstalled: () => true,
        pathOf: () => '/m.bin',
      } as unknown as ModelManager,
      whisper: {
        ensure: async () => {},
        infer: async (wav: Buffer, p: { translate: boolean }): Promise<VerboseJson> => {
          calls.push(p.translate)
          const ms = ((wav.length - 44) / 2 / SAMPLE_RATE) * 1000
          const words = []
          for (let t = 0; t + 600 <= ms; t += 1000)
            words.push({
              word: p.translate ? ' en' : ' de',
              start: t / 1000,
              end: (t + 600) / 1000,
            })
          return {
            task: p.translate ? 'translate' : 'transcribe',
            language: 'german',
            duration: ms / 1000,
            text: '',
            segments: [
              {
                id: 0,
                text: p.translate ? ' Hello there.' : ' Hallo.',
                start: 0,
                end: ms / 1000,
                words,
              },
            ],
          }
        },
      } as unknown as WhisperWorker,
      ffmpeg: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      ytDlp: null,
      resolve: async () => ({
        input: 'x',
        headers: {},
        durationMs: 20_000,
        title: 'Clip',
        via: 'direct',
      }),
      slice: async (_m, out, _s, d) => {
        const n = Math.round((d * SAMPLE_RATE) / 1000)
        const pcm = new Int16Array(n)
        for (let i = 0; i < n; i++)
          pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE))
        writeFileSync(out, wavBytes(pcm))
      },
    })
    const partials: { draft: SubtitleTrack; companion?: SubtitleTrack }[] = []
    const out = await runner.run(
      {
        type: 'url',
        pageUrl: 'https://example.test/',
        model: 'whisper-small',
        params: { language: null, task: 'translate', bilingual: true },
      },
      {
        jobId: 'bi1',
        signal: new AbortController().signal,
        progress: () => {},
        partial: (draft, companion) =>
          partials.push({ draft, ...(companion ? { companion } : {}) }),
        chunkDir: () => tmp(),
      },
    )
    expect(calls).toEqual([true, false]) // one piece: translate, then transcribe
    expect(out.tracks.map((t) => [t.kind, t.language])).toEqual([
      ['translation', 'en'],
      ['transcript', 'de'],
    ])
    expect(partials[0]!.companion?.language).toBe('de')
  })
})

describe('protected streams', () => {
  it('spots DRM in an HLS playlist, not plain AES-128', async () => {
    const { isDrmPlaylist } = await import('../src/media/remote')
    expect(
      isDrmPlaylist(
        '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm",KEYFORMAT="com.apple.streamingkeydelivery"\n',
      ),
    ).toBe(true)
    expect(isDrmPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://k.example/key"\n')).toBe(
      false,
    )
    expect(isDrmPlaylist('#EXTM3U\n#EXTINF:6,\nseg0.ts\n')).toBe(false)
  })
})

describe('joining pieces at their boundary (Beta-1 checkpoint)', () => {
  // Words as [text, startMs]; each lasts 300 ms.
  const ws = (list: [string, number][]) =>
    list.map(([word, startMs]) => ({ word, startMs, endMs: startMs + 300 }))
  const text = (words: { word: string }[]) => words.map((w) => w.word).join(' ')

  it('neither doubles nor loses a word the two passes time differently', () => {
    // Seen on a German video at 30 s: "sehen," twice and "Licht" gone.
    const first = {
      startMs: 0,
      endMs: 30_000,
      words: ws([
        ['nur', 28_000],
        ['die', 28_300],
        ['Teile', 28_600],
        ['des', 28_900],
        ['Universums', 29_200],
        ['sehen,', 29_800],
      ]),
    }
    const second = {
      startMs: 30_000,
      endMs: 60_000,
      words: ws([
        ['sehen,', 30_050],
        ['deren', 30_400],
        ['uns', 31_000],
        ['erreicht', 31_400],
      ]),
      heard: ws([
        ['Teile', 28_500],
        ['des', 28_800],
        ['Universums', 29_300],
        ['sehen,', 30_050],
        ['deren', 30_400],
        ['Licht', 30_700],
        ['uns', 31_000],
        ['erreicht', 31_400],
      ]),
    }
    const out = composeWords([second, first])
    expect(text(out)).toBe('nur die Teile des Universums sehen, deren Licht uns erreicht')
    for (let i = 1; i < out.length; i++)
      expect(out[i]!.startMs).toBeGreaterThan(out[i - 1]!.startMs)
  })

  it('falls back to time without an overlap, still dropping a repeated word', () => {
    const first = {
      startMs: 0,
      endMs: 30_000,
      words: ws([
        ['hello', 29_000],
        ['there', 29_700],
      ]),
    }
    const second = {
      startMs: 30_000,
      endMs: 60_000,
      words: ws([
        ['there', 30_010],
        ['friend', 30_400],
      ]),
      heard: ws([
        ['completely', 28_000],
        ['different', 29_000],
        ['there', 30_010],
        ['friend', 30_400],
      ]),
    }
    expect(text(composeWords([first, second]))).toBe('hello there friend')
  })

  it('keeps what only the later piece heard just before the cut', () => {
    // The earlier pass dropped its last words; the later one heard them in its context.
    const first = {
      startMs: 0,
      endMs: 30_000,
      words: ws([
        ['Jahren', 28_000],
        ['erreicht', 28_400],
      ]),
    }
    const second = {
      startMs: 30_000,
      endMs: 60_000,
      words: ws([
        ['Kugel', 30_200],
        ['und', 30_700],
      ]),
      heard: ws([
        ['Schauen', 29_000],
        ['wir', 29_300],
        ['eine', 29_800],
        ['Kugel', 30_200],
        ['und', 30_700],
      ]),
    }
    expect(text(composeWords([first, second]))).toBe('Jahren erreicht Schauen wir eine Kugel und')
  })

  it('trusts a lone matching word only when it was heard at about the same time', () => {
    const kept = ws([
      ['a', 29_000],
      ['yes', 29_800],
    ])
    expect(
      overlapEnd(
        kept,
        ws([
          ['yes', 30_100],
          ['b', 30_500],
        ]),
        30_000,
      ),
    ).toBe(1)
    expect(
      overlapEnd(
        kept,
        ws([
          ['yes', 33_000],
          ['b', 33_500],
        ]),
        30_000,
      ),
    ).toBe(-1)
  })
})

describe('cutting pieces at pauses', () => {
  // 10 ms frames: speech (-20 dB) with pauses (-60 dB) at 2.0–2.5 s and 6.0–6.6 s.
  const levels = new Float32Array(1000).fill(-20)
  levels.fill(-60, 200, 250)
  levels.fill(-60, 600, 660)

  it('finds the pause nearest the planned cut', () => {
    const at = quietestMs(levels, 0, 9000, 5500)
    expect(at).toBeGreaterThanOrEqual(6000)
    expect(at).toBeLessThanOrEqual(6600)
    const early = quietestMs(levels, 0, 9000, 1000)
    expect(early).toBeGreaterThanOrEqual(2000)
    expect(early).toBeLessThanOrEqual(2500)
  })

  it('keeps the planned cut when the window is empty', () => {
    expect(quietestMs(levels, 5000, 5000, 5000)).toBe(5000)
  })
})
