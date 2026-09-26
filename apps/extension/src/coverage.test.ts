import { describe, expect, it } from 'vitest'
import { isReady, READY_AHEAD_MS } from './coverage'

describe('ready to play', () => {
  const cov = [{ startMs: 60_000, endMs: 90_000 }]
  it('needs captions a few seconds past the playhead', () => {
    expect(isReady(cov, 70_000, 600_000)).toBe(true)
    expect(isReady(cov, 90_000 - READY_AHEAD_MS + 1, 600_000)).toBe(false)
    expect(isReady(cov, 50_000, 600_000)).toBe(false)
  })
  it('near the end, up to the end is enough', () => {
    expect(isReady([{ startMs: 0, endMs: 100_000 }], 99_000, 100_000)).toBe(true)
  })
})
