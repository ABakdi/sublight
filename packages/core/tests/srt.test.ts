import { describe, expect, it } from 'vitest'
import { formatSrtTime, parseSrt, serializeSrt } from '../src/srt'
import type { SubtitleCue } from '../src/types'

describe('SRT', () => {
  const cues: SubtitleCue[] = [
    { id: 'a', startMs: 0, endMs: 1250, text: 'Hello world' },
    { id: 'b', startMs: 1250, endMs: 2500, text: 'Second line' },
  ]

  it('formats time as HH:MM:SS,mmm', () => {
    expect(formatSrtTime(1_234_567)).toBe('00:20:34,567')
    expect(formatSrtTime(0)).toBe('00:00:00,000')
    expect(formatSrtTime(3_600_234)).toBe('01:00:00,234')
  })

  it('serializes with --> spacing, blank lines, and a final newline', () => {
    const out = serializeSrt(cues)
    expect(out.split('\n\n')).toHaveLength(2)
    expect(out.endsWith('\n')).toBe(true)
    expect(out).toContain('1\n00:00:00,000 --> 00:00:01,250\nHello world')
    expect(out).toContain('2\n00:00:01,250 --> 00:00:02,500\nSecond line')
  })

  it('round-trips through parse', () => {
    const parsed = parseSrt(serializeSrt(cues))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]!.startMs).toBe(0)
    expect(parsed[0]!.endMs).toBe(1250)
    expect(parsed[0]!.text).toBe('Hello world')
    expect(parsed[1]!.text).toBe('Second line')
  })

  it('rounds fractional milliseconds', () => {
    expect(formatSrtTime(999.6)).toBe('00:00:01,000') // Math.round
  })

  it('tolerates CRLF and strips HTML tags on import', () => {
    const raw =
      '1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>Italic</i> text\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nplain\r\n'
    const parsed = parseSrt(raw)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]!.text).toBe('Italic text')
    expect(parsed[1]!.text).toBe('plain')
  })

  it('keeps text plain on export (no re-added tags)', () => {
    const out = serializeSrt(parseSrt('1\n00:00:01,000 --> 00:00:02,000\n<i>x</i>\n'))
    expect(out).not.toContain('<i>')
  })
})
