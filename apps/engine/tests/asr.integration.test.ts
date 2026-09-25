import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SpeechWord } from '@sublight/core'
import { validateCues } from '@sublight/core'
import type { JobResult } from '@sublight/protocol'
import { loadConfig, sublightHome } from '../src/config'
import { enginePaths } from '../src/paths'
import { createServices, runtimeBinary } from '../src/services'

/**
 * Real ASR through the pinned whisper-server (M02 AC3). Runs only where
 * `pnpm engine:setup-whisper` built the binary and whisper-small is installed
 * in ~/.sublight/models — skipped in CI. Uses a temp home for media/jobs so it
 * never touches the user's cache.
 */
const realHome = sublightHome()
const realPaths = enginePaths(realHome)
const config = loadConfig({ whisper: { port: 17498, gpu: 'auto', threads: 4 } })
const { binary } = runtimeBinary('whisper', config, realPaths)
const modelFile = join(realPaths.models, 'ggml-small.bin')
const ready =
  existsSync(binary) && existsSync(modelFile) && spawnSync('ffmpeg', ['-version']).status === 0

describe.skipIf(!ready)('real transcription with whisper-small', () => {
  const paths = {
    ...enginePaths(mkdtempSync(join(tmpdir(), 'sublight-asr-'))),
    models: realPaths.models,
    bin: realPaths.bin,
  }
  const services = createServices(config, paths)
  services.jobs.start()
  afterAll(() => services.whisper.stop())

  async function run(params: Record<string, unknown>): Promise<JobResult> {
    await services.media.ingest(
      'jfk',
      createReadStream(resolve(__dirname, 'fixtures', 'jfk.wav')),
      'jfk.wav',
    )
    const job = services.jobs.create({
      type: 'transcribe',
      mediaHash: 'jfk',
      model: 'whisper-small',
      params: { language: null, maxCueDurationMs: 7000, ...params },
    })
    for (let i = 0; i < 600; i++) {
      const state = services.jobs.get(job.id)!.state
      if (state === 'done') return services.jobs.result(job.id)!
      if (state === 'failed') throw new Error(JSON.stringify(services.jobs.get(job.id)!.error))
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error('timed out')
  }

  it('transcribes with word timestamps close to the speech onsets', async () => {
    const result = await run({})
    const track = result.tracks[0]!
    expect(result.language).toBe('en')
    expect(validateCues(track.cues)).toEqual({ valid: true, errors: [] })
    const words: SpeechWord[] = track.cues.flatMap((c) => c.words ?? [])
    const text = words.map((w) => w.word).join(' ')
    expect(text).toMatch(/fellow Americans, ask not what your country can do for you/i)
    const onset = (word: string, nth = 0) =>
      words.filter((w) => w.word.toLowerCase().startsWith(word))[nth]!.startMs
    // Energy onsets after pauses (fixtures/README.md); target ≤ 250 ms (Requirements F4.1).
    expect(Math.abs(onset('and') - 330)).toBeLessThanOrEqual(150)
    expect(Math.abs(onset('ask', 1) - 8190)).toBeLessThanOrEqual(150)
  }, 180_000)

  it('translates to English as a segment-timed track (ADR-0018)', async () => {
    const result = await run({ task: 'translate' })
    const track = result.tracks[0]!
    expect(track).toMatchObject({
      kind: 'translation',
      language: 'en',
      derivedFrom: { sourceLanguage: 'en' },
    })
    expect(track.cues.every((c) => c.words === undefined)).toBe(true)
    expect(validateCues(track.cues).valid).toBe(true)
  }, 180_000)
})
