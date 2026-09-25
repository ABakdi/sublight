import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SubtitleTrack } from '@sublight/core'
import type { LiveJob } from '@sublight/protocol'
import type { WhisperWorker } from '../src/asr/whisper'
import type { VerboseJson } from '../src/asr/words'
import type { RunContext } from '../src/jobs/queue'
import { LiveHub } from '../src/live/hub'
import { liveRunner, mergeByMediaRange } from '../src/live/runner'
import { LiveSession, SAMPLE_RATE, splitStable, wavBytes } from '../src/live/session'
import type { ModelManager } from '../src/models/manager'
import type { GpuResidency } from '../src/workers/gpu'

const tmp = () => mkdtempSync(join(tmpdir(), 'sublight-live-'))
const w = (word: string, startMs: number, endMs: number) => ({ word, startMs, endMs })

/** `ms` of a loud 440 Hz tone as s16le PCM (non-silent). */
function tone(ms: number): Buffer {
  const n = Math.round((ms * SAMPLE_RATE) / 1000)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)), i * 2)
  return b
}

describe('live session timeline (Spec 08 §4)', () => {
  it('maps capture time to media time through play, pause and seek anchors', () => {
    const s = new LiveSession(join(tmp(), 'a.pcm'))
    s.append(tone(10_000), 1_000_000) // 10 s captured from wall 1 000 000
    s.anchor({ wallMs: 1_000_000, mediaMs: 60_000, rate: 1, playing: true })
    s.anchor({ wallMs: 1_004_000, mediaMs: 64_000, rate: 1, playing: false }) // pause at 64 s
    s.anchor({ wallMs: 1_006_000, mediaMs: 30_000, rate: 1, playing: true }) // seek back to 30 s, play
    expect(s.mediaAtWall(1_002_000)).toBe(62_000)
    expect(s.mediaAtWall(1_005_000)).toBe(64_000) // paused: frozen
    expect(s.mediaAtWall(1_008_000)).toBe(32_000)
    // Words during the pause are dropped; the rest land on the media timeline.
    const words = s.toMedia(
      [w('before', 1000, 1500), w('paused', 4500, 5000), w('after', 7000, 7400)],
      0,
    )
    expect(words).toEqual([w('before', 61_000, 61_500), w('after', 31_000, 31_400)])
    expect(s.playingSegments().map((x) => [x.from / SAMPLE_RATE, x.to / SAMPLE_RATE])).toEqual([
      [0, 4],
      [6, 10],
    ])
    s.close()
  })

  it('honours playback speed and out-of-order anchors', () => {
    const s = new LiveSession(join(tmp(), 'b.pcm'))
    s.append(tone(4000), 500)
    s.anchor({ wallMs: 2500, mediaMs: 13_000, rate: 1.5, playing: true })
    s.anchor({ wallMs: 500, mediaMs: 10_000, rate: 1, playing: true })
    expect(s.mediaAtWall(1500)).toBe(11_000)
    expect(s.mediaAtWall(3500)).toBe(14_500)
    s.close()
  })

  it('reads back exactly the samples it stored, across chunks', () => {
    const s = new LiveSession(join(tmp(), 'c.pcm'))
    s.append(tone(500), 0)
    s.append(tone(500), 700) // capture gap of 200 ms between chunks
    expect(s.totalSamples).toBe(16_000)
    expect(s.read(0, 16_000)).toHaveLength(16_000)
    expect(s.wallAt(8000)).toBe(700)
    expect(s.sampleAtWall(710)).toBe(8160)
    expect(wavBytes(s.read(0, 100)).length).toBe(44 + 200)
    s.close()
  })
})

describe('commit policy', () => {
  it('keeps the last few seconds tentative', () => {
    const words = [w('a', 0, 500), w('b', 3000, 3500), w('c', 7200, 7600)]
    expect(splitStable(words, 8000, 3000)).toEqual({
      committed: [words[0], words[1]],
      tentative: [words[2]],
    })
    expect(splitStable(words, 8000, 0).tentative).toEqual([])
  })

  it('replaces a re-watched media range with the newer words', () => {
    const old = [w('one', 0, 500), w('two', 1000, 1500), w('three', 5000, 5500)]
    expect(mergeByMediaRange(old, [w('TWO', 900, 1600)]).map((x) => x.word)).toEqual([
      'one',
      'TWO',
      'three',
    ])
  })
})

/** A fake whisper that "hears" one word per second of audio it's given. */
function fakeWhisper() {
  const calls: number[] = []
  const whisper = {
    residentModel: null,
    ensure: async () => {},
    stop: async () => {},
    infer: async (wav: Buffer): Promise<VerboseJson> => {
      const ms = ((wav.length - 44) / 2 / SAMPLE_RATE) * 1000
      calls.push(ms)
      const words = []
      for (let t = 0; t + 600 <= ms; t += 1000)
        words.push({ word: ` w${Math.round(t / 1000)}`, start: t / 1000, end: (t + 600) / 1000 })
      return {
        task: 'transcribe',
        language: 'english',
        duration: ms / 1000,
        text: '',
        segments: [{ id: 0, text: '', words }],
      }
    },
  } as unknown as WhisperWorker
  return { whisper, calls }
}

