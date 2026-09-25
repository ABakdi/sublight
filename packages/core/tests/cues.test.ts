import { describe, expect, it } from 'vitest'
import {
  activeCueAt,
  buildCuesFromWords,
  normalizeCues,
  wrapWords,
  MAX_CUE_DURATION_MS,
  MIN_CUE_DURATION_MS,
} from '../src/cues'
import type { SpeechWord } from '../src/types'

function w(word: string, startMs: number, endMs: number): SpeechWord {
  return { word, startMs, endMs }
}

describe('cue construction (Spec 02 §4)', () => {
  it('hard-breaks on sentence-final punctuation', () => {
    const words = [
      w('Hello', 0, 300),
      w('world.', 300, 700),
      w('Next', 800, 1100),
      w('sentence', 1100, 1600),
    ]
    const cues = buildCuesFromWords(words)
    expect(cues).toHaveLength(2)
    expect(cues[0]!.text).toContain('world.')
    expect(cues[1]!.text).toContain('Next')
  })

  it('hard-breaks on pauses >= 300 ms', () => {
    // Lone words closer than FRAGMENT_MAX_GAP_MS would be folded together.
    const words = [w('one', 0, 200), w('two', 1500, 1800)]
    const cues = buildCuesFromWords(words)
    expect(cues).toHaveLength(2)
  })

  it('caps cue duration at 7 s', () => {
    const words: SpeechWord[] = []
    for (let i = 0; i < 20; i++) words.push(w(`w${i}`, i * 500, i * 500 + 300))
    const cues = buildCuesFromWords(words)
    for (const cue of cues) {
      expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(MAX_CUE_DURATION_MS + 500)
      expect(cue.endMs - cue.startMs).toBeGreaterThanOrEqual(MIN_CUE_DURATION_MS)
    }
  })

  it('enforces a minimum cue duration of 200 ms', () => {
    const cues = buildCuesFromWords([w('tick', 0, 50)])
    expect(cues[0]!.endMs - cues[0]!.startMs).toBe(200)
  })

  it('merges cues closer than 80 ms apart', () => {
    const words = [w('a', 0, 600), w('b', 660, 1200)]
    const cues = buildCuesFromWords(words)
    expect(cues).toHaveLength(1)
    expect(cues[0]!.endMs).toBe(1200)
  })
})

describe('fragment folding (Spec 02 §4)', () => {
  const words = (text: string, startMs: number, stepMs = 300) =>
    text.split(' ').map((word, i) => w(word, startMs + i * stepMs, startMs + i * stepMs + 250))

  it('folds a lone word into the sentence it starts, not the one that ended', () => {
    const cues = buildCuesFromWords([
      ...words('Alle Aufnahmen sind frei.', 0),
      ...words('Weitere', 1600), // pause after the sentence, pause after the word
      ...words('Informationen gibt es hier.', 2300),
    ])
    expect(cues.map((c) => c.text.replace(/\n/g, ' '))).toEqual([
      'Alle Aufnahmen sind frei.',
      'Weitere Informationen gibt es hier.',
    ])
  })

  it('folds a trailing name back into its phrase across the shorter pause', () => {
    const cues = buildCuesFromWords([
      ...words('Die Verwandlung von Franz', 0),
      ...words('Kafka', 1550),
      ...words('Abschnitt eins.', 3500),
    ])
    expect(cues.map((c) => c.text.replace(/\n/g, ' '))).toEqual([
      'Die Verwandlung von Franz Kafka',
      'Abschnitt eins.',
    ])
  })

  it('never drops words when merged text is long', () => {
    const many = Array.from({ length: 30 }, (_, i) => w(`word${i}`, i * 100, i * 100 + 90))
    const cues = buildCuesFromWords(many, { maxCueDurationMs: 7000 })
    const text = cues.map((c) => c.text.replace(/\n/g, ' ')).join(' ')
    for (let i = 0; i < 30; i++) expect(text).toContain(`word${i}`)
  })
})

describe('wrapWords', () => {
  it('wraps into lines of at most 42 chars, max 3 lines', () => {
    const words = Array.from({ length: 12 }, (_, i) => `word${i}`) // "word0 word1 ..." each ~6-7 chars
    const lines = wrapWords(words)
    expect(lines.length).toBeLessThanOrEqual(3)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(42 + 8)
  })

  it('starts the next line with the word that overflows', () => {
    const text = 'what your country can do for you, ask what you can do for your country.'
    expect(wrapWords(text.split(' '))).toEqual([
      'what your country can do for you, ask what',
      'you can do for your country.',
    ])
  })

  it('folds words past the last line into it instead of dropping them', () => {
    expect(wrapWords(['aaaa', 'bbbb', 'cccc', 'dddd'], 4, 2)).toEqual(['aaaa', 'bbbb cccc dddd'])
  })

  it('keeps short text on one line and skips empty words', () => {
    expect(wrapWords(['Hello', '', 'world'])).toEqual(['Hello world'])
    expect(wrapWords([])).toEqual([])
  })
})

describe('normalizeCues', () => {
  it('sorts by startMs and clamps words into their cue', () => {
    const cues = normalizeCues([
      { id: 'x', startMs: 5000, endMs: 6000, text: 'B', words: [w('b', 4900, 6100)] },
      { id: 'y', startMs: 1000, endMs: 2000, text: 'A' },
    ])
    expect(cues.map((c) => c.startMs)).toEqual([1000, 5000])
    expect(cues[1]!.words![0]!.startMs).toBe(5000)
    expect(cues[1]!.words![0]!.endMs).toBe(6000)
  })
})

describe('activeCueAt', () => {
  const cues = buildCuesFromWords([w('a', 0, 1000), w('b', 2000, 3000), w('c', 4000, 5000)])

  it('returns null outside all cues', () => {
    expect(activeCueAt(cues, 6000)).toBeNull()
  })
  it('finds the active cue by playback position', () => {
    expect(activeCueAt(cues, 500)?.text).toBeDefined()
    expect(activeCueAt(cues, 2500)?.text).toBeDefined()
  })
})
