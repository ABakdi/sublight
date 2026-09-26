import { describe, expect, it } from 'vitest'
import { DisplayDelay } from './liveDelay'

describe('live display delay', () => {
  it('covers the latest-arriving new word of recent drafts, plus headroom', () => {
    const d = new DisplayDelay()
    d.onDraft(3000, [1000, 1500]) // 'ask' spoken at 1000, seen at 3000
    expect(d.targetMs).toBe(2250)
    d.onDraft(5000, [1000, 1500, 2000, 4200]) // new from 2000: 3 s late
    expect(d.targetMs).toBe(3250)
    d.onDraft(6000, [1000, 1500, 2000, 4200, 5000]) // 1 s, the 3 s draft still counts
    expect(d.targetMs).toBe(3250)
  })

  it('revised words and silence do not count as late', () => {
    const d = new DisplayDelay()
    d.onDraft(3000, [1000, 2000])
    d.onDraft(4000, [1000, 1990]) // the tail word re-timed, nothing new
    expect(d.targetMs).toBe(2250)
    d.onDraft(20_000, [1000, 1990, 18_500]) // speech again after a long silence
    expect(d.targetMs).toBe(2250)
  })

  it('starts at the target, then slews at most a quarter of elapsed time', () => {
    const d = new DisplayDelay()
    d.onDraft(3000, [1000])
    expect(d.tick(0, true)).toBe(2250)
    d.onDraft(6000, [1000, 2000]) // needs 4 s now
    expect(d.tick(1000, true)).toBe(2500) // +250 per second, not a jump
    expect(d.tick(2000, false)).toBe(2500) // paused: no change
    expect(d.tick(3000, true)).toBe(2750)
  })

  it('starts over after a seek', () => {
    const d = new DisplayDelay()
    d.onDraft(3000, [1000])
    d.reset()
    d.onDraft(61_000, [60_000])
    expect(d.tick(0, true)).toBe(1250)
  })
})
