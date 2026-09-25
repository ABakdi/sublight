import { newId } from './id'
import type { SpeechWord, SubtitleCue } from './types'

export const MIN_CUE_DURATION_MS = 200
export const MAX_CUE_DURATION_MS = 7000
export const MAX_LINE_CHARS = 42
export const MAX_LINES = 3
/** Hard break after sentence-final punctuation. */
export const SENTENCE_END_RE = /[.!?…]+$/u
/** Merge cues whose gap is under this (Spec 02 §4). */
export const MERGE_GAP_MS = 80
/** Break on inter-word pauses at or above this. */
export const PAUSE_BREAK_MS = 300

/**
 * Greedy wrap into lines of <= `maxChars`: a word that doesn't fit starts the
 * next line. Past `maxLines`, the remaining words fold into the last line
 * (overflow is accepted rather than dropping speech).
 */
export function wrapWords(
  words: string[],
  maxChars = MAX_LINE_CHARS,
  maxLines = MAX_LINES,
): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!word) continue
    if (!current) current = word
    else if (current.length + 1 + word.length <= maxChars || lines.length === maxLines - 1) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

/**
 * Group words into cues (Spec 02 §4, ASR side):
 * - greedy grouping toward 2-3 lines of <= 42 chars, or <= 7 s max cue;
 * - hard break at sentence-final punctuation and pauses >= 300 ms;
 * - cues closer than 80 ms merge;
 * - minimum duration 200 ms enforced by stretching the end.
 */
export function buildCuesFromWords(
  words: SpeechWord[],
  opts?: { maxCueDurationMs?: number; maxLineChars?: number },
): SubtitleCue[] {
  const maxCue = opts?.maxCueDurationMs ?? MAX_CUE_DURATION_MS
  const maxChars = opts?.maxLineChars ?? MAX_LINE_CHARS
  if (words.length === 0) return []

  const cues: SubtitleCue[] = []
  let bucket: SpeechWord[] = []

  const flush = () => {
    if (!bucket.length) return
    const text = wrapWords(
      bucket.map((w) => w.word),
      maxChars,
    ).join('\n')
    const first = bucket[0]!
    const last = bucket[bucket.length - 1]!
    let endMs = last.endMs
    if (endMs - first.startMs < MIN_CUE_DURATION_MS) endMs = first.startMs + MIN_CUE_DURATION_MS
    cues.push({
      id: newId(),
      startMs: first.startMs,
      endMs,
      text,
      words: bucket.map((w) => ({ ...w })),
    })
    bucket = []
  }

  for (const word of words) {
    if (bucket.length) {
      const prev = bucket[bucket.length - 1]!
      const span = word.endMs - bucket[0]!.startMs
      const hitHardBreak =
        SENTENCE_END_RE.test(prev.word) || word.startMs - prev.endMs >= PAUSE_BREAK_MS
      const hitLimits =
        span > maxCue || wordTextLength(bucket) + word.word.length + 1 > maxChars * MAX_LINES
      if (hitHardBreak || hitLimits) flush()
    }
    bucket.push(word)
  }
  flush()

  // Merge cues closer than MERGE_GAP_MS, then fold fragments into a neighbour.
  const merged: SubtitleCue[] = []
  for (const cue of cues) {
    const prev = merged[merged.length - 1]
    if (prev && prev.endMs + MERGE_GAP_MS >= cue.startMs) joinInto(prev, cue, maxChars)
    else merged.push({ ...cue, words: [...(cue.words ?? [])] })
  }
  return foldFragments(merged, maxCue, maxChars)
}

/** Append `next` to `into`; the text is re-wrapped from the words, never truncated. */
function joinInto(into: SubtitleCue, next: SubtitleCue, maxChars: number): void {
  into.endMs = Math.max(into.endMs, next.endMs)
  into.words = [...(into.words ?? []), ...(next.words ?? [])]
  into.text = into.words.length
    ? wrapWords(
        into.words.map((w) => w.word),
        maxChars,
      ).join('\n')
    : `${into.text}\n${next.text}`
}

/** A cue this short reads as a flash: fold it into a neighbour when possible. */
export const FRAGMENT_MAX_WORDS = 2
export const FRAGMENT_MAX_MS = 800
/** Only fold across pauses shorter than this. */
export const FRAGMENT_MAX_GAP_MS = 1000

