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

  // Fold fragments into a neighbour, then keep each cue up long enough to read.
  // (Cues used to be merged when < 80 ms apart, but continuous speech always
  // is, so that undid the length split and produced 8-10 s cues.)
  return holdForReading(foldFragments(cues, maxCue, maxChars))
}

/** A cue stays up at least this long… */
export const MIN_DISPLAY_MS = 1000
/** …and this long per character (≈ 20 characters per second)… */
export const READ_MS_PER_CHAR = 50
/** …and lingers this long after its last word, when the next cue allows. */
export const LINGER_MS = 500

/**
 * Readability (Spec 02 §4): extend each cue's end so it's on screen long
 * enough to read — max(1 s, 50 ms × characters), plus 0.5 s after the last
 * word — but never past the next cue's start. Gaps shorter than
 * MERGE_GAP_MS close, so captions don't flicker between cues. Word timings
 * are untouched: word-by-word display still follows the speech exactly.
 */
export function holdForReading(cues: SubtitleCue[]): SubtitleCue[] {
  return cues.map((cue, i) => {
    const next = cues[i + 1]
    const chars = cue.text.replace(/\n/g, ' ').length
    const need = Math.max(MIN_DISPLAY_MS, chars * READ_MS_PER_CHAR)
    let end = Math.max(cue.endMs + LINGER_MS, cue.startMs + need)
    if (next) {
      end = Math.min(end, next.startMs)
      if (next.startMs - end < MERGE_GAP_MS) end = next.startMs
    }
    return { ...cue, endMs: Math.max(cue.endMs, end) }
  })
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

/**
 * Word-by-word display: expand each cue into steps whose text grows one word
 * at a time, each step starting when its word is spoken, the last lasting to
 * the cue's (reading-hold) end. The overlay needs no special mode: it just
 * shows the active step. Cues without word timings pass through unchanged.
 */
export function revealByWords(cues: SubtitleCue[], maxChars = MAX_LINE_CHARS): SubtitleCue[] {
  const out: SubtitleCue[] = []
  for (const cue of cues) {
    const words = cue.words ?? []
    if (words.length < 2) {
      out.push(cue)
      continue
    }
    for (let i = 0; i < words.length; i++) {
      const start = i === 0 ? cue.startMs : Math.max(cue.startMs, words[i]!.startMs)
      const end = i === words.length - 1 ? cue.endMs : Math.max(start + 1, words[i + 1]!.startMs)
      if (end <= start) continue
      out.push({
        id: `${cue.id}#${i}`,
        startMs: start,
        endMs: end,
        text: wrapWords(
          words.slice(0, i + 1).map((w) => w.word),
          maxChars,
        ).join('\n'),
        ...(cue.speaker ? { speaker: cue.speaker } : {}),
      })
    }
  }
  return out
}

/** How captions are cut: growing word by word, or one full sentence at a time. */
export type CaptionMode = 'words' | 'sentences'

/** A pause this long ends a sentence even without punctuation. */
export const SENTENCE_GAP_MS = 1500
/** Where a long sentence would rather be split. */
const CLAUSE_END_RE = /[,;:–—]$/u

function textLength(words: SpeechWord[]): number {
  return words.reduce((n, w) => n + w.word.length, 0) + Math.max(0, words.length - 1)
}

/** Split a sentence until every part fits: at the clause break nearest the middle, else the middle. */
function splitSentence(words: SpeechWord[], maxChars: number, maxCue: number): SpeechWord[][] {
  const span = words[words.length - 1]!.endMs - words[0]!.startMs
  if (words.length < 2 || (textLength(words) <= maxChars && span <= maxCue)) return [words]
  const half = textLength(words) / 2
  let best = -1
  let bestScore = Infinity
  let chars = 0
  for (let i = 0; i < words.length - 1; i++) {
    chars += words[i]!.word.length + 1
    // Clause breaks win unless much further from the middle.
    const score = Math.abs(chars - half) - (CLAUSE_END_RE.test(words[i]!.word) ? half / 2 : 0)
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  return [
    ...splitSentence(words.slice(0, best + 1), maxChars, maxCue),
    ...splitSentence(words.slice(best + 1), maxChars, maxCue),
  ]
}

/**
 * One cue per sentence (split at punctuation or a pause of 1.5 s), at most two
 * lines and 7 s; longer sentences split at a clause break near the middle.
 * Cues keep their words, then get the reading hold.
 */
export function cuesBySentence(
  words: SpeechWord[],
  opts?: { maxCueDurationMs?: number; maxLineChars?: number },
): SubtitleCue[] {
  const maxCue = opts?.maxCueDurationMs ?? MAX_CUE_DURATION_MS
  const maxLine = opts?.maxLineChars ?? MAX_LINE_CHARS
  const sentences: SpeechWord[][] = []
  let current: SpeechWord[] = []
  for (const w of words) {
    const prev = current[current.length - 1]
    if (prev && (SENTENCE_END_RE.test(prev.word) || w.startMs - prev.endMs >= SENTENCE_GAP_MS)) {
      sentences.push(current)
      current = []
    }
    current.push(w)
  }
  if (current.length) sentences.push(current)
  const cues: SubtitleCue[] = []
  for (const sentence of sentences) {
    for (const part of splitSentence(sentence, maxLine * 2, maxCue)) {
      const first = part[0]!
      const last = part[part.length - 1]!
      cues.push({
        id: newId(),
        startMs: first.startMs,
        endMs: Math.max(last.endMs, first.startMs + MIN_CUE_DURATION_MS),
        text: wrapWords(
          part.map((w) => w.word),
          maxLine,
          2,
        ).join('\n'),
        words: part.map((w) => ({ ...w })),
      })
    }
  }
  return holdForReading(cues)
}

/**
 * The cues to show or export for a mode. Needs word timings on every cue
 * (transcripts); tracks without them (Whisper translate, imported SRT) are
 * returned as they are.
 */
export function cuesForMode(cues: SubtitleCue[], mode: CaptionMode): SubtitleCue[] {
  if (cues.length === 0 || !cues.every((c) => c.words?.length)) return cues
  return mode === 'sentences' ? cuesBySentence(cues.flatMap((c) => c.words!)) : revealByWords(cues)
}
