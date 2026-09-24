import { describe, expect, it } from 'vitest'
import { detectSubtitleFormat, parseVtt, parseVttTimecode } from '../src/vtt'

describe('VTT import (Spec 02 §3)', () => {
  it('parses a minimal WEBVTT document', () => {
    const raw = `WEBVTT

00:00:01.000 --> 00:00:02.250
Hello there

00:00:03.000 --> 00:00:04.000
Second cue
`
    const cues = parseVtt(raw)
    expect(cues).toHaveLength(2)
    expect(cues[0]!.startMs).toBe(1000)
    expect(cues[0]!.endMs).toBe(2250)
    expect(cues[0]!.text).toBe('Hello there')
    expect(cues[1]!.text).toBe('Second cue')
  })

  it('skips cue identifiers and captures multi-line text', () => {
    const raw = `WEBVTT

1
00:00:00.500 --> 00:00:02.000
First line
Second line

2
00:00:02.500 --> 00:00:03.000
Last
`
    const cues = parseVtt(raw)
    expect(cues).toHaveLength(2)
    expect(cues[0]!.startMs).toBe(500)
    expect(cues[0]!.text).toBe('First line\nSecond line')
  })

  it('supports mm:ss.mmm timestamps and comma fractions', () => {
    expect(parseVttTimecode('12:34,567')).toBe(754_567)
    expect(parseVttTimecode('1:02.030')).toBe(62_030)
    expect(parseVttTimecode('00:00:59,999')).toBe(59_999)
    const cues = parseVtt(`WEBVTT

01:30.000 --> 01:32.000
Late
`)
    expect(cues[0]!.startMs).toBe(90_000)
  })

  it('skips NOTE/STYLE blocks and ignores cue settings', () => {
    const raw = `WEBVTT - note about nothing
NOTE this is a
multi line comment

STYLE
::cue { color: #fff }

00:00:00.100 --> 00:00:01.000 align:start position:10%
Real cue
`
    const cues = parseVtt(raw)
    expect(cues).toHaveLength(1)
    expect(cues[0]!.text).toBe('Real cue')
  })

  it('strips inline HTML tags like SRT import', () => {
    const cues = parseVtt(`WEBVTT

00:00:00.000 --> 00:00:01.000
<v Bob><i>Fancy</i> text</v>
`)
    expect(cues[0]!.text).toBe('Fancy text')
  })

  it('tolerates CRLF and drops empty cues', () => {
    const raw =
      'WEBVTT\r\n\r\n00:00:00.000 --> 00:00:00.999\r\n\r\n00:00:02.000 --> 00:00:03.000\r\nKept\r\n'
    const cues = parseVtt(raw)
    expect(cues).toHaveLength(1)
    expect(cues[0]!.text).toBe('Kept')
  })

  it('returns [] for a document without timed cues', () => {
    expect(parseVtt('WEBVTT\n\nall quiet')).toEqual([])
  })
})

describe('detectSubtitleFormat', () => {
  it('detects VTT by its header', () => {
    expect(detectSubtitleFormat('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi')).toBe('vtt')
  })

  it('detects SRT by its hh:mm:ss,mmm timing line', () => {
    expect(detectSubtitleFormat('1\n00:00:01,000 --> 00:00:02,000\nHi')).toBe('srt')
  })

  it('returns unknown for garbage', () => {
    expect(detectSubtitleFormat('not a subtitle file')).toBe('unknown')
  })
})
