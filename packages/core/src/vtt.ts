import { newId } from './id'
import type { SubtitleCue } from './types'

/**
 * WebVTT import (Spec 02 §3 — best-effort, M01).
 *
 * Supported: `WEBVTT` header (+ trailing metadata line), cue identifiers,
 * `hh:mm:ss.mmm` and `mm:ss.mmm` timestamps (`.` or `,` fraction), cue
 * settings after `-->` (ignored), CRLF input, HTML tags stripped.
 * Skipped: `NOTE`/`STYLE`/`REGION` blocks, empty cues. Export is M07+.
 */
const WEBVTT_HEADER_RE = /^WEBVTT(?:\s+.*)?$/
const TIMING_RE = /^(\S+)\s*-->\s*(\S+)/
const NOTE_LIKE_RE = /^(NOTE|STYLE|REGION)(?:\s|$)/

export function parseVtt(text: string): SubtitleCue[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const cues: SubtitleCue[] = []
  let i = 0
  if (i < lines.length && WEBVTT_HEADER_RE.test(lines[i]!.trim())) i++

  while (i < lines.length) {
    const line = lines[i]!.trim()
    if (!line) {
      i++
      continue
    }
    // NOTE / STYLE / REGION blocks run until the next blank line.
    if (NOTE_LIKE_RE.test(line)) {
      while (i < lines.length && lines[i]!.trim() !== '') i++
      continue
    }
    const tc = TIMING_RE.exec(line)
    if (tc) {
      const startMs = parseVttTimecode(tc[1]!)
      const endMs = parseVttTimecode(tc[2]!)
      i++
      const textLines: string[] = []
      while (i < lines.length && lines[i]!.trim() !== '' && !TIMING_RE.test(lines[i]!.trim())) {
        textLines.push(lines[i]!.trim())
        i++
      }
      const text = textLines.join('\n').replace(/<[^>]+>/g, '')
      if (text) cues.push({ id: newId(), startMs, endMs, text })
      continue
    }
    // Cue identifier (non-timing) line — the next line carries the timing.
    i++
  }
  return cues
}

/** `hh:mm:ss.mmm` or `mm:ss.mmm` (`.`/`,` fraction, 1+ digits each part). */
export function parseVttTimecode(text: string): number {
  const m = /^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?[.,](\d{1,3})$/.exec(text.trim())
  if (!m) throw new Error(`invalid VTT timestamp: ${JSON.stringify(text)}`)
  const h = m[3] !== undefined ? Number(m[1]) : 0
  const min = Number(m[3] !== undefined ? m[2] : m[1])
  const s = Number(m[3] !== undefined ? m[3] : m[2])
  const frac = Number(m[4]!.padEnd(3, '0'))
  return (h * 3600 + min * 60 + s) * 1000 + frac
}

/** Cheap classifier for import buttons: `srt` | `vtt` | `unknown`. */
export function detectSubtitleFormat(text: string): 'srt' | 'vtt' | 'unknown' {
  const head = text.slice(0, 2048)
  const firstLine = head.trimStart().split('\n')[0] ?? ''
  if (WEBVTT_HEADER_RE.test(firstLine)) return 'vtt'
  if (/^\d{1,3}:\d{2}:\d{2}[,.]\d{3}\s*-->/m.test(head)) return 'srt'
  return 'unknown'
}
