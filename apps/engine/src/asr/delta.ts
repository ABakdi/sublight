import type { SpeechWord } from '@sublight/core'

/** A word counts as "after a pause" when the gap before it is at least this. */
export const PAUSE_BEFORE_MS = 150
/** Only pair an onset with a word starting this close to it. */
export const MATCH_WINDOW_MS = 150
/** δ is only trusted with this many independent matches… */
export const MIN_MATCHES = 8
/** …that agree: interquartile range of the differences at most this. */
export const MAX_SPREAD_MS = 150
/** |δ| beyond this means the estimate, not the transcript, is wrong. */
export const MAX_DELTA_MS = 400

export interface DeltaEstimate {
  deltaMs: number
  matches: number
  /** Interquartile range of onset − wordStart, ms (null with < 4 matches). */
  spreadMs: number | null
}

/**
 * δ auto-estimation (Spec 07 §1.4a): pair energy onsets with words that
 * start after a pause and take the median of `onset − wordStart`, rounded to
 * 10 ms. Conservative on purpose: whisper's per-word timing jitters by
 * ±100-250 ms around energy onsets (measured on 10 min of speech), so δ is
 * only applied when enough close matches agree (≥ 8 within ±150 ms, IQR
 * ≤ 150 ms); otherwise 0. A wrong global shift is worse than none.
 * Positive δ = captions should appear later.
 */
export function estimateDelta(words: SpeechWord[], onsetsMs: number[]): DeltaEstimate {
  const afterPause = words.filter(
    (w, i) => i === 0 || w.startMs - words[i - 1]!.endMs >= PAUSE_BEFORE_MS,
  )
  const diffs: number[] = []
  for (const onset of onsetsMs) {
    let best: number | null = null
    for (const w of afterPause) {
      const d = onset - w.startMs
      if (Math.abs(d) <= MATCH_WINDOW_MS && (best === null || Math.abs(d) < Math.abs(best)))
        best = d
    }
    if (best !== null) diffs.push(best)
  }
  diffs.sort((a, b) => a - b)
  const at = (q: number) => diffs[Math.min(diffs.length - 1, Math.floor(q * diffs.length))]!
  const spreadMs = diffs.length >= 4 ? at(0.75) - at(0.25) : null
  if (diffs.length < MIN_MATCHES || spreadMs === null || spreadMs > MAX_SPREAD_MS) {
    return { deltaMs: 0, matches: diffs.length, spreadMs }
  }
  const mid = diffs.length >> 1
  const median = diffs.length % 2 ? diffs[mid]! : (diffs[mid - 1]! + diffs[mid]!) / 2
  const deltaMs = Math.round(median / 10) * 10
  return {
    deltaMs: Math.abs(deltaMs) > MAX_DELTA_MS ? 0 : deltaMs,
    matches: diffs.length,
    spreadMs,
  }
}
