import { describe, expect, it } from 'vitest'
import { validateCues } from '@sublight/core'
import { segmentsFromVerbose, wordsFromVerbose, type VerboseJson } from '../src/asr/words'
import { cuesFromSegments } from '../src/asr/segments'
import { CHUNK_OVERLAP_MS, mergeWords, planChunks } from '../src/asr/transcribe'
import { whisperLanguageCode } from '../src/asr/languages'

/** Shape of whisper-server v1.9.4 verbose_json: "words" are BPE tokens. */
const verbose: VerboseJson = {
  task: 'transcribe',
  language: 'english',
  duration: 4,
  text: 'And so, my fellow Americans',
  segments: [
    {
      id: 0,
      text: ' And so, my fellow Americans',
      start: 0.3,
      end: 3.9,
      words: [
        { word: '[_BEG_]', start: 0, end: 0, t_dtw: -1, probability: 1 },
        { word: ' And', start: 0.32, end: 0.61, t_dtw: 35, probability: 0.9 },
        { word: ' so', start: 0.61, end: 0.9, t_dtw: 66, probability: 0.8 },
        { word: ',', start: 0.9, end: 0.95, t_dtw: -1, probability: 0.7 },
        { word: ' my', start: 1.1, end: 1.4, t_dtw: 112, probability: 0.95 },
        { word: ' fel', start: 1.4, end: 1.6, t_dtw: 141, probability: 0.9 },
        { word: 'low', start: 1.6, end: 1.9, t_dtw: -1, probability: 0.7 },
        { word: ' Americans', start: 2.0, end: 3.1, t_dtw: 205, probability: 0.99 },
      ],
    },
    {
      id: 1,
      text: ' [BLANK_AUDIO]',
      start: 3.9,
      end: 4,
      words: [{ word: ' [BLANK_AUDIO]', start: 3.9, end: 4, t_dtw: -1, probability: 0.5 }],
    },
  ],
}

describe('whisper verbose_json → words (ADR-0008)', () => {
  it('merges sub-word and punctuation tokens into words and drops special tokens', () => {
    const words = wordsFromVerbose(verbose)
    expect(words.map((w) => w.word)).toEqual(['And', 'so,', 'my', 'fellow', 'Americans'])
  })

  it('times words from token t0/t1; punctuation does not stretch the end', () => {
    const [and, so, , fellow] = wordsFromVerbose(verbose)
    expect(and).toMatchObject({ startMs: 320, endMs: 610 })
    // "," (0.90-0.95 s) joins "so" without moving its end.
    expect(so).toMatchObject({ startMs: 610, endMs: 900 })
    expect(fellow).toMatchObject({ startMs: 1400, endMs: 1900 })
  })

  it('ignores DTW times, which lag the onset on whisper.cpp v1.9.4', () => {
    const words = wordsFromVerbose(verbose)
    expect(words.map((w) => w.startMs)).toEqual([320, 610, 1100, 1400, 2000])
  })

  it('does not let a trailing punctuation token span the next pause', () => {
    const words = wordsFromVerbose({
      ...verbose,
      segments: [
        {
          id: 0,
          text: ' Americans, ask',
          words: [
            { word: ' Americans', start: 1.75, end: 2.11 },
            { word: ',', start: 3.29, end: 3.49 },
            { word: ' ask', start: 3.49, end: 4.24 },
          ],
        },
      ],
    })
    expect(words[0]).toMatchObject({ word: 'Americans,', startMs: 1750, endMs: 2110 })
  })

  it('averages token probabilities into a confidence', () => {
    expect(wordsFromVerbose(verbose)[3]!.confidence).toBe(0.8)
  })

  it('shifts by the chunk offset', () => {
    expect(wordsFromVerbose(verbose, 600_000)[0]!.startMs).toBe(600_320)
  })

  it('keeps words monotonic and at least 10 ms long', () => {
    const words = wordsFromVerbose({
      ...verbose,
      segments: [
        {
          id: 0,
          text: ' a b',
          words: [
            { word: ' a', start: 1, end: 1.5, t_dtw: -1 },
            { word: ' b', start: 1.2, end: 1.2, t_dtw: -1 },
          ],
        },
      ],
    })
    expect(words[0]!.endMs).toBeLessThanOrEqual(words[1]!.startMs)
    for (const w of words) expect(w.endMs - w.startMs).toBeGreaterThanOrEqual(10)
  })

  it('joins a word that whisper split across two segments', () => {
    const words = wordsFromVerbose({
      ...verbose,
      segments: [
        {
          id: 0,
          text: ' Träumen erw',
          words: [
            { word: ' Träumen', start: 3, end: 3.5 },
            { word: ' erw', start: 3.6, end: 3.9 },
          ],
        },
        {
          id: 1,
          text: 'achte,',
          words: [
            { word: 'achte', start: 4, end: 4.4 },
            { word: ',', start: 4.4, end: 4.4 },
          ],
        },
      ],
    })
    expect(words.map((w) => w.word)).toEqual(['Träumen', 'erwachte,'])
    expect(words[1]).toMatchObject({ startMs: 3600, endMs: 4400 })
  })

  it('reads segments for translate runs, dropping non-speech markers', () => {
    const segs = segmentsFromVerbose(verbose)
    expect(segs).toEqual([{ startMs: 300, endMs: 3900, text: 'And so, my fellow Americans' }])
  })
})