function isFragment(cue: SubtitleCue): boolean {
  return (
    (cue.words?.length ?? cue.text.split(/\s+/).length) <= FRAGMENT_MAX_WORDS ||
    cue.endMs - cue.startMs < FRAGMENT_MAX_MS
  )
}

/**
 * Fold fragment cues ("Weitere", "Kafka") into the neighbour they belong to
 * (Spec 02 §4): the one across the shorter pause, never across a sentence
 * end, and only when the result still fits one cue.
 * Pauses in read speech otherwise leave one-word flashes on screen and
 * break line-by-line translation.
 */
function foldFragments(cues: SubtitleCue[], maxCue: number, maxChars: number): SubtitleCue[] {
  const out = cues.map((c) => ({ ...c, words: [...(c.words ?? [])] }))
  const fits = (a: SubtitleCue, b: SubtitleCue) =>
    b.startMs - a.endMs <= FRAGMENT_MAX_GAP_MS &&
    b.endMs - a.startMs <= maxCue &&
    a.text.replace(/\n/g, ' ').length + 1 + b.text.replace(/\n/g, ' ').length <=
      maxChars * MAX_LINES
  const endsSentence = (c: SubtitleCue) => SENTENCE_END_RE.test(c.text.trimEnd())
  for (let i = 0; i < out.length; i++) {
    const cue = out[i]!
    if (!isFragment(cue)) continue
    const prev = out[i - 1]
    const next = out[i + 1]
    // Never across a sentence end; otherwise the shorter pause wins.
    const back =
      prev && !endsSentence(prev) && fits(prev, cue) ? cue.startMs - prev.endMs : Infinity
    const fwd = next && !endsSentence(cue) && fits(cue, next) ? next.startMs - cue.endMs : Infinity
    if (back === Infinity && fwd === Infinity) continue
    if (back <= fwd) {
      joinInto(prev!, cue, maxChars)
      out.splice(i, 1)
    } else {
      joinInto(cue, next!, maxChars)
      out.splice(i + 1, 1)
    }
    i = Math.max(-1, i - 2) // the merged cue may itself still be a fragment
  }
  return out
}

function wordTextLength(words: SpeechWord[]): number {
  return words.reduce((n, w) => n + w.word.length + 1, -1)
}

/**
 * Normalize cues after construction/edits (Spec 02 §4, editor side):
 * sort by startMs, clamp words into their cue, enforce min duration.
 */
export function normalizeCues(cues: SubtitleCue[]): SubtitleCue[] {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  for (const cue of sorted) {
    if (cue.words) {
      cue.words = cue.words.map((w) => ({
        ...w,
        startMs: Math.max(w.startMs, cue.startMs),
        endMs: Math.min(w.endMs, cue.endMs),
      }))
    }
    if (cue.endMs - cue.startMs < MIN_CUE_DURATION_MS) cue.endMs = cue.startMs + MIN_CUE_DURATION_MS
  }
  return sorted
}

/**
 * Shift every cue (and its words) by a whole-track offset (manual nudge /
 * engine δ, Spec 02 §1 `syncOffsetMs`). Pure — never mutates input; times
 * clamp at 0 so early cues can't go negative.
 */
export function shiftCues(cues: SubtitleCue[], deltaMs: number): SubtitleCue[] {
  const shift = (t: number) => Math.max(0, t + deltaMs)
  return cues.map((cue) => ({
    ...cue,
    startMs: shift(cue.startMs),
    endMs: shift(cue.endMs),
    ...(cue.words
      ? {
          words: cue.words.map((w) => ({
            ...w,
            startMs: shift(w.startMs),
            endMs: shift(w.endMs),
          })),
        }
      : {}),
  }))
}

/** Fast check of which cue is active at a playback position. */
export function activeCueAt(cues: SubtitleCue[], currentMs: number): SubtitleCue | null {
  // Cues are ordered; binary search for the last cue starting at/before currentMs.
  let lo = 0
  let hi = cues.length - 1
  let found: SubtitleCue | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const cue = cues[mid]!
    if (cue.startMs <= currentMs) {
      found = cue
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found && currentMs < found.endMs ? found : null
}
