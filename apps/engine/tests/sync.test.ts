import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SpeechWord } from '@sublight/core'
import { estimateDelta } from '../src/asr/delta'
import { frameLevelsDb, onsetsFromLevels, speechOnsetsMs } from '../src/asr/onsets'
import { promptFrom } from '../src/asr/transcribe'
import { isLikelyHallucination } from '../src/asr/words'

const w = (startMs: number, endMs: number, word = 'x'): SpeechWord => ({ word, startMs, endMs })

/** Words with a pause before each, starting `lag` ms before the onsets. */
function spaced(onsets: number[], lag: number, jitter: (i: number) => number = () => 0) {
  return onsets.map((o, i) => w(o - lag + jitter(i), o - lag + jitter(i) + 300))
}

describe('δ auto-estimation (Spec 07 §1.4a)', () => {
  const onsets = Array.from({ length: 12 }, (_, i) => 1000 + i * 1000)

  it('recovers a consistent offset between onsets and word starts', () => {
    expect(estimateDelta(spaced(onsets, 80), onsets)).toMatchObject({ deltaMs: 80, matches: 12 })
    expect(estimateDelta(spaced(onsets, -60), onsets).deltaMs).toBe(-60)
  })

  it('stays at 0 with too few matches', () => {
    expect(estimateDelta(spaced(onsets.slice(0, 5), 80), onsets.slice(0, 5))).toMatchObject({
      deltaMs: 0,
      matches: 5,
    })
  })

  it('stays at 0 when the matches disagree (per-word jitter, not an offset)', () => {
    const jittery = spaced(onsets, 0, (i) => (i % 2 ? 100 : -100))
    const r = estimateDelta(jittery, onsets)
    expect(r).toMatchObject({ deltaMs: 0, matches: 12 })
    expect(r.spreadMs).toBeGreaterThan(150)
  })

  it('only pairs onsets with words that follow a pause', () => {
    // Each onset sits on a word that runs straight on from the one before
    // (no pause), 100 ms after a word that does follow a pause.
    const words = onsets.flatMap((o) => [w(o - 100, o), w(o, o + 300)])
    expect(estimateDelta(words, onsets)).toMatchObject({ deltaMs: 100, matches: 12 })
  })
})

describe('energy onsets', () => {
  it('finds rises above the noise floor after 150 ms of quiet', () => {
    const levels = new Float32Array(300).fill(-60)
    levels.fill(-20, 50, 80) // 0.5-0.8 s
    levels.fill(-20, 85, 100) // short dip (50 ms) — not a new onset
    levels.fill(-20, 200, 240) // 2.0 s
    expect(onsetsFromLevels(levels)).toEqual([500, 2000])
  })

  it('reads real speech: JFK onsets line up with the pauses in fixtures/README.md', () => {
    const onsets = speechOnsetsMs(resolve(__dirname, 'fixtures', 'jfk.wav'))
    for (const expected of [330, 3290, 8190]) {
      expect(onsets.some((o) => Math.abs(o - expected) <= 20)).toBe(true)
    }
  })

  it('handles an empty WAV', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sublight-onsets-')), 'empty.wav')
    writeFileSync(file, Buffer.alloc(44))
    expect(frameLevelsDb(file)).toHaveLength(0)
  })
})

describe('chunk continuity and hallucinations', () => {
  it('prompts the next chunk with the last ~200 characters', () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`)
    const prompt = promptFrom(words)!
    expect(prompt.endsWith('word99')).toBe(true)
    expect(prompt.length).toBeGreaterThanOrEqual(200)
    expect(prompt.length).toBeLessThan(220)
    expect(promptFrom([])).toBeUndefined()
  })

  it('flags text whisper invents over silence', () => {
    expect(
      isLikelyHallucination({ id: 0, text: ' Thank you.', no_speech_prob: 0.9, avg_logprob: -1.4 }),
    ).toBe(true)
    expect(
      isLikelyHallucination({ id: 0, text: ' Hello.', no_speech_prob: 0.9, avg_logprob: -0.3 }),
    ).toBe(false)
    expect(
      isLikelyHallucination({ id: 0, text: ' Hello.', no_speech_prob: 0.1, avg_logprob: -1.4 }),
    ).toBe(false)
  })
})
