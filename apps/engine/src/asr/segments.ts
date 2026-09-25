import {
  MAX_LINE_CHARS,
  MIN_CUE_DURATION_MS,
  newId,
  normalizeCues,
  wrapWords,
  type SubtitleCue,
} from '@sublight/core'
import type { Segment } from './words'

/** Split points, best first: sentence end, clause break, any space. */
const BREAKS = [/[.!?…]["')\]]?\s+/g, /[,;:—–]\s+/g, /\s+/g]

function splitText(text: string, parts: number): string[] {
  if (parts <= 1) return [text]
  const target = text.length / parts
  for (const re of BREAKS) {
    const cuts: number[] = []
    for (const m of text.matchAll(re)) cuts.push(m.index + m[0].length)
    if (cuts.length < parts - 1) continue
    const chosen: number[] = []
    for (let k = 1; k < parts; k++) {
      const ideal = target * k
      const best = cuts
        .filter((c) => c > (chosen[chosen.length - 1] ?? 0))
        .reduce(
          (a, b) => (Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a),
          Number.POSITIVE_INFINITY,
        )
      if (Number.isFinite(best)) chosen.push(best)
    }
    const out: string[] = []
    let from = 0
    for (const c of [...chosen, text.length]) {
      const piece = text.slice(from, c).trim()
      if (piece) out.push(piece)
      from = c
    }
    if (out.length > 1) return out
  }
  return [text]
}

/**
 * Segment-timed cues (Whisper `translate`, ADR-0018): no word times, so long
 * segments are split at the best punctuation into pieces timed by character
 * share, lines wrapped like word-built cues, then normalized (sorted, ≥ 200 ms,
 * no overlap).
 */
/** Segments shorter than this are merged into a neighbour when they fit. */
const SHORT_SEGMENT_MS = 1200
const MERGE_MAX_GAP_MS = 300

/** Up to two words after the last clause break at the end of a segment: "…morning, he". */
const DANGLING_RE = /^(.*[.!?…,;:]["')\]]?)\s+(\S+(?:\s+\S+)?)$/su

/**
 * Whisper often ends a segment with the first word or two of the next clause
 * ("…one morning, he" | "found himself…"). Move that fragment to the next
 * segment when it continues the sentence (starts lower-case, no real pause),
 * re-timing the boundary by character share.
 */
export function carryDanglingWords(segments: Segment[]): Segment[] {
  const out = segments.map((s) => ({ ...s }))
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i]!
    const b = out[i + 1]!
    const m = DANGLING_RE.exec(a.text)
    if (!m || b.startMs - a.endMs > MERGE_MAX_GAP_MS || !/^\p{Ll}/u.test(b.text)) continue
    const [, head, tail] = m as unknown as [string, string, string]
    const moveMs = Math.round(((a.endMs - a.startMs) * tail.length) / a.text.length)
    a.text = head
    a.endMs -= moveMs
    b.text = `${tail} ${b.text}`
    b.startMs = a.endMs
  }
  return out
}

const fitsTogether = (a: Segment, b: Segment, maxCueDurationMs: number) =>
  b.startMs - a.endMs <= MERGE_MAX_GAP_MS &&
  b.endMs - a.startMs <= maxCueDurationMs &&
  a.text.length + 1 + b.text.length <= MAX_LINE_CHARS * 2

const join = (a: Segment, b: Segment): Segment => ({
  startMs: a.startMs,
  endMs: b.endMs,
  text: `${a.text} ${b.text}`,
})

/**
 * Fold very short segments ("he") into a neighbour when the result still fits
 * one cue: forward when the previous segment ends a clause (the short one
 * starts the next thought), otherwise backward.
 */
export function mergeShortSegments(segments: Segment[], maxCueDurationMs: number): Segment[] {
  const short = (s: Segment) => s.endMs - s.startMs < SHORT_SEGMENT_MS
  const out: Segment[] = []
  for (let i = 0; i < segments.length; i++) {
    let seg = { ...segments[i]! }
    const prev = out[out.length - 1]
    const next = segments[i + 1]
    const prevClosed = prev === undefined || /[.!?…,;:]["')\]]?$/.test(prev.text)
    if (short(seg) && prevClosed && next && fitsTogether(seg, next, maxCueDurationMs)) {
      seg = join(seg, next)
      i++
    } else if (prev && (short(seg) || short(prev)) && fitsTogether(prev, seg, maxCueDurationMs)) {
      out[out.length - 1] = join(prev, seg)
      continue
    }
    out.push(seg)
  }
  return out
}

export function cuesFromSegments(segments: Segment[], maxCueDurationMs: number): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  for (const seg of mergeShortSegments(carryDanglingWords(segments), maxCueDurationMs)) {
    const parts = Math.max(1, Math.ceil((seg.endMs - seg.startMs) / maxCueDurationMs))
    const pieces = splitText(seg.text, parts)
    const total = pieces.reduce((n, p) => n + p.length, 0)
    let t = seg.startMs
    for (const piece of pieces) {
      const end = t + Math.round(((seg.endMs - seg.startMs) * piece.length) / total)
      cues.push({
        id: newId(),
        startMs: t,
        endMs: Math.max(end, t + MIN_CUE_DURATION_MS),
        text: wrapWords(piece.split(/\s+/)).join('\n'),
      })
      t = end
    }
  }
  const sorted = normalizeCues(cues)
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]!
    const next = sorted[i + 1]!
    if (cur.endMs > next.startMs) cur.endMs = Math.max(cur.startMs + 1, next.startMs)
  }
  return sorted
}
