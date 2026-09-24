import { describe, expect, it } from 'vitest'
import { validateCues, validateProject } from '../src/validation'
import type { SubtitleCue, SubtitleProject } from '../src/types'

function project(overrides?: Partial<SubtitleProject>): SubtitleProject {
  return {
    id: 'p1',
    title: 'Test',
    media: { kind: 'local-file', source: 'clip.mp4' },
    tracks: [
      {
        id: 't1',
        projectId: 'p1',
        language: 'en',
        kind: 'transcript',
        cues: [{ id: 'c1', startMs: 0, endMs: 1000, text: 'hi' }],
        createdAt: 0,
      },
    ],
    settings: { style: {} as SubtitleProject['settings']['style'] },
    updatedAt: 0,
    ...overrides,
  }
}

describe('validateCues (Spec 02 §2)', () => {
  const good: SubtitleCue[] = [
    { id: 'a', startMs: 0, endMs: 1000, text: 'one' },
    { id: 'b', startMs: 1000, endMs: 2000, text: 'two' },
  ]
  it('accepts ordered, non-overlapping cues', () => {
    expect(validateCues(good).valid).toBe(true)
  })
  it('rejects overlapping cues', () => {
    const bad = [good[0]!, { ...good[1]!, startMs: 500 }]
    const r = validateCues(bad)
    expect(r.valid).toBe(false)
    expect(r.errors.join()).toMatch(/overlaps/)
  })
  it('rejects duration below 200 ms', () => {
    const bad = [{ ...good[0]!, endMs: 100 }]
    expect(validateCues(bad).valid).toBe(false)
  })
  it('rejects words outside the cue window', () => {
    const bad = [{ ...good[0]!, words: [{ word: 'x', startMs: 1500, endMs: 1600 }] }]
    expect(validateCues(bad).valid).toBe(false)
  })
})

describe('validateProject', () => {
  it('accepts a valid project and reports nested track errors', () => {
    expect(validateProject(project()).valid).toBe(true)
    const bad = project({ tracks: [] })
    bad.tracks.push({
      id: 't2',
      projectId: 'p1',
      language: 'fr',
      kind: 'translation',
      cues: [{ id: 'c', startMs: 0, endMs: 50, text: 'x' }],
      createdAt: 0,
    })
    const r = validateProject(bad)
    expect(r.valid).toBe(false)
    expect(r.errors.join()).toMatch(/duration/)
  })
})
