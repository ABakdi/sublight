import { newId } from './id'
import type { SubtitleCue } from './types'

/**
 * SRT format (Spec 02 §3):
 * - `HH:MM:SS,mmm` timestamps, ` --> ` spacing;
 * - blank line between cues; final newline present; no trailing blank line;
 * - import is CRLF-tolerant and HTML tags are stripped; times are rounded via
 *   `Math.round` to whole ms.
 *
 * The writer emits plain text: subtitles we generate are plain; user-imported
 * markup is preserved as-is on import (tags stripped), not re-added.
 */

export function formatSrtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const milli = total % 1000
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`
}

const SRT_TIME_RE = /^(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/
const TIMECODE_RE =
  /^(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/

export function parseSrtTime(text: string): number {
  const m = SRT_TIME_RE.exec(text)
  if (!m) throw new Error(`invalid SRT time: ${text}`)
  const h = Number(m[1])
  const min = Number(m[2])
  const s = Number(m[3])
  const frac = Number(m[4]!.padEnd(3, '0'))
  return (h * 3600 + min * 60 + s) * 1000 + frac
}

/** Parse SRT text into cues. CRLF-tolerant; strips HTML tags. */
export function parseSrt(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) continue
    const tc = lines.find((l) => TIMECODE_RE.test(l))
    if (!tc) continue // library/header blocks have no timing -> skip
    const tm = TIMECODE_RE.exec(tc)!
    const startMs = toMs(tm, 1)
    const endMs = toMs(tm, 5)
    const textLines = lines.slice(lines.indexOf(tc) + 1)
    if (textLines.length === 0) continue
    const text = textLines.map((l) => l.replace(/<[^>]+>/g, '')).join('\n')
    cues.push({ id: newId(), startMs, endMs, text })
  }
  return cues
}

function toMs(m: RegExpExecArray, offset: number): number {
  const h = Number(m[offset])
  const min = Number(m[offset + 1])
  const s = Number(m[offset + 2])
  const frac = Number(m[offset + 3]!.padEnd(3, '0'))
  return (h * 3600 + min * 60 + s) * 1000 + frac
}

/** Serialize cues to SRT. */
export function serializeSrt(cues: SubtitleCue[]): string {
  return (
    cues
      .map((cue, i) => {
        const plain = cue.text.replace(/<[^>]+>/g, '')
        return `${i + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${plain}`
      })
      .join('\n\n') + '\n'
  )
}
