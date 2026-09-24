import { describe, expect, it } from 'vitest'
import { DEFAULT_SUBTITLE_STYLE, shiftCues, validateStyle } from '../src/index'
import type { SubtitleCue, SubtitleStyle } from '../src/types'

describe('validateStyle (Spec 02 §6)', () => {
  it('accepts the default style', () => {
    expect(validateStyle(DEFAULT_SUBTITLE_STYLE).valid).toBe(true)
  })

  it('rejects invalid colors, ranges and enum values', () => {
    // Deliberately invalid runtime values — the validator must catch them even
    // though the TS types reject them (that cast is the point of the test).
    const r = validateStyle({
      ...DEFAULT_SUBTITLE_STYLE,
      color: 'white', // not #RRGGBB
      bgOpacity: 2,
      opacity: -1,
      maxLines: 9,
      align: 'middle',
      casing: 'shouty',
      position: { anchor: 'center-ish', marginPx: -4 },
    } as unknown as SubtitleStyle)
    expect(r.valid).toBe(false)
    const joined = r.errors.join('\n')
    expect(joined).toContain('style.color')
    expect(joined).toContain('style.bgOpacity')
    expect(joined).toContain('style.opacity')
    expect(joined).toContain('style.maxLines')
    expect(joined).toContain('style.align')
    expect(joined).toContain('style.casing')
    expect(joined).toContain('style.position.anchor')
    expect(joined).toContain('style.position.marginPx')
  })

  it('accepts all eight anchors', () => {
    for (const anchor of [
      'bottom',
      'top',
      'left',
      'right',
      'bottom-left',
      'bottom-right',
      'top-left',
      'top-right',
    ] as const) {
      expect(
        validateStyle({ ...DEFAULT_SUBTITLE_STYLE, position: { anchor, marginPx: 10 } }).valid,
      ).toBe(true)
    }
  })
})

describe('shiftCues (syncOffsetMs)', () => {
  const cues: SubtitleCue[] = [
    {
      id: 'a',
      startMs: 1000,
      endMs: 2000,
      text: 'one',
      words: [{ word: 'one', startMs: 1100, endMs: 1600 }],
    },
    { id: 'b', startMs: 2500, endMs: 3000, text: 'two' },
  ]

  it('shifts cues and words without mutating the input', () => {
    const shifted = shiftCues(cues, 250)
    expect(shifted[0]!.startMs).toBe(1250)
    expect(shifted[0]!.endMs).toBe(2250)
    expect(shifted[0]!.words![0]!.startMs).toBe(1350)
    expect(shifted[1]!.startMs).toBe(2750)
    // input untouched
    expect(cues[0]!.startMs).toBe(1000)
    expect(cues[0]!.words![0]!.startMs).toBe(1100)
  })

  it('clamps at 0 ms for negative offsets', () => {
    const shifted = shiftCues(cues, -2000)
    expect(shifted[0]!.startMs).toBe(0)
    expect(shifted[0]!.words![0]!.endMs).toBe(0)
  })

  it('returns a new array (callers may cache)', () => {
    expect(shiftCues(cues, 0)).not.toBe(cues)
  })
})