describe('segment-timed cues (Whisper translate, ADR-0018)', () => {
  it('splits long segments at punctuation, timed by character share, valid per Spec 02', () => {
    const cues = cuesFromSegments(
      [
        {
          startMs: 0,
          endMs: 12_000,
          text: 'The first sentence is here. And then a second one follows, with a clause.',
        },
        { startMs: 12_500, endMs: 14_000, text: 'Short.' },
      ],
      7000,
    )
    expect(cues.map((c) => c.text.replace(/\n/g, ' '))).toEqual([
      'The first sentence is here.',
      'And then a second one follows, with a clause.',
      'Short.',
    ])
    expect(cues[0]!.startMs).toBe(0)
    expect(cues[1]!.endMs).toBe(12_000)
    expect(validateCues(cues).valid).toBe(true)
  })
})

describe('short translate segments', () => {
  it('merge into a neighbour when the result fits one cue', () => {
    const cues = cuesFromSegments(
      [
        {
          startMs: 0,
          endMs: 7989,
          text: 'As Gregor Samsa awoke from restless dreams one morning,',
        },
        { startMs: 7989, endMs: 8280, text: 'he' },
        { startMs: 8280, endMs: 9220, text: 'found himself in his bed,' },
      ],
      9000, // the first segment alone is ~8 s
    )
    expect(cues.map((c) => c.text.replace(/\n/g, ' '))).toEqual([
      'As Gregor Samsa awoke from restless dreams one morning,',
      'he found himself in his bed,',
    ])
  })
})

describe('dangling words at segment ends', () => {
  it('move to the next segment when it continues the sentence', () => {
    const cues = cuesFromSegments(
      [
        {
          startMs: 0,
          endMs: 8280,
          text: 'As Gregor Samsa awoke from restless dreams one morning, he',
        },
        { startMs: 8280, endMs: 12060, text: 'found himself in his bed, transformed.' },
        { startMs: 12100, endMs: 14000, text: 'He lay on his back.' },
      ],
      9000, // keep the ~8 s sentence whole; this test is about the carry
    )
    expect(cues.map((c) => c.text.replace(/\n/g, ' '))).toEqual([
      'As Gregor Samsa awoke from restless dreams one morning,',
      'he found himself in his bed, transformed.',
      'He lay on his back.',
    ])
    expect(validateCues(cues).valid).toBe(true)
  })
})

describe('long-form chunking (Spec 07 §1.6)', () => {
  it('plans chunks with overlap, last chunk trimmed to the duration', () => {
    const chunks = planChunks(25 * 60_000, 600_000)
    expect(chunks.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 600_000],
      [600_000, 1_200_000],
      [1_200_000, 1_500_000],
    ])
    expect(chunks[0]!.sliceMs).toBe(600_000 + CHUNK_OVERLAP_MS)
    expect(chunks[2]!.sliceMs).toBe(300_000)
  })

  it('defaults to 2-min chunks and plans one chunk for short or empty audio', () => {
    expect(planChunks(5 * 60_000).map((c) => c.startMs)).toEqual([0, 120_000, 240_000])
    expect(planChunks(4000)).toHaveLength(1)
    expect(planChunks(0)).toHaveLength(1)
  })

  it('keeps each word once across the overlap', () => {
    const merged = [
      { word: 'a', startMs: 599_000, endMs: 599_600 },
      { word: 'b', startMs: 599_700, endMs: 600_400 },
    ]
    mergeWords(
      merged,
      [
        { word: 'b', startMs: 600_000, endMs: 600_400 }, // cut-off copy of "b"
        { word: 'c', startMs: 600_500, endMs: 601_000 },
      ],
      1_200_000,
    )
    expect(merged.map((w) => w.word)).toEqual(['a', 'b', 'c'])
  })
})

describe('language names', () => {
  it('maps whisper names and codes to codes', () => {
    expect(whisperLanguageCode('english')).toBe('en')
    expect(whisperLanguageCode('German')).toBe('de')
    expect(whisperLanguageCode('ar')).toBe('ar')
    expect(whisperLanguageCode('klingon')).toBeNull()
  })
})
