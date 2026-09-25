import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validateCues, type SubtitleTrack } from '@sublight/core'
import { loadConfig, sublightHome } from '../src/config'
import { enginePaths } from '../src/paths'
import { createServices, runtimeBinary } from '../src/services'

/**
 * Live captioning with the real whisper-small (M05): the JFK sample streamed
 * as 1 s chunks, timed like a capture that starts at video time 60 s.
 * Skipped where the binary/model aren't installed (CI).
 */
const realPaths = enginePaths(sublightHome())
const config = loadConfig({ whisper: { port: 17495, gpu: 'auto', threads: 4 } })
const ready =
  existsSync(runtimeBinary('whisper', config, realPaths).binary) &&
  existsSync(join(realPaths.models, 'ggml-small.bin'))

describe.skipIf(!ready)('live captioning with whisper-small', () => {
  const paths = {
    ...enginePaths(mkdtempSync(join(tmpdir(), 'sublight-live-it-'))),
    models: realPaths.models,
    bin: realPaths.bin,
  }
  const services = createServices(config, paths)
  services.jobs.start()
  afterAll(() => services.whisper.stop())

  it('drafts while streaming and lands words on the media timeline', async () => {
    // Skip the whole RIFF header (this file has a LIST chunk; audio starts after "data" + size).
    const file = readFileSync(resolve(__dirname, 'fixtures', 'jfk.wav'))
    const pcm = file.subarray(file.indexOf('data') + 8)
    const drafts: SubtitleTrack[] = []
    services.bus.on((e) => {
      if (e.type === 'job.partial') drafts.push(e.draft)
    })
    const job = services.jobs.create({
      type: 'live',
      model: 'whisper-small',
      params: { language: 'en' },
      priority: 'interactive',
    })
    const session = services.live.get(job.id)
    const wall0 = Date.now()
    session.anchor({ wallMs: wall0, mediaMs: 60_000, rate: 1, playing: true })
    const chunk = 16000 * 2
    for (let off = 0; off < pcm.length; off += chunk) {
      session.append(pcm.subarray(off, off + chunk), wall0 + (off / 2 / 16000) * 1000)
      await new Promise((r) => setTimeout(r, 400)) // ~2.5× faster than real time
    }
    session.stopping = true
    for (let i = 0; i < 300 && services.jobs.get(job.id)!.state !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(services.jobs.get(job.id)!.error).toBeUndefined()
    const final = services.jobs.result(job.id)!.tracks[0]!
    expect(drafts.length).toBeGreaterThan(0)
    expect(validateCues(final.cues)).toEqual({ valid: true, errors: [] })
    const words = final.cues.flatMap((c) => c.words ?? [])
    expect(words.map((w) => w.word).join(' ')).toMatch(
      /fellow Americans, ask not what your country can do for you/i,
    )
    // "And" starts 0.32 s into the clip → 60.32 s of media time.
    expect(Math.abs(words[0]!.startMs - 60_320)).toBeLessThanOrEqual(150)
  }, 120_000)
})