const models = {
  entry: () => ({ role: 'asr', tasks: ['transcribe', 'translate'] }),
  isInstalled: () => true,
  pathOf: () => '/m.bin',
} as unknown as ModelManager
const gpu = { use: async () => {} } as unknown as GpuResidency
const job: LiveJob = { type: 'live', model: 'whisper-small', params: { language: 'en' } }

function ctx(jobId: string) {
  const partials: SubtitleTrack[] = []
  const c: RunContext = {
    jobId,
    signal: new AbortController().signal,
    progress: () => {},
    partial: (t) => partials.push(t),
    chunkDir: () => tmp(),
  }
  return { c, partials }
}

describe('live runner', () => {
  it('streams drafts while audio arrives, then refines on stop', async () => {
    const hub = new LiveHub(tmp())
    const { whisper, calls } = fakeWhisper()
    const run = liveRunner({
      models,
      whisper,
      gpu,
      hub,
      options: { stepMs: 20, minNewMs: 500, holdMs: 1500 },
    })
    const { c, partials } = ctx('j1')
    const session = hub.get('j1')
    const wall0 = Date.now()
    session.anchor({ wallMs: wall0, mediaMs: 120_000, rate: 1, playing: true })
    const done = run.run(job, c)
    for (let i = 0; i < 6; i++) {
      session.append(tone(1000), wall0 + i * 1000)
      await new Promise((r) => setTimeout(r, 60))
    }
    session.stopping = true
    const out = await done
    expect(partials.length).toBeGreaterThan(0)
    expect(partials.every((t) => t.draft)).toBe(true)
    const final = out.tracks[0]!
    expect(final.draft).toBeUndefined()
    const words = final.cues.flatMap((q) => q.words ?? [])
    // Refinement heard the 6 s stretch in one pass: w0..w5, placed at media 120 s+.
    expect(words.map((x) => x.word)).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w5'])
    expect(words[0]!.startMs).toBe(120_000)
    expect(calls.at(-1)).toBe(6000)
    expect(hub.has('j1')).toBe(false) // session closed
  })

  it('stops by itself when audio stops arriving', async () => {
    const hub = new LiveHub(tmp())
    const run = liveRunner({
      models,
      whisper: fakeWhisper().whisper,
      gpu,
      hub,
      options: { stepMs: 10, idleTimeoutMs: 100 },
    })
    const session = hub.get('j2')
    session.anchor({ wallMs: Date.now(), mediaMs: 0, rate: 1, playing: true })
    session.append(tone(2000), Date.now())
    const out = await run.run(job, ctx('j2').c)
    expect(out.tracks[0]!.cues.length).toBeGreaterThan(0)
  })

  it('keeps the live words when refinement comes back with fewer', async () => {
    const hub = new LiveHub(tmp())
    let callsWhileStopping = 0
    const whisper = {
      ensure: async () => {},
      infer: async (wav: Buffer): Promise<VerboseJson> => {
        const ms = ((wav.length - 44) / 2 / SAMPLE_RATE) * 1000
        // After stop: the final live pass still hears the words; refinement hears nothing.
        if (hub.get('j3').stopping) callsWhileStopping++
        const words =
          callsWhileStopping > 1
            ? []
            : [
                { word: ' hello', start: 0.1, end: 0.6 },
                { word: ' world', start: 1.1, end: 1.6 },
              ]
        return {
          task: 'transcribe',
          language: 'english',
          duration: ms / 1000,
          text: '',
          segments: [{ id: 0, text: '', words }],
        }
      },
    } as unknown as WhisperWorker
    const run = liveRunner({ models, whisper, gpu, hub, options: { stepMs: 10, minNewMs: 500 } })
    const session = hub.get('j3')
    session.anchor({ wallMs: 0, mediaMs: 0, rate: 1, playing: true })
    session.append(tone(3000), 0)
    const done = run.run(job, ctx('j3').c)
    await new Promise((r) => setTimeout(r, 80))
    session.stopping = true
    const words = (await done).tracks[0]!.cues.flatMap((q) => q.words ?? [])
    expect(words.map((x) => x.word)).toEqual(['hello', 'world'])
  })
})

describe('live runner efficiency', () => {
  it('does not re-transcribe when no new audio arrived', async () => {
    const hub = new LiveHub(tmp())
    const { whisper, calls } = fakeWhisper()
    const run = liveRunner({
      models,
      whisper,
      gpu,
      hub,
      options: { stepMs: 10, minNewMs: 500, holdMs: 5000 },
    })
    const session = hub.get('j4')
    session.anchor({ wallMs: 0, mediaMs: 0, rate: 1, playing: true })
    session.append(tone(2000), 0)
    const done = run.run(job, ctx('j4').c)
    await new Promise((r) => setTimeout(r, 150)) // ~15 steps with nothing new
    session.stopping = true
    await done
    // one live pass, the final pass, one refinement pass
    expect(calls.length).toBeLessThanOrEqual(3)
  })
})
