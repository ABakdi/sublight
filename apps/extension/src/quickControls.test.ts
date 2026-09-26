import { describe, expect, it } from 'vitest'
import { clampDelay, MAX_DELAY_MS, nearestCorner } from './quickControls'

describe('quick controls', () => {
  it('snaps to the nearest corner of the video', () => {
    expect(nearestCorner(10, 10, 400, 700)).toBe('top-left')
    expect(nearestCorner(390, 10, 400, 700)).toBe('top-right')
    expect(nearestCorner(10, 690, 400, 700)).toBe('bottom-left')
    expect(nearestCorner(300, 600, 400, 700)).toBe('bottom-right')
  })
  it('keeps the delay a whole number of ms within ±30 s', () => {
    expect(clampDelay(149.6)).toBe(150)
    expect(clampDelay(-99_999)).toBe(-MAX_DELAY_MS)
    expect(clampDelay(Number.NaN)).toBe(0)
  })
})
